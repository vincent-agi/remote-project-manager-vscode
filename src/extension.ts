import * as vscode from "vscode";
import { Octokit } from "@octokit/rest";
import { Gitlab } from "@gitbeaker/rest";
import { ensureToken, type ICredentialStore } from "./core/auth/ensure-token";
import { isAuthError } from "./core/auth/is-auth-error";
import type { IIssue, ProviderKind } from "./core/models/issue.model";
import type {
  IAuthenticatedUser,
  IProjectProvider,
} from "./core/providers/project-provider.interface";
import { GithubProvider, type GithubClient } from "./providers/github/github.provider";
import { GitlabProvider, type GitlabClient } from "./providers/gitlab/gitlab.provider";
import { CachingProjectProvider } from "./providers/caching-project-provider";
import { SimpleGitService } from "./providers/git/simple-git.service";
import {
  chooseRepository,
  repositoryKey,
  resolveRepositoryCandidates,
  type RepositoryCandidate,
  type RepositoryResolution,
} from "./core/workspace/repository-resolver";
import { generateBranchName } from "./core/automation/branch-name";
import { shouldAutoCreateBranch } from "./core/automation/auto-branch-guard";
import { selectMyOpenIssues, type MyIssueSummary } from "./core/tree/my-issues";
import { BranchManager } from "./core/git/branch-manager";
import type { DirtyTreeDecision } from "./core/git/branch-manager.interface";
import { pickDefaultBaseBranch } from "./core/git/pick-default-base-branch";
import { PanelController } from "./webview/panel-controller";
import type { InboundMessage, RepositoryOptionView } from "./webview/messages";
import { getWebviewHtml } from "./webview/webview-html";
import { extractIssueNumberFromBranch } from "./core/git/branch-issue-ref";
import {
  buildCommitMessage,
  COMMIT_TYPES,
  type CommitType,
  type IssueReferenceKind,
} from "./core/git/commit-message";
import { parseGitmojis, type Gitmoji } from "./core/git/gitmoji";
import { groupCommitsByIssue } from "./core/git/graph";
import { lintCommits } from "./core/git/lint-commits";
import { buildPrBody, buildPrTitle, type CommitRef } from "./core/git/pr-body";
import { formatIssueContext } from "./core/ai/issue-context";
import { formatMilestoneContext } from "./core/ai/milestone-context";
import { replaceManagedSection } from "./core/ai/managed-section";
import { resolveSafeRelativeSegments } from "./core/workspace/safe-relative-path";
import type { IMilestone } from "./core/models/milestone.model";

function secretKeyFor(provider: ProviderKind): string {
  return `remoteProjectManager.token.${provider}`;
}

function makeCredentialStore(secrets: vscode.SecretStorage): ICredentialStore {
  return {
    async getToken(provider) {
      return secrets.get(secretKeyFor(provider));
    },
    async setToken(provider, token) {
      await secrets.store(secretKeyFor(provider), token);
    },
  };
}

async function promptForToken(provider: ProviderKind): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `${provider === "github" ? "GitHub" : "GitLab"} Personal Access Token`,
    prompt: `Enter a ${provider} personal access token with repo/issue read-write scope.`,
    password: true,
    ignoreFocusOut: true,
  });
}

/**
 * Gets a GitHub access token via VS Code's built-in GitHub authentication
 * provider. This never touches our SecretStorage: the session is owned
 * and persisted by VS Code itself. See ADR-0003.
 */
async function getGithubToken(): Promise<string> {
  const session = await vscode.authentication.getSession("github", ["repo"], {
    createIfNone: true,
  });
  return session.accessToken;
}

async function resolveToken(
  providerKind: ProviderKind,
  credentialStore: ICredentialStore,
): Promise<string> {
  if (providerKind === "github") {
    return getGithubToken();
  }
  return ensureToken(credentialStore, providerKind, promptForToken);
}

/**
 * Builds the provider for the configured platform. Octokit's and
 * gitbeaker's real client types are wider than the narrow ports the
 * providers depend on (see ADR-0001); the casts here are the single
 * place that bridges the two, kept out of the testable provider classes.
 */
function buildProvider(
  providerKind: ProviderKind,
  repository: string,
  token: string,
  gitlabHost?: string,
): IProjectProvider {
  const [owner, repo] = repository.split("/");
  if (providerKind === "github") {
    const octokit = new Octokit({ auth: token });
    return new GithubProvider(octokit.rest as unknown as GithubClient, owner, repo);
  }
  const gitlab = new Gitlab(gitlabHost ? { token, host: `https://${gitlabHost}` } : { token });
  return new GitlabProvider(gitlab as unknown as GitlabClient, repository);
}

function createPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "remoteProjectManager",
    "Remote Project Manager",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview-ui"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
      ],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
  return panel;
}

/**
 * Resolves which repository to connect to: every workspace folder's
 * `origin` remote is inspected first (see ADR-0003 and ADR-0007), and the
 * `remoteProjectManager.repository` setting is only a fallback when none
 * is recognized — so the issues shown always match the loaded code.
 * Returns a single resolved repository, or a list of candidates for the
 * webview picker when more than one workspace folder matches.
 */
async function resolveRepository(): Promise<RepositoryResolution> {
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const providerKindSetting = config.get<ProviderKind>("provider", "github");
  const repositorySetting = config.get<string>("repository", "");
  const gitlabHost = config.get<string>("gitlabHost", "") || undefined;

  const gitService = new SimpleGitService();
  const folders = vscode.workspace.workspaceFolders ?? [];
  const remotes = await Promise.all(
    folders.map(async (folder) => ({
      folderPath: folder.uri.fsPath,
      folderName: folder.name,
      remoteUrl: await gitService.getRemoteUrl(folder.uri.fsPath),
    })),
  );
  return chooseRepository(resolveRepositoryCandidates(remotes, gitlabHost), {
    provider: providerKindSetting,
    repository: repositorySetting,
    fallbackFolderPath: folders[0]?.uri.fsPath,
  });
}

function toRepositoryOptionView(candidate: RepositoryCandidate): RepositoryOptionView {
  return {
    id: candidate.folderPath,
    label: `${candidate.folderName} — ${candidate.provider}:${candidate.repository}`,
    provider: candidate.provider,
    repository: candidate.repository,
  };
}

/** Asks the user how to proceed given a dirty working tree, via a modal. */
async function promptDirtyWorkingTree(issueNumber: number): Promise<DirtyTreeDecision> {
  const stashChoice = "Stash & Continue";
  const forceChoice = "Force Switch";
  const cancelChoice = "Cancel";
  const choice = await vscode.window.showWarningMessage(
    `Your working tree has uncommitted changes. Creating a branch for issue #${issueNumber} will switch branches.`,
    { modal: true },
    stashChoice,
    forceChoice,
    cancelChoice,
  );
  if (choice === stashChoice) {
    return "stash";
  }
  if (choice === forceChoice) {
    return "force";
  }
  return "cancel";
}

/**
 * Reports a BranchManager outcome to the user. "cancelled" is
 * deliberately silent: the user just declined via the dirty-tree prompt.
 */
function reportBranchCreationOutcome(
  result: Awaited<ReturnType<BranchManager["createBranchForIssue"]>>,
): void {
  switch (result.status) {
    case "created":
      void vscode.window.showInformationMessage(`Switched to new branch '${result.branchName}'.`);
      break;
    case "invalid-name":
      void vscode.window.showErrorMessage(
        `Generated branch name '${result.branchName}' is not a valid git ref. Check 'remoteProjectManager.branchNamePattern'.`,
      );
      break;
    case "error":
      void vscode.window.showErrorMessage(`Could not create branch: ${result.message}`);
      break;
    case "cancelled":
      break;
  }
}

/**
 * Lets the user search-select which branch to base the new branch on, via
 * a quick pick pre-filtered to `origin`'s branches. `main`/`master` (main
 * winning when both exist) is placed first so it starts focused/selected.
 * Returns `undefined` if the user backs out.
 */
async function pickBaseBranch(
  gitService: SimpleGitService,
  cwd: string,
): Promise<string | undefined> {
  const branches = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Fetching branches from origin…" },
    async () => {
      await gitService.fetch(cwd);
      return gitService.listBranches(cwd);
    },
  );
  if (branches.length === 0) {
    throw new Error("No branches found on 'origin'.");
  }

  const defaultBranch = pickDefaultBaseBranch(branches);
  const ordered = defaultBranch
    ? [defaultBranch, ...branches.filter((branch) => branch !== defaultBranch)]
    : branches;

  return vscode.window.showQuickPick(ordered, {
    title: "Base branch",
    placeHolder: "Branch to create the new branch from",
  });
}

/**
 * Handles a manual "create branch" request from the issue detail panel:
 * search-select the base branch, then create and switch via
 * {@link BranchManager}. Returns a toast message on success, or `null`
 * when the user cancelled at any step (base-branch picker or the
 * dirty-tree prompt); throws on failure so `PanelController` reports it.
 */
async function requestCreateBranch(
  issue: IIssue,
  cwd: string,
  gitService: SimpleGitService,
  branchManager: BranchManager,
  pattern: string | undefined,
): Promise<string | null> {
  const baseBranch = await pickBaseBranch(gitService, cwd);
  if (!baseBranch) {
    return null;
  }

  const result = await branchManager.createBranchForIssue(
    issue,
    cwd,
    { onDirtyWorkingTree: () => promptDirtyWorkingTree(issue.number) },
    pattern,
    baseBranch,
  );

  switch (result.status) {
    case "created":
      return `Switched to new branch '${result.branchName}'.`;
    case "cancelled":
      return null;
    case "invalid-name":
      throw new Error(
        `Generated branch name '${result.branchName}' is not a valid git ref. Check 'remoteProjectManager.branchNamePattern'.`,
      );
    case "error":
      throw new Error(`Could not create branch: ${result.message}`);
  }
}

/** Builds a provider and verifies the token by fetching the current user. */
async function connectProvider(
  providerKind: ProviderKind,
  repository: string,
  token: string,
  cacheTtlSeconds: number,
  gitlabHost: string | undefined,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const provider = new CachingProjectProvider(
    buildProvider(providerKind, repository, token, gitlabHost),
    cacheTtlSeconds * 1000,
  );
  const currentUser = await provider.getCurrentUser();
  return { provider, currentUser };
}

/**
 * Resolves a token and connects. For GitLab, a stale/revoked stored
 * token surfaces as a 401 on this first call; rather than showing a
 * generic error, clear it and re-prompt once via {@link ensureToken}'s
 * normal "no token stored" path. GitHub's session is managed by VS Code
 * itself, so it isn't retried here.
 */
async function resolveAndConnect(
  providerKind: ProviderKind,
  repository: string,
  credentialStore: ICredentialStore,
  cacheTtlSeconds: number,
  gitlabHost: string | undefined,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const token = await resolveToken(providerKind, credentialStore);
  try {
    return await connectProvider(providerKind, repository, token, cacheTtlSeconds, gitlabHost);
  } catch (error) {
    if (providerKind !== "gitlab" || !isAuthError(error)) {
      throw error;
    }
    await credentialStore.setToken(providerKind, "");
    const freshToken = await resolveToken(providerKind, credentialStore);
    return connectProvider(providerKind, repository, freshToken, cacheTtlSeconds, gitlabHost);
  }
}

/**
 * Resolves a token and connects, reading connection settings
 * (`cacheTtlSeconds`, `gitlabHost`) from configuration itself so callers
 * don't each re-read them. Shared by {@link buildController},
 * {@link MyIssuesTreeDataProvider}, and the AI-context/git-automation
 * commands (#57, #58, #61), which all need a connected provider whether
 * or not the panel is currently open.
 */
async function connectRepository(
  context: vscode.ExtensionContext,
  providerKind: ProviderKind,
  repository: string,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const credentialStore = makeCredentialStore(context.secrets);
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const cacheTtlSeconds = config.get<number>("cacheTtlSeconds", 180);
  const gitlabHost = config.get<string>("gitlabHost", "") || undefined;
  return resolveAndConnect(providerKind, repository, credentialStore, cacheTtlSeconds, gitlabHost);
}

/** Builds a fully wired PanelController for a resolved provider/repository. */
async function buildController(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  providerKind: ProviderKind,
  repository: string,
  folderPath: string | undefined,
): Promise<PanelController> {
  const credentialStore = makeCredentialStore(context.secrets);
  const { provider, currentUser } = await connectRepository(context, providerKind, repository);
  activeFolderPath = folderPath;
  activeProvider = provider;
  activeProviderKind = providerKind;

  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const autoBranchEnabled = config.get<boolean>("autoBranchOnInProgress", true);
  const branchNamePattern = config.get<string>("branchNamePattern", "");
  const pattern = branchNamePattern || undefined;
  const gitService = new SimpleGitService();
  const branchManager = new BranchManager(gitService);
  let reconnecting = false;

  return new PanelController(
    provider,
    (message) => {
      void panel.webview.postMessage(message);
    },
    (issue, transition) => {
      if (!shouldAutoCreateBranch(issue, transition, currentUser.username)) {
        return;
      }

      if (!autoBranchEnabled || !folderPath) {
        void vscode.window.showInformationMessage(
          `Issue #${issue.number} moved to in-progress. Suggested branch: ${generateBranchName(issue, pattern)}`,
        );
        return;
      }

      void branchManager
        .createBranchForIssue(
          issue,
          folderPath,
          { onDirtyWorkingTree: () => promptDirtyWorkingTree(issue.number) },
          pattern,
        )
        .then(reportBranchCreationOutcome)
        .catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    },
    (issue) => {
      if (!folderPath) {
        throw new Error(
          "No workspace folder resolved for this repository; cannot create a branch.",
        );
      }
      return requestCreateBranch(issue, folderPath, gitService, branchManager, pattern);
    },
    (issue) => {
      void vscode.window
        .showInformationMessage(
          `You were assigned to issue #${issue.number}: ${issue.title}`,
          "Open",
        )
        .then((choice) => {
          if (choice === "Open") {
            void vscode.commands.executeCommand("remoteProjectManager.openIssueFromTree", issue.id);
          }
        })
        .then(undefined, (error: unknown) => {
          void vscode.window.showErrorMessage(
            `Failed to show assignment notification: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    },
    (error) => {
      if (providerKind !== "gitlab" || !isAuthError(error) || reconnecting) {
        return;
      }
      reconnecting = true;
      void credentialStore.setToken(providerKind, "").then(() => {
        void vscode.window.showWarningMessage(
          "Your GitLab session expired. Reopening the panel to reconnect...",
        );
        panel.dispose();
        void openPanel(context);
      });
    },
  );
}

/** The single open panel and its controller, if any — see {@link openPanel}. */
let activePanel: vscode.WebviewPanel | undefined;
let activeController: PanelController | undefined;
/** The workspace folder, connected provider, and provider kind backing `activeController`, if any (see {@link buildController}). */
let activeFolderPath: string | undefined;
let activeProvider: IProjectProvider | undefined;
let activeProviderKind: ProviderKind | undefined;
/** {@link repositoryKey} of the resolution `activePanel` was built from, to detect a repository switch. */
let activeRepositoryKey: string | undefined;

/** A deferred UI action to apply once the panel (existing or freshly built) has a ready controller. */
type PendingPanelAction =
  | { readonly kind: "selectIssue"; readonly id: string }
  | { readonly kind: "newIssue" }
  | { readonly kind: "newMilestone" }
  | { readonly kind: "refresh" };

function applyPendingAction(
  panel: vscode.WebviewPanel,
  controller: PanelController,
  action: PendingPanelAction,
): void {
  switch (action.kind) {
    case "selectIssue":
      void panel.webview.postMessage({ type: "selectIssue", id: action.id });
      return;
    case "newIssue":
      void panel.webview.postMessage({ type: "openNewIssueForm" });
      return;
    case "newMilestone":
      void panel.webview.postMessage({ type: "openNewMilestoneForm" });
      return;
    case "refresh":
      void controller.handleMessage({ type: "requestState", forceRefresh: true });
      return;
  }
}

/**
 * Opens the central panel, or reveals it if one is already open instead
 * of creating a duplicate editor tab and rebuilding the whole
 * provider/controller (with its own extra token resolution and API
 * calls). Pass `pendingAction` to also apply a deferred UI action (select
 * an issue, open a create form, or force-refresh) once a controller is
 * ready — used by the sidebar tree's click-through (#25) and the
 * Command Palette entries (#35).
 */
/**
 * Serializes {@link openPanelImpl} calls: `activePanel`/`activeController`
 * aren't assigned until after an `await resolveRepository()` (and, on
 * the "resolved" path, an `await buildController()`), so two commands
 * that both call `openPanel` in quick succession (e.g. a fast
 * double-click on a sidebar tree item, or the Command Palette racing a
 * tree click) would otherwise both see no active panel yet and each
 * build their own — duplicate token prompts/API calls, and whichever
 * finishes last silently wins `activePanel`/`activeProvider`, leaving
 * them possibly out of sync with each other. A caller that arrives
 * while another call is in flight waits for it, then re-checks (via the
 * recursive call) instead of racing a second `buildController`.
 */
let openPanelInFlight: Promise<void> | undefined;

async function openPanel(
  context: vscode.ExtensionContext,
  pendingAction?: PendingPanelAction,
): Promise<void> {
  if (openPanelInFlight) {
    await openPanelInFlight;
    return openPanel(context, pendingAction);
  }
  const run = openPanelImpl(context, pendingAction);
  openPanelInFlight = run.finally(() => {
    openPanelInFlight = undefined;
  });
  return run;
}

async function openPanelImpl(
  context: vscode.ExtensionContext,
  pendingAction?: PendingPanelAction,
): Promise<void> {
  if (activePanel && activeController) {
    activePanel.reveal();
    if (pendingAction) {
      applyPendingAction(activePanel, activeController, pendingAction);
    }
    return;
  }

  const resolution = await resolveRepository();

  if (resolution.kind === "none") {
    void vscode.window.showErrorMessage(
      "No GitHub/GitLab repository detected in this workspace. Set 'remoteProjectManager.repository' to 'owner/repo' manually.",
    );
    return;
  }

  const panel = createPanel(context);
  activePanel = panel;
  activeRepositoryKey = repositoryKey(resolution);
  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
      activeRepositoryKey = undefined;
      activeController = undefined;
      activeFolderPath = undefined;
      activeProvider = undefined;
      activeProviderKind = undefined;
    }
  });

  if (resolution.kind === "resolved") {
    let controller: PanelController;
    try {
      controller = await buildController(
        context,
        panel,
        resolution.providerKind,
        resolution.repository,
        resolution.folderPath,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      panel.dispose();
      return;
    }
    activeController = controller;
    panel.webview.onDidReceiveMessage((message: InboundMessage) => {
      void controller.handleMessage(message);
    });
    if (pendingAction) {
      // A "refresh" pendingAction already sends its own requestState
      // (forceRefresh: true) below — sending the plain one first would
      // fire two concurrent full state fetches for one user action.
      if (pendingAction.kind !== "refresh") {
        void controller.handleMessage({ type: "requestState" });
      }
      applyPendingAction(panel, controller, pendingAction);
    } else {
      void controller.handleMessage({ type: "requestState" });
    }
    return;
  }

  // Multiple candidates: let the webview's picker choose before building
  // any provider, so no token is requested until a repository is picked.
  const candidates = resolution.candidates;
  let controller: PanelController | undefined;

  panel.webview.onDidReceiveMessage(async (message: InboundMessage) => {
    if (controller) {
      void controller.handleMessage(message);
      return;
    }

    if (message.type === "requestState") {
      void panel.webview.postMessage({
        type: "repositoryOptions",
        options: candidates.map(toRepositoryOptionView),
      });
      return;
    }

    if (message.type === "selectRepository") {
      const chosen = candidates.find((candidate) => candidate.folderPath === message.id);
      if (!chosen) {
        return;
      }
      try {
        controller = await buildController(
          context,
          panel,
          chosen.provider,
          chosen.repository,
          chosen.folderPath,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        panel.dispose();
        return;
      }
      activeController = controller;
      if (pendingAction) {
        if (pendingAction.kind !== "refresh") {
          void controller.handleMessage({ type: "requestState" });
        }
        applyPendingAction(panel, controller, pendingAction);
      } else {
        void controller.handleMessage({ type: "requestState" });
      }
    }
  });
}

/**
 * Populates the activity bar sidebar with the current user's assigned
 * open issues, so they're visible without opening the full panel. Lazily
 * connects on first reveal (VS Code calls `getChildren` when the view
 * becomes visible) and reuses that connection afterward, independently
 * of any panel connection — a separate token prompt/connect from the
 * panel's own, by design, so revealing the sidebar never depends on the
 * panel having been opened first.
 *
 * When no repository can be resolved unambiguously (none detected, or
 * multiple candidates the panel's webview picker would normally
 * disambiguate), or the connection fails for any reason, this silently
 * returns an empty list rather than prompting/erroring from a passive
 * sidebar reveal — VS Code then falls back to the `viewsWelcome` entry's
 * "Open Panel" link, which goes through the full picker/error UX.
 */
class MyIssuesTreeDataProvider implements vscode.TreeDataProvider<MyIssueSummary> {
  private connection: { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined;
  private connectionKey: string | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Drops the cached connection and asks VS Code to re-render the tree
   * immediately — used after "Sign Out of GitLab" (#21), which otherwise
   * cleared the stored token without the sidebar ever noticing.
   */
  invalidateConnection(): void {
    this.connection = undefined;
    this.connectionKey = undefined;
    this.changeEmitter.fire();
  }

  /** Re-renders the tree (re-resolving the repository) without dropping a still-valid connection. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: MyIssueSummary): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `#${element.number} ${element.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.tooltip = element.url;
    item.iconPath = new vscode.ThemeIcon("issues");
    item.command = {
      command: "remoteProjectManager.openIssueFromTree",
      title: "Open Issue",
      arguments: [element.id],
    };
    return item;
  }

  async getChildren(): Promise<MyIssueSummary[]> {
    try {
      const connection = await this.getConnection();
      if (!connection) {
        return [];
      }
      const issues = await connection.provider.listIssues();
      return selectMyOpenIssues(issues, connection.currentUser.username);
    } catch (error) {
      // Drop the cached connection on an auth failure (e.g. a revoked
      // GitLab token) so the next reveal re-runs getConnection() and
      // goes through resolveAndConnect's re-prompt flow, instead of
      // reusing a dead provider forever.
      if (isAuthError(error)) {
        this.connection = undefined;
      }
      return [];
    }
  }

  private async getConnection(): Promise<
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined
  > {
    // Re-resolve every time (cheap local `git remote get-url`) so a
    // connection never outlives the repository it was built for.
    const resolution = await resolveRepository();
    const key = repositoryKey(resolution);
    if (this.connection && this.connectionKey === key) {
      return this.connection;
    }
    this.connection = undefined;
    this.connectionKey = undefined;
    if (resolution.kind !== "resolved") {
      return undefined;
    }
    this.connection = await connectRepository(
      this.context,
      resolution.providerKind,
      resolution.repository,
    );
    this.connectionKey = key;
    return this.connection;
  }
}

/**
 * Keeps the sidebar and the open panel in sync with the loaded git
 * repository. Re-resolves the repository and, when it differs from what
 * the open panel was built for, rebuilds the panel (re-running the
 * normal resolve/pick flow) so issues and milestones always belong to
 * the code currently open.
 */
async function syncWithRepository(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): Promise<void> {
  treeDataProvider.refresh();
  if (!activePanel || openPanelInFlight) {
    return;
  }
  const key = repositoryKey(await resolveRepository());
  if (!activePanel || key === activeRepositoryKey) {
    return;
  }
  activePanel.dispose();
  await openPanel(context);
}

/** Debounces bursts of change events (e.g. several `.git/config` writes) into one sync. */
function registerRepositorySync(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void syncWithRepository(context, treeDataProvider);
    }, 300);
  };

  const watchers = new Map<string, vscode.Disposable>();
  const watchGitConfigs = (): void => {
    const current = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderPath = folder.uri.fsPath;
      current.add(folderPath);
      if (watchers.has(folderPath)) {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, ".git/config"),
      );
      watchers.set(
        folderPath,
        vscode.Disposable.from(
          watcher,
          watcher.onDidChange(schedule),
          watcher.onDidCreate(schedule),
          watcher.onDidDelete(schedule),
        ),
      );
    }
    for (const [folderPath, disposable] of watchers) {
      if (!current.has(folderPath)) {
        disposable.dispose();
        watchers.delete(folderPath);
      }
    }
  };
  watchGitConfigs();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchGitConfigs();
      schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("remoteProjectManager.repository") ||
        event.affectsConfiguration("remoteProjectManager.provider") ||
        event.affectsConfiguration("remoteProjectManager.gitlabHost")
      ) {
        schedule();
      }
    }),
    new vscode.Disposable(() => {
      clearTimeout(timer);
      for (const disposable of watchers.values()) {
        disposable.dispose();
      }
      watchers.clear();
    }),
  );
}

/**
 * Clears the stored GitLab Personal Access Token from `SecretStorage`.
 * There is no way to detect a revoked/expired token proactively, so this
 * is the escape hatch for switching accounts or recovering from a stale
 * token: the next GitLab connection prompts for a fresh one.
 */
async function signOutGitLab(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): Promise<void> {
  await context.secrets.delete(secretKeyFor("gitlab"));
  treeDataProvider.invalidateConnection();
  // The AI-context/git-automation commands (getActiveConnection) reuse
  // activeProvider with no freshness check — clear it too so they
  // re-resolve and re-prompt for a token instead of silently reusing a
  // provider built with the now-deleted one.
  if (activeProviderKind === "gitlab") {
    activeProvider = undefined;
    activeFolderPath = undefined;
    activeProviderKind = undefined;
  }
  void vscode.window.showInformationMessage(
    "Signed out of GitLab. You'll be prompted for a new token next time the panel connects to a GitLab repository.",
  );
}

/** Display text for each Conventional Commits type, shown in the compose-commit QuickPick. */
const COMMIT_TYPE_DESCRIPTIONS: Record<CommitType, string> = {
  feat: "A new feature",
  fix: "A bug fix",
  docs: "Documentation only changes",
  style: "Formatting; no code meaning change",
  refactor: "Neither fixes a bug nor adds a feature",
  perf: "A performance improvement",
  test: "Adding or correcting tests",
  build: "Build system or external dependencies",
  ci: "CI configuration or scripts",
  chore: "Other changes (tooling, config, ...)",
  revert: "Reverts a previous commit",
};

let gitmojisCache: Gitmoji[] | undefined;

/** Reads and validates the bundled `resources/gitmojis.json`, caching the result. */
async function loadGitmojis(context: vscode.ExtensionContext): Promise<Gitmoji[]> {
  if (gitmojisCache) {
    return gitmojisCache;
  }
  const uri = vscode.Uri.joinPath(context.extensionUri, "resources", "gitmojis.json");
  const bytes = await vscode.workspace.fs.readFile(uri);
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  gitmojisCache = parseGitmojis(raw);
  return gitmojisCache;
}

/** Interactive Gitmoji picker (#55): a searchable QuickPick over the bundled list. */
async function showGitmojiPicker(context: vscode.ExtensionContext): Promise<Gitmoji | undefined> {
  const gitmojis = await loadGitmojis(context);
  const picked = await vscode.window.showQuickPick(
    gitmojis.map((gitmoji) => ({
      label: `${gitmoji.emoji}  ${gitmoji.code}`,
      description: gitmoji.description,
      gitmoji,
    })),
    {
      title: "Pick a Gitmoji",
      placeHolder: "Search by code or description",
      matchOnDescription: true,
    },
  );
  return picked?.gitmoji;
}

/** Minimal shape of the built-in `vscode.git` extension's exported API (version 1) that this extension uses. */
interface MinimalGitApi {
  readonly repositories: ReadonlyArray<{
    readonly rootUri: vscode.Uri;
    readonly inputBox: { value: string };
  }>;
}
interface MinimalGitExtensionExports {
  getAPI(version: 1): MinimalGitApi;
}

/**
 * Finds the SCM input box for the repository at `cwd` via the built-in
 * `vscode.git` extension, so a composed commit message can be dropped
 * straight into Source Control instead of the user retyping it. Returns
 * `undefined` if the git extension isn't installed/active or has no
 * matching repository — callers fall back to the clipboard.
 */
async function getScmInputBox(cwd: string): Promise<{ value: string } | undefined> {
  const extension = vscode.extensions.getExtension<MinimalGitExtensionExports>("vscode.git");
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  const api = exports.getAPI(1);
  // No `?? api.repositories[0]` fallback: in a multi-root workspace with
  // several git repositories, falling back to "whichever one the git
  // extension found first" would silently write the composed message
  // into an unrelated repo's input box instead of the clipboard.
  const repository = api.repositories.find((candidate) => candidate.rootUri.fsPath === cwd);
  return repository?.inputBox;
}

/**
 * Resolves the "active issue" for git-automation commands (#56, #57,
 * #58, #61) from the current branch name, via
 * {@link extractIssueNumberFromBranch} — consistent with how this
 * extension names branches it creates itself
 * (`remoteProjectManager.branchNamePattern`). Returns `null` when the
 * branch encodes no issue number or doesn't match any known issue;
 * callers fall back to letting the user pick manually.
 */
async function resolveActiveIssueViaBranch(
  gitService: SimpleGitService,
  cwd: string,
  provider: IProjectProvider,
): Promise<IIssue | null> {
  let branch: string;
  try {
    branch = await gitService.getCurrentBranch(cwd);
  } catch {
    return null;
  }
  const issueNumber = extractIssueNumberFromBranch(branch);
  if (issueNumber === null) {
    return null;
  }
  const issues = await provider.listIssues();
  return issues.find((issue) => issue.number === issueNumber) ?? null;
}

/** Looks up an issue's milestone, if it has one. */
async function findMilestoneForIssue(
  provider: IProjectProvider,
  issue: IIssue,
): Promise<IMilestone | null> {
  if (!issue.milestoneId) {
    return null;
  }
  const milestones = await provider.listMilestones();
  return milestones.find((milestone) => milestone.id === issue.milestoneId) ?? null;
}

/**
 * Gets a connected provider and workspace folder for AI-context/git
 * commands (#57, #58, #61), reusing the open panel's connection when
 * there is one, or connecting fresh otherwise — these commands are
 * useful even without the panel open. Returns `null` when no repository
 * can be resolved unambiguously (mirrors {@link resolveRepository}'s
 * "none"/"candidates" cases, which these single-shot commands don't have
 * a picker UI for).
 */
async function getActiveConnection(
  context: vscode.ExtensionContext,
): Promise<{ provider: IProjectProvider; cwd: string } | null> {
  if (activeProvider && activeFolderPath) {
    return { provider: activeProvider, cwd: activeFolderPath };
  }
  const resolution = await resolveRepository();
  if (resolution.kind !== "resolved" || !resolution.folderPath) {
    return null;
  }
  try {
    const { provider } = await connectRepository(
      context,
      resolution.providerKind,
      resolution.repository,
    );
    return { provider, cwd: resolution.folderPath };
  } catch {
    return null;
  }
}

/**
 * Interactive commit-composition flow (#54, #55, #56): walks through
 * type, scope, Gitmoji, description, and an optional issue reference
 * (pre-filled from the current branch, see
 * {@link resolveActiveIssueViaBranch}'s sibling
 * {@link extractIssueNumberFromBranch}), then drops the composed message
 * into the Source Control input box (or the clipboard, if the git
 * extension isn't available).
 */
async function composeCommit(context: vscode.ExtensionContext): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const typePick = await vscode.window.showQuickPick(
    COMMIT_TYPES.map((type) => ({ label: type, description: COMMIT_TYPE_DESCRIPTIONS[type] })),
    { title: "Commit type", placeHolder: "Conventional Commits type" },
  );
  if (!typePick) {
    return;
  }

  const scope = await vscode.window.showInputBox({
    title: "Scope (optional)",
    prompt: "e.g. 'commits', 'ui' — leave empty for none",
  });
  if (scope === undefined) {
    return;
  }

  const gitmoji = await showGitmojiPicker(context);
  if (!gitmoji) {
    return;
  }

  const description = await vscode.window.showInputBox({
    title: "Description",
    prompt: "Short, imperative description of the change",
    validateInput: (value) => (value.trim() ? undefined : "Description is required."),
  });
  if (!description) {
    return;
  }

  const gitService = new SimpleGitService();
  let issueNumber: number | undefined;
  try {
    const branch = await gitService.getCurrentBranch(cwd);
    issueNumber = extractIssueNumberFromBranch(branch) ?? undefined;
  } catch {
    // No git repo / no commits yet — proceed with no detected issue.
  }

  if (issueNumber === undefined) {
    const manual = await vscode.window.showInputBox({
      title: "Issue number (optional)",
      prompt: "Leave empty for no issue reference",
      validateInput: (value) =>
        value === "" || /^\d+$/.test(value) ? undefined : "Enter a number, or leave empty.",
    });
    if (manual === undefined) {
      return;
    }
    if (manual !== "") {
      issueNumber = Number(manual);
    }
  }

  let issueReferenceKind: IssueReferenceKind = "none";
  if (issueNumber !== undefined) {
    const refPick = await vscode.window.showQuickPick(
      [
        {
          label: `Fixes #${issueNumber}`,
          description: "Closes the issue on merge to the default branch",
          refKind: "fixes" as const,
        },
        {
          label: `Refs #${issueNumber}`,
          description: "References the issue without closing it",
          refKind: "refs" as const,
        },
        { label: "No issue reference", refKind: "none" as const },
      ],
      { title: `Link this commit to issue #${issueNumber}?` },
    );
    if (!refPick) {
      return;
    }
    issueReferenceKind = refPick.refKind;
  }

  const message = buildCommitMessage({
    type: typePick.label,
    scope: scope || undefined,
    gitmoji: gitmoji.emoji,
    description: description.trim(),
    issueNumber,
    issueReferenceKind,
  });

  const inputBox = await getScmInputBox(cwd);
  if (inputBox) {
    inputBox.value = message;
    void vscode.window.showInformationMessage(
      "Commit message ready in the Source Control input box.",
    );
  } else {
    await vscode.env.clipboard.writeText(message);
    void vscode.window.showInformationMessage(
      "Commit message copied to clipboard (Git extension not available).",
    );
  }
}

/** Standalone Gitmoji picker command (#55): inserts at the cursor, or copies to clipboard with no active editor. */
async function pickGitmojiCommand(context: vscode.ExtensionContext): Promise<void> {
  const gitmoji = await showGitmojiPicker(context);
  if (!gitmoji) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await editor.edit((editBuilder) => {
      editBuilder.insert(editor.selection.active, gitmoji.emoji);
    });
    return;
  }
  await vscode.env.clipboard.writeText(gitmoji.emoji);
  void vscode.window.showInformationMessage(
    `Copied ${gitmoji.emoji} ${gitmoji.code} to clipboard.`,
  );
}

/** The most recently copied issue context, exposed via this extension's API (see {@link activate}) for other extensions/agents. */
let lastIssueContext: string | undefined;

/** Copies the active issue's context (#57) to the clipboard for pasting into an AI coding assistant. */
async function copyIssueContext(context: vscode.ExtensionContext): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();

  let issue = await resolveActiveIssueViaBranch(gitService, cwd, provider);
  if (!issue) {
    const issues = await provider.listIssues();
    const picked = await vscode.window.showQuickPick(
      issues.map((candidate) => ({
        label: `#${candidate.number} ${candidate.title}`,
        issue: candidate,
      })),
      { title: "Copy context for which issue?", placeHolder: "Type to filter" },
    );
    if (!picked) {
      return;
    }
    issue = picked.issue;
  }

  const milestone = await findMilestoneForIssue(provider, issue);
  const contextBlock = formatIssueContext(issue, milestone);
  lastIssueContext = contextBlock;
  await vscode.env.clipboard.writeText(contextBlock);
  void vscode.window.showInformationMessage(`Copied issue #${issue.number} context to clipboard.`);
}

/** Builds a prefilled GitHub compare or GitLab merge-request URL (fallback when direct PR creation isn't wired up). */
function buildCompareUrl(
  providerKind: ProviderKind,
  repository: string,
  baseBranch: string,
  headBranch: string,
  title: string,
  body: string,
  gitlabHost: string | undefined,
): string {
  if (providerKind === "github") {
    const params = new URLSearchParams({ quick_pull: "1", title, body });
    return `https://github.com/${repository}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?${params.toString()}`;
  }
  const host = gitlabHost || "gitlab.com";
  const params = new URLSearchParams({
    "merge_request[source_branch]": headBranch,
    "merge_request[target_branch]": baseBranch,
    "merge_request[title]": title,
    "merge_request[description]": body,
  });
  return `https://${host}/${repository}/-/merge_requests/new?${params.toString()}`;
}

/** Generates a PR/MR pre-filled from the active issue, its commits, and its milestone (#58). */
async function createPrFromIssue(context: vscode.ExtensionContext): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();

  const issue = await resolveActiveIssueViaBranch(gitService, cwd, provider);
  if (!issue) {
    void vscode.window.showErrorMessage(
      "Could not determine which issue this branch is for. Rename the branch to include the issue number (e.g. 'fix/53-description').",
    );
    return;
  }
  const milestone = await findMilestoneForIssue(provider, issue);

  let defaultBranch: string;
  let currentBranch: string;
  let commits: CommitRef[];
  try {
    defaultBranch = await gitService.getDefaultBranch(cwd);
    currentBranch = await gitService.getCurrentBranch(cwd);
    const log = await gitService.log(cwd, `origin/${defaultBranch}..HEAD`);
    commits = log.map((entry) => ({ hash: entry.hash, message: entry.message }));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not resolve branches or commits: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const title = buildPrTitle(issue);
  const body = buildPrBody(issue, milestone, commits);

  const resolution = await resolveRepository();
  if (resolution.kind !== "resolved") {
    await vscode.env.clipboard.writeText(body);
    void vscode.window.showInformationMessage(
      "Could not resolve the repository URL; PR body copied to clipboard instead.",
    );
    return;
  }

  const gitlabHost =
    vscode.workspace.getConfiguration("remoteProjectManager").get<string>("gitlabHost", "") ||
    undefined;
  const url = buildCompareUrl(
    resolution.providerKind,
    resolution.repository,
    defaultBranch,
    currentBranch,
    title,
    body,
    gitlabHost,
  );
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Shows the semantic Git Graph (#59): commits grouped by referenced issue, browsable via QuickPick. */
async function showGitGraph(): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  const gitService = new SimpleGitService();
  let log;
  try {
    log = await gitService.log(cwd, "-200");
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not read git log: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const commits: CommitRef[] = log.map((entry) => ({ hash: entry.hash, message: entry.message }));
  const groups = groupCommitsByIssue(commits);
  if (groups.length === 0) {
    void vscode.window.showInformationMessage("No commits found.");
    return;
  }

  let issueTitles = new Map<number, string>();
  if (activeProvider) {
    try {
      const issues = await activeProvider.listIssues();
      issueTitles = new Map(issues.map((issue) => [issue.number, issue.title]));
    } catch {
      // Best-effort decoration only — fall back to plain "#N" labels.
    }
  }

  const groupPick = await vscode.window.showQuickPick(
    groups.map((group) => ({
      label:
        group.issueNumber === null
          ? "Unlinked"
          : `#${group.issueNumber}${issueTitles.has(group.issueNumber) ? " " + issueTitles.get(group.issueNumber) : ""}`,
      description: `${group.commits.length} commit${group.commits.length === 1 ? "" : "s"}`,
      group,
    })),
    { title: "Git Graph — grouped by issue", placeHolder: "Pick an issue to see its commits" },
  );
  if (!groupPick) {
    return;
  }

  const commitPick = await vscode.window.showQuickPick(
    groupPick.group.commits.map((commit) => ({
      label: commit.hash.slice(0, 7),
      description: commit.message.split("\n")[0],
      commit,
    })),
    { title: groupPick.label, placeHolder: "Pick a commit to copy its hash" },
  );
  if (!commitPick) {
    return;
  }

  await vscode.env.clipboard.writeText(commitPick.commit.hash);
  void vscode.window.showInformationMessage(`Copied commit ${commitPick.label} to clipboard.`);
}

/** Lints recent commit history against the Gitmoji/Conventional Commit convention (#60), never rewriting history. */
async function lintCommitHistory(): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  const gitService = new SimpleGitService();
  let log;
  try {
    log = await gitService.log(cwd, "-100");
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not read git log: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  const commits: CommitRef[] = log.map((entry) => ({ hash: entry.hash, message: entry.message }));
  const results = lintCommits(commits);
  const violations = results.filter((result) => !result.valid);

  if (violations.length === 0) {
    void vscode.window.showInformationMessage(
      "All checked commits (last 100) comply with the Gitmoji/Conventional Commit convention.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    violations.map((violation) => ({
      label: `${violation.hash.slice(0, 7)} ${violation.message.split("\n")[0]}`,
      description: violation.reason,
      detail: violation.suggestion
        ? `Suggested: ${violation.suggestion.split("\n")[0]}`
        : undefined,
      violation,
    })),
    {
      title: `${violations.length} non-compliant commit(s) in the last 100`,
      placeHolder: "Pick one to copy its suggested message (never applied automatically)",
    },
  );
  if (!picked?.violation.suggestion) {
    return;
  }

  await vscode.env.clipboard.writeText(picked.violation.suggestion);
  void vscode.window.showInformationMessage(
    `Copied suggested message for ${picked.violation.hash.slice(0, 7)} to clipboard.`,
  );
}

/** Exports the active milestone's context to a configurable Markdown file for AI agents (#61), idempotently. */
async function exportMilestoneContext(context: vscode.ExtensionContext): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();

  let milestone: IMilestone | null = null;
  const issue = await resolveActiveIssueViaBranch(gitService, cwd, provider);
  if (issue) {
    milestone = await findMilestoneForIssue(provider, issue);
  }
  if (!milestone) {
    const milestones = await provider.listMilestones();
    const picked = await vscode.window.showQuickPick(
      milestones.map((candidate) => ({
        label: candidate.title,
        description: `#${candidate.number}`,
        milestone: candidate,
      })),
      { title: "Export context for which milestone?" },
    );
    if (!picked) {
      return;
    }
    milestone = picked.milestone;
  }
  if (!milestone) {
    return;
  }
  const resolvedMilestone = milestone;

  const allIssues = await provider.listIssues();
  const milestoneIssues = allIssues.filter(
    (candidate) => candidate.milestoneId === resolvedMilestone.id,
  );
  const block = formatMilestoneContext(resolvedMilestone, milestoneIssues);

  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const relativePath =
    config.get<string>("aiContextFile", ".github/copilot-instructions.md") ||
    ".github/copilot-instructions.md";
  const safeSegments = resolveSafeRelativeSegments(relativePath);
  if (!safeSegments) {
    void vscode.window.showErrorMessage(
      `'remoteProjectManager.aiContextFile' ("${relativePath}") escapes the workspace folder and was rejected.`,
    );
    return;
  }
  const fileUri = vscode.Uri.joinPath(vscode.Uri.file(cwd), ...safeSegments);

  let existing = "";
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    existing = Buffer.from(bytes).toString("utf8");
  } catch {
    // File doesn't exist yet — start from empty.
  }

  const updated = replaceManagedSection(existing, "milestone-context", block);

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, ".."));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, "utf8"));

  void vscode.window.showInformationMessage(`Exported milestone context to ${relativePath}.`);
}

/** API this extension exposes to other extensions (e.g. AI agents) via `extensions.getExtension(...).exports`. */
export interface RemoteProjectManagerApi {
  /** The Markdown context block from the last "Copy Issue Context for AI" invocation, if any. */
  getActiveIssueContext(): string | undefined;
}

export function activate(context: vscode.ExtensionContext): RemoteProjectManagerApi {
  const treeDataProvider = new MyIssuesTreeDataProvider(context);
  registerRepositorySync(context, treeDataProvider);
  context.subscriptions.push(
    vscode.commands.registerCommand("remoteProjectManager.openPanel", () => {
      void openPanel(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.signOutGitLab", () => {
      void signOutGitLab(context, treeDataProvider);
    }),
    vscode.commands.registerCommand("remoteProjectManager.openIssueFromTree", (issueId: string) => {
      void openPanel(context, { kind: "selectIssue", id: issueId });
    }),
    vscode.commands.registerCommand("remoteProjectManager.newIssue", () => {
      void openPanel(context, { kind: "newIssue" });
    }),
    vscode.commands.registerCommand("remoteProjectManager.newMilestone", () => {
      void openPanel(context, { kind: "newMilestone" });
    }),
    vscode.commands.registerCommand("remoteProjectManager.refresh", () => {
      void openPanel(context, { kind: "refresh" });
    }),
    vscode.commands.registerCommand("remoteProjectManager.composeCommit", () => {
      void composeCommit(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.pickGitmoji", () => {
      void pickGitmojiCommand(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.copyIssueContext", () => {
      void copyIssueContext(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.createPrFromIssue", () => {
      void createPrFromIssue(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.showGitGraph", () => {
      void showGitGraph();
    }),
    vscode.commands.registerCommand("remoteProjectManager.lintCommitHistory", () => {
      void lintCommitHistory();
    }),
    vscode.commands.registerCommand("remoteProjectManager.exportMilestoneContext", () => {
      void exportMilestoneContext(context);
    }),
    vscode.window.registerTreeDataProvider("remoteProjectManager.sidebar", treeDataProvider),
  );

  return {
    getActiveIssueContext: () => lastIssueContext,
  };
}

export function deactivate(): void {
  // No cleanup required: webview panels and subscriptions are disposed
  // by VS Code when the extension host shuts down.
}
