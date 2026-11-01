import * as vscode from "vscode";
import { promises as fs } from "node:fs";
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
import {
  buildIssueDescription,
  buildIssueTooltip,
  groupMyIssues,
  priorityOf,
  selectMyOpenIssues,
  workStatusOf,
  type MyIssueGroup,
  type MyIssueSummary,
} from "./core/tree/my-issues";
import { BranchManager } from "./core/git/branch-manager";
import type { DirtyTreeDecision } from "./core/git/branch-manager.interface";
import { pickDefaultBaseBranch } from "./core/git/pick-default-base-branch";
import { PanelController } from "./webview/panel-controller";
import type { InboundMessage, RepositoryOptionView } from "./webview/messages";
import { getWebviewHtml } from "./webview/webview-html";
import { extractIssueNumberFromBranch } from "./core/git/branch-issue-ref";
import { buildCommitMsgHookScript, classifyExistingHook } from "./core/git/commit-msg-hook";
import { buildCompareUrl } from "./core/git/compare-url";
import { suggestCommitScope, suggestCommitType } from "./core/git/commit-suggestions";
import { IssueStatusBar } from "./status-bar";
import { StateSync } from "./state-sync";
import {
  AiContextSync,
  readAiContextTargets,
  trackExportedContext,
  writeContextFiles,
} from "./ai-context-files";
import { digestContext } from "./core/ai/context-targets";
import { describeBranchPatternWarning, previewBranchPattern } from "./core/settings/branch-pattern";
import {
  buildSettingEntries,
  findSettingDescriptor,
  validateSettingValue,
} from "./core/settings/settings-schema";
import type { SettingsBridge } from "./webview/panel-controller";
import { openGitGraph } from "./git-graph-panel";
import { parseIssueTemplate, type IssueTemplate } from "./core/templates/issue-template";
import {
  describeAssignedBadge,
  isPollDue,
  normalizePollInterval,
} from "./core/polling/poll-schedule";
import { registerEditorIntegration } from "./editor-integration";
import { logger } from "./logger";
import { formatDiagnosticsReport, type DiagnosticsInput } from "./core/diagnostics/report";
import type { SyncState } from "./core/status/status-bar-model";
import {
  buildCommitMessage,
  COMMIT_TYPES,
  type CommitType,
  type IssueReferenceKind,
} from "./core/git/commit-message";
import { parseGitmojis, type Gitmoji } from "./core/git/gitmoji";
import { lintCommits } from "./core/git/lint-commits";
import { buildConventionalPrTitle, buildPrBody, type CommitRef } from "./core/git/pr-body";
import { formatIssueContext } from "./core/ai/issue-context";
import { formatMilestoneContext } from "./core/ai/milestone-context";
import type { IMilestone } from "./core/models/milestone.model";

/** `workspaceState` key holding the panel's UI preferences (saved filters, sort order, ...). */
const UI_PREFS_KEY = "remoteProjectManager.uiPrefs";

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
    title: vscode.l10n.t("{0} Personal Access Token", provider === "github" ? "GitHub" : "GitLab"),
    prompt: vscode.l10n.t(
      "Enter a {0} personal access token with repo/issue read-write scope.",
      provider,
    ),
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
/** `workspaceState` key remembering which workspace folder's repository the user picked. */
const SELECTED_REPOSITORY_KEY = "remoteProjectManager.selectedRepositoryFolder";
/** The remembered repository folder; used by {@link resolveRepository} when several folders qualify. */
let selectedRepositoryFolder: string | undefined;
/** The sidebar provider, so a repository switch from the panel can refresh it. */
let activeTreeProvider: MyIssuesTreeDataProvider | undefined;

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
    preferredFolderPath: selectedRepositoryFolder,
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
  const stashChoice = vscode.l10n.t("Stash & Continue");
  const forceChoice = vscode.l10n.t("Force Switch");
  const cancelChoice = vscode.l10n.t("Cancel");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Your working tree has uncommitted changes. Creating a branch for issue #{0} will switch branches.",
      issueNumber,
    ),
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
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Switched to new branch '{0}'.", result.branchName),
      );
      break;
    case "invalid-name":
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Generated branch name '{0}' is not a valid git ref. Check 'remoteProjectManager.branchNamePattern'.",
          result.branchName,
        ),
      );
      break;
    case "error":
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Could not create branch: {0}", result.message),
      );
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
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Fetching branches from origin…"),
    },
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
    title: vscode.l10n.t("Base branch"),
    placeHolder: vscode.l10n.t("Branch to create the new branch from"),
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

/** Workspace-relative places issue templates live, directories first. */
const TEMPLATE_DIRECTORIES = [".github/ISSUE_TEMPLATE", ".gitlab/issue_templates"] as const;
const TEMPLATE_FILES = [".github/ISSUE_TEMPLATE.md", ".github/issue_template.md"] as const;

/** Reads Markdown issue templates from the repository's conventional locations. */
async function readIssueTemplates(folderPath: string | undefined): Promise<IssueTemplate[]> {
  if (!folderPath) {
    return [];
  }
  const root = vscode.Uri.file(folderPath);
  const templates: IssueTemplate[] = [];
  const read = async (uri: vscode.Uri, fileName: string): Promise<void> => {
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const template = parseIssueTemplate(fileName, content);
      if (template) {
        templates.push(template);
      }
    } catch {
      // Unreadable template: skip it rather than failing the whole list.
    }
  };
  for (const directory of TEMPLATE_DIRECTORIES) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, directory));
    } catch {
      continue;
    }
    for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (type === vscode.FileType.File) {
        await read(vscode.Uri.joinPath(root, directory, name), name);
      }
    }
  }
  for (const file of TEMPLATE_FILES) {
    await read(vscode.Uri.joinPath(root, file), file.split("/").pop() ?? file);
  }
  return templates;
}

/** Backs the in-panel settings page with the real VS Code configuration. */
function makeSettingsBridge(): SettingsBridge {
  const section = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration("remoteProjectManager");
  return {
    read: () =>
      buildSettingEntries((key) => {
        const configuration = section();
        return {
          value: configuration.get(key),
          defaultValue: configuration.inspect(key)?.defaultValue,
        };
      }, vscode.l10n.t),
    write: async (key, value) => {
      const descriptor = findSettingDescriptor(key);
      if (!descriptor) {
        return vscode.l10n.t("Unknown setting.");
      }
      // `null` resets the setting to its default.
      let stored: unknown;
      if (value !== null) {
        const validation = validateSettingValue(descriptor, value, vscode.l10n.t);
        if (!validation.ok) {
          return validation.reason;
        }
        stored = validation.value;
      }
      const target =
        descriptor.scope === "workspace" && (vscode.workspace.workspaceFolders?.length ?? 0) > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
      try {
        await section().update(key, stored, target);
        return null;
      } catch (error) {
        return vscode.l10n.t(
          "Could not save the setting: {0}",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    previewBranchName: (pattern, sample) => {
      const preview = previewBranchPattern(pattern, sample);
      return {
        example: preview.example,
        warnings: preview.warnings.map((warning) =>
          describeBranchPatternWarning(warning, vscode.l10n.t),
        ),
      };
    },
  };
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
          vscode.l10n.t(
            "Issue #{0} moved to in-progress. Suggested branch: {1}",
            issue.number,
            generateBranchName(issue, pattern),
          ),
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
            vscode.l10n.t(
              "Could not create branch: {0}",
              error instanceof Error ? error.message : String(error),
            ),
          );
        });
    },
    (issue) => {
      if (!folderPath) {
        throw new Error(
          vscode.l10n.t(
            "No workspace folder resolved for this repository; cannot create a branch.",
          ),
        );
      }
      return requestCreateBranch(issue, folderPath, gitService, branchManager, pattern);
    },
    (issue) => {
      const openLabel = vscode.l10n.t("Open");
      void vscode.window
        .showInformationMessage(
          vscode.l10n.t("You were assigned to issue #{0}: {1}", issue.number, issue.title),
          openLabel,
        )
        .then((choice) => {
          if (choice === openLabel) {
            void vscode.commands.executeCommand("remoteProjectManager.openIssueFromTree", issue.id);
          }
        })
        .then(undefined, (error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "Failed to show assignment notification: {0}",
              error instanceof Error ? error.message : String(error),
            ),
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
          vscode.l10n.t("Your GitLab session expired. Reopening the panel to reconnect..."),
        );
        panel.dispose();
        void openPanel(context);
      });
    },
    {
      get: () => context.workspaceState.get<Record<string, unknown>>(UI_PREFS_KEY, {}),
      set: (prefs) => context.workspaceState.update(UI_PREFS_KEY, prefs),
    },
    () => {
      // "Reconnect" button: drop the stored token and reopen the panel so
      // the normal flow prompts for a fresh one.
      void credentialStore.setToken(providerKind, "").then(() => {
        panel.dispose();
        void openPanel(context);
      });
    },
    () => readIssueTemplates(folderPath),
    makeSettingsBridge(),
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
      vscode.l10n.t(
        "No GitHub/GitLab repository detected in this workspace. Set 'remoteProjectManager.repository' to 'owner/repo' manually.",
      ),
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
      if (message.type === "selectRepository") {
        void switchRepository(context, message.id);
        return;
      }
      void controller.handleMessage(message);
    });
    postRepositorySwitcher(panel, resolution.alternatives, resolution.folderPath);
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
      await rememberRepository(context, chosen.folderPath);
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
      activeRepositoryKey = repositoryKey({
        kind: "resolved",
        providerKind: chosen.provider,
        repository: chosen.repository,
        folderPath: chosen.folderPath,
      });
      postRepositorySwitcher(panel, candidates, chosen.folderPath);
      if (pendingAction) {
        if (pendingAction.kind !== "refresh") {
          void controller.handleMessage({ type: "requestState" });
        }
        applyPendingAction(panel, controller, pendingAction);
      } else {
        void controller.handleMessage({ type: "requestState" });
      }
      // The sidebar was empty while the choice was pending: let it follow.
      activeTreeProvider?.invalidateConnection();
    }
  });
}

/** Sets the `remoteProjectManager.multiRepo` context key that shows the sidebar's repository switcher. */
async function updateMultiRepositoryContext(): Promise<void> {
  const resolution = await resolveRepository();
  const multiple =
    resolution.kind === "candidates" ||
    (resolution.kind === "resolved" && (resolution.alternatives?.length ?? 0) > 1);
  await vscode.commands.executeCommand("setContext", "remoteProjectManager.multiRepo", multiple);
}

/** Tells the webview which repositories exist so it can show the persistent switcher. */
function postRepositorySwitcher(
  panel: vscode.WebviewPanel,
  alternatives: readonly RepositoryCandidate[] | undefined,
  selectedFolderPath: string | undefined,
): void {
  if (!alternatives || alternatives.length < 2 || !selectedFolderPath) {
    return;
  }
  void panel.webview.postMessage({
    type: "repositoryOptions",
    options: alternatives.map(toRepositoryOptionView),
    selectedId: selectedFolderPath,
  });
}

/** Remembers `folderPath` as the repository to use when several workspace folders qualify. */
async function rememberRepository(
  context: vscode.ExtensionContext,
  folderPath: string,
): Promise<void> {
  selectedRepositoryFolder = folderPath;
  await context.workspaceState.update(SELECTED_REPOSITORY_KEY, folderPath);
}

/**
 * Switches the whole extension (sidebar, status bar, panel, commands) to
 * another workspace repository and remembers the choice.
 */
async function switchRepository(
  context: vscode.ExtensionContext,
  folderPath: string,
): Promise<void> {
  await rememberRepository(context, folderPath);
  activeTreeProvider?.invalidateConnection();
  if (activeTreeProvider) {
    await syncWithRepository(context, activeTreeProvider);
  }
}

/** "Select Repository" command: pick among the workspace folders' repositories. */
async function selectRepository(context: vscode.ExtensionContext): Promise<void> {
  const resolution = await resolveRepository();
  const options =
    resolution.kind === "candidates"
      ? resolution.candidates
      : resolution.kind === "resolved"
        ? (resolution.alternatives ?? [])
        : [];
  if (options.length < 2) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("This workspace has only one repository."),
    );
    return;
  }
  const currentFolder = resolution.kind === "resolved" ? resolution.folderPath : undefined;
  const picked = await vscode.window.showQuickPick(
    options.map((candidate) => ({
      label: candidate.folderName,
      description: `${candidate.provider}:${candidate.repository}`,
      detail:
        candidate.folderPath === currentFolder ? vscode.l10n.t("Current repository") : undefined,
      candidate,
    })),
    { title: vscode.l10n.t("Select the repository to work with") },
  );
  if (picked) {
    await switchRepository(context, picked.candidate.folderPath);
  }
}

/** Localized title of a tree group. */
function describeGroup(status: MyIssueGroup["status"]): string {
  switch (status) {
    case "in-progress":
      return vscode.l10n.t("In progress");
    case "todo":
      return vscode.l10n.t("To do");
    case "blocked":
      return vscode.l10n.t("Blocked");
  }
}

/** Theme colour per priority rank (0 = critical .. 3 = low). */
const PRIORITY_COLORS = ["charts.red", "charts.orange", "charts.yellow", "charts.blue"] as const;

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
class MyIssuesTreeDataProvider implements vscode.TreeDataProvider<MyIssueSummary | MyIssueGroup> {
  private connection: { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined;
  private connectionKey: string | undefined;
  private lastFolderPath: string | undefined;
  private milestoneTitles = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly syncEmitter = new vscode.EventEmitter<{
    sync: SyncState;
    folderPath: string | undefined;
  }>();
  /** Fires with the connection state after every tree load, for the status bar. */
  readonly onDidSync = this.syncEmitter.event;
  private readonly countEmitter = new vscode.EventEmitter<number>();
  /** Fires with the number of open issues assigned to the user after every load. */
  readonly onDidChangeAssignedCount = this.countEmitter.event;

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

  /** The connection built by the last tree load, if any — never prompts or connects. */
  getEstablishedConnection():
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined {
    return this.connection;
  }

  /** Re-renders the tree (re-resolving the repository) without dropping a still-valid connection. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: MyIssueSummary | MyIssueGroup): vscode.TreeItem {
    if ("kind" in element) {
      const group = new vscode.TreeItem(
        `${describeGroup(element.status)} (${element.issues.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      // A stable id lets VS Code remember each group's collapsed state.
      group.id = `group:${element.status}`;
      group.contextValue = "issueGroup";
      group.iconPath = new vscode.ThemeIcon(
        element.status === "in-progress"
          ? "debug-start"
          : element.status === "blocked"
            ? "circle-slash"
            : "circle-large-outline",
      );
      return group;
    }
    const item = new vscode.TreeItem(
      `#${element.number} ${element.title}`,
      vscode.TreeItemCollapsibleState.None,
    );
    const milestoneTitle = element.milestoneId
      ? (this.milestoneTitles.get(element.milestoneId) ?? null)
      : null;
    const status = workStatusOf(element.labels);
    const priority = priorityOf(element.labels);
    item.id = element.id;
    item.description = buildIssueDescription(element, milestoneTitle, vscode.l10n.t);
    item.tooltip = new vscode.MarkdownString(
      buildIssueTooltip(element, milestoneTitle, vscode.l10n.t),
    );
    item.contextValue = "issue";
    item.iconPath = new vscode.ThemeIcon(
      status === "in-progress" ? "sync" : status === "blocked" ? "error" : "issues",
      priority ? new vscode.ThemeColor(PRIORITY_COLORS[priority.rank]) : undefined,
    );
    item.command = {
      command: "remoteProjectManager.openIssueFromTree",
      title: vscode.l10n.t("Open Issue"),
      arguments: [element.id],
    };
    return item;
  }

  async getChildren(
    element?: MyIssueSummary | MyIssueGroup,
  ): Promise<(MyIssueSummary | MyIssueGroup)[]> {
    if (element) {
      return "kind" in element ? element.issues : [];
    }
    let folderPath: string | undefined;
    try {
      this.syncEmitter.fire({ sync: { kind: "loading" }, folderPath: this.lastFolderPath });
      const connection = await this.getConnection();
      folderPath = this.lastFolderPath;
      if (!connection) {
        this.syncEmitter.fire({ sync: { kind: "unavailable" }, folderPath });
        return [];
      }
      const issues = await connection.provider.listIssues();
      this.syncEmitter.fire({
        sync: {
          kind: "ok",
          issues: issues.map(({ id, number, title }) => ({ id, number, title })),
        },
        folderPath,
      });
      const mine = selectMyOpenIssues(issues, connection.currentUser.username);
      this.countEmitter.fire(mine.length);
      await this.loadMilestoneTitles(connection.provider);
      return groupMyIssues(mine);
    } catch (error) {
      logger.warn(
        isAuthError(error) ? "Sidebar: authentication failed" : "Sidebar: could not load issues",
        error,
      );
      this.syncEmitter.fire({
        sync: { kind: isAuthError(error) ? "auth-error" : "unavailable" },
        folderPath: folderPath ?? this.lastFolderPath,
      });
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

  /** Milestone titles for the tree descriptions; best-effort, titles are a nicety. */
  private async loadMilestoneTitles(provider: IProjectProvider): Promise<void> {
    try {
      const milestones = await provider.listMilestones();
      this.milestoneTitles = new Map(
        milestones.map((milestone) => [milestone.id, milestone.title]),
      );
    } catch {
      this.milestoneTitles = new Map();
    }
  }

  private async getConnection(): Promise<
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined
  > {
    // Re-resolve every time (cheap local `git remote get-url`) so a
    // connection never outlives the repository it was built for.
    const resolution = await resolveRepository();
    this.lastFolderPath = resolution.kind === "resolved" ? resolution.folderPath : undefined;
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
  logger.info("Re-syncing with the loaded repository");
  treeDataProvider.refresh();
  void updateMultiRepositoryContext();
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
    vscode.l10n.t(
      "Signed out of GitLab. You'll be prompted for a new token next time the panel connects to a GitLab repository.",
    ),
  );
}

/** Display text for each Conventional Commits type, shown in the compose-commit QuickPick. */
function describeCommitType(type: CommitType): string {
  switch (type) {
    case "feat":
      return vscode.l10n.t("A new feature");
    case "fix":
      return vscode.l10n.t("A bug fix");
    case "docs":
      return vscode.l10n.t("Documentation only changes");
    case "style":
      return vscode.l10n.t("Formatting; no code meaning change");
    case "refactor":
      return vscode.l10n.t("Neither fixes a bug nor adds a feature");
    case "perf":
      return vscode.l10n.t("A performance improvement");
    case "test":
      return vscode.l10n.t("Adding or correcting tests");
    case "build":
      return vscode.l10n.t("Build system or external dependencies");
    case "ci":
      return vscode.l10n.t("CI configuration or scripts");
    case "chore":
      return vscode.l10n.t("Other changes (tooling, config, ...)");
    case "revert":
      return vscode.l10n.t("Reverts a previous commit");
  }
}

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
      title: vscode.l10n.t("Pick a Gitmoji"),
      placeHolder: vscode.l10n.t("Search by code or description"),
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
async function composeCommit(
  context: vscode.ExtensionContext,
  scm?: { readonly rootUri?: vscode.Uri },
): Promise<void> {
  // The Source Control title button passes the clicked repository, so in a
  // multi-root workspace the message lands in that repository's input box.
  const cwd =
    scm?.rootUri?.fsPath ?? activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }

  const gitService = new SimpleGitService();
  let currentBranch: string | null = null;
  let stagedFiles: string[] = [];
  try {
    currentBranch = await gitService.getCurrentBranch(cwd);
    stagedFiles = await gitService.getStagedFiles(cwd);
  } catch {
    // No git repo / no commits yet — proceed without suggestions.
  }
  const suggestedType = suggestCommitType(stagedFiles, currentBranch);
  const suggestedScope = suggestCommitScope(stagedFiles);

  // The suggested type is listed first and flagged, but stays a plain
  // choice: the user can always pick another one.
  const orderedTypes = suggestedType
    ? [suggestedType, ...COMMIT_TYPES.filter((type) => type !== suggestedType)]
    : [...COMMIT_TYPES];
  const typePick = await vscode.window.showQuickPick(
    orderedTypes.map((type) => ({
      label: type,
      description:
        type === suggestedType
          ? vscode.l10n.t("{0} (suggested from staged files)", describeCommitType(type))
          : describeCommitType(type),
    })),
    {
      title: vscode.l10n.t("Commit type"),
      placeHolder: vscode.l10n.t("Conventional Commits type"),
    },
  );
  if (!typePick) {
    return;
  }

  const scope = await vscode.window.showInputBox({
    title: vscode.l10n.t("Scope (optional)"),
    prompt: vscode.l10n.t("e.g. 'commits', 'ui' — leave empty for none"),
    value: suggestedScope,
  });
  if (scope === undefined) {
    return;
  }

  const gitmoji = await showGitmojiPicker(context);
  if (!gitmoji) {
    return;
  }

  const description = await vscode.window.showInputBox({
    title: vscode.l10n.t("Description"),
    prompt: vscode.l10n.t("Short, imperative description of the change"),
    validateInput: (value) => (value.trim() ? undefined : "Description is required."),
  });
  if (!description) {
    return;
  }

  const branchIssueNumber =
    currentBranch === null ? null : extractIssueNumberFromBranch(currentBranch);
  let issueNumber: number | undefined = branchIssueNumber ?? undefined;

  if (issueNumber === undefined) {
    const manual = await vscode.window.showInputBox({
      title: vscode.l10n.t("Issue number (optional)"),
      prompt: vscode.l10n.t("Leave empty for no issue reference"),
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
          description: vscode.l10n.t("Closes the issue on merge to the default branch"),
          refKind: "fixes" as const,
        },
        {
          label: `Refs #${issueNumber}`,
          description: vscode.l10n.t("References the issue without closing it"),
          refKind: "refs" as const,
        },
        { label: vscode.l10n.t("No issue reference"), refKind: "none" as const },
      ],
      { title: vscode.l10n.t("Link this commit to issue #{0}?", issueNumber) },
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
      vscode.l10n.t("Commit message ready in the Source Control input box."),
    );
  } else {
    await vscode.env.clipboard.writeText(message);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Commit message copied to clipboard (Git extension not available)."),
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
    vscode.l10n.t("Copied {0} {1} to clipboard.", gitmoji.emoji, gitmoji.code),
  );
}

/** The most recently copied issue context, exposed via this extension's API (see {@link activate}) for other extensions/agents. */
let lastIssueContext: string | undefined;

/** Copies the active issue's context (#57) to the clipboard for pasting into an AI coding assistant. */
async function copyIssueContext(
  context: vscode.ExtensionContext,
  element?: MyIssueSummary,
): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
      ),
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();

  let issue = element
    ? await provider.getIssue(element.id)
    : await resolveActiveIssueViaBranch(gitService, cwd, provider);
  if (!issue) {
    const issues = await provider.listIssues();
    const picked = await vscode.window.showQuickPick(
      issues.map((candidate) => ({
        label: `#${candidate.number} ${candidate.title}`,
        issue: candidate,
      })),
      {
        title: vscode.l10n.t("Copy context for which issue?"),
        placeHolder: vscode.l10n.t("Type to filter"),
      },
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
  void vscode.window.showInformationMessage(
    vscode.l10n.t("Copied issue #{0} context to clipboard.", issue.number),
  );
}

/**
 * Multi-select QuickPick over a provider-supplied list, with `preselected`
 * entries ticked. Best-effort: a failing or empty list yields `[]` rather
 * than blocking the flow; cancelling the picker also yields `[]`.
 */
async function pickMany(
  title: string,
  load: () => Promise<readonly string[]>,
  preselected: readonly string[],
): Promise<string[]> {
  let options: readonly string[];
  try {
    options = await load();
  } catch {
    return [];
  }
  if (options.length === 0) {
    return [];
  }
  const picked = await vscode.window.showQuickPick(
    options.map((option) => ({ label: option, picked: preselected.includes(option) })),
    { title, canPickMany: true },
  );
  return picked?.map((item) => item.label) ?? [];
}

/** Generates a PR/MR pre-filled from the active issue, its commits, and its milestone (#58). */
async function createPrFromIssue(
  context: vscode.ExtensionContext,
  element?: MyIssueSummary,
): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
      ),
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();

  const issue = element
    ? await provider.getIssue(element.id)
    : await resolveActiveIssueViaBranch(gitService, cwd, provider);
  if (!issue) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not determine which issue this branch is for. Rename the branch to include the issue number (e.g. 'fix/53-description').",
      ),
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
      vscode.l10n.t(
        "Could not resolve branches or commits: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }

  if (element && extractIssueNumberFromBranch(currentBranch) !== issue.number) {
    const continueLabel = vscode.l10n.t("Continue");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "The current branch '{0}' does not reference issue #{1}. Create the PR from it anyway?",
        currentBranch,
        issue.number,
      ),
      continueLabel,
    );
    if (choice !== continueLabel) {
      return;
    }
  }

  const suggestedTitle = buildConventionalPrTitle(issue, commits);
  const body = buildPrBody(issue, milestone, commits);

  const resolution = await resolveRepository();
  if (resolution.kind !== "resolved") {
    await vscode.env.clipboard.writeText(body);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Could not resolve the repository URL; PR body copied to clipboard instead."),
    );
    return;
  }

  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("Pull request title"),
    prompt: vscode.l10n.t(
      "Generated from the branch's commits (Conventional Commits). Edit if needed.",
    ),
    value: suggestedTitle,
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t("Title is required.")),
  });
  if (title === undefined) {
    return;
  }

  const stateChoice = await vscode.window.showQuickPick(
    [
      { label: vscode.l10n.t("Ready for review"), draft: false },
      {
        label: vscode.l10n.t("Draft"),
        description: vscode.l10n.t("Not ready to be merged yet"),
        draft: true,
      },
    ],
    { title: vscode.l10n.t("Create the pull request as") },
  );
  if (!stateChoice) {
    return;
  }

  // GitLab's merge-request form only accepts reviewer/label *ids*, so the
  // pickers are GitHub-only; the provider lists are best-effort.
  let reviewers: string[] = [];
  let labels: string[] = [];
  if (resolution.providerKind === "github") {
    reviewers = await pickMany(
      vscode.l10n.t("Request review from (optional)"),
      () => provider.listAssignableUsers(),
      [],
    );
    labels = await pickMany(
      vscode.l10n.t("Labels (optional)"),
      () => provider.listLabels(),
      issue.labels,
    );
  }

  const gitlabHost =
    vscode.workspace.getConfiguration("remoteProjectManager").get<string>("gitlabHost", "") ||
    undefined;
  const url = buildCompareUrl({
    providerKind: resolution.providerKind,
    repository: resolution.repository,
    baseBranch: defaultBranch,
    headBranch: currentBranch,
    title: title.trim(),
    body,
    gitlabHost,
    draft: stateChoice.draft,
    reviewers,
    labels,
  });
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Shows the semantic Git Graph (#59): commits grouped by referenced issue, browsable via QuickPick. */
function showGitGraph(context: vscode.ExtensionContext): void {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }
  openGitGraph(context, cwd, () => activeProvider);
}

/** Lints recent commit history against the Gitmoji/Conventional Commit convention (#60), never rewriting history. */
async function lintCommitHistory(): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }
  const gitService = new SimpleGitService();
  let log;
  try {
    log = await gitService.log(cwd, "-100");
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not read git log: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }
  const commits: CommitRef[] = log.map((entry) => ({ hash: entry.hash, message: entry.message }));
  const results = lintCommits(commits);
  const violations = results.filter((result) => !result.valid);

  if (violations.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "All checked commits (last 100) comply with the Gitmoji/Conventional Commit convention.",
      ),
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
      title: vscode.l10n.t("{0} non-compliant commit(s) in the last 100", violations.length),
      placeHolder: vscode.l10n.t(
        "Pick one to copy its suggested message (never applied automatically)",
      ),
    },
  );
  if (!picked?.violation.suggestion) {
    return;
  }

  await vscode.env.clipboard.writeText(picked.violation.suggestion);
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Copied suggested message for {0} to clipboard.",
      picked.violation.hash.slice(0, 7),
    ),
  );
}

/** Exports the active milestone's context to a configurable Markdown file for AI agents (#61), idempotently. */
async function exportMilestoneContext(context: vscode.ExtensionContext): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
      ),
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
      { title: vscode.l10n.t("Export context for which milestone?") },
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

  const { targets, rejected } = readAiContextTargets();
  for (const path of rejected) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "'remoteProjectManager.aiContextFile' (\"{0}\") escapes the workspace folder and was rejected.",
        path,
      ),
    );
  }
  if (targets.length === 0) {
    return;
  }
  await writeContextFiles(cwd, block, targets);
  await trackExportedContext(context, {
    milestoneId: resolvedMilestone.id,
    digest: digestContext(block),
  });

  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Exported milestone context to {0}.",
      targets.map((target) => target.displayPath).join(", "),
    ),
  );
}

function readExtensionVersion(context: vscode.ExtensionContext): string {
  const { version } = context.extension.packageJSON as { version?: unknown };
  return typeof version === "string" ? version : "unknown";
}

/** Reads a file as UTF-8, or `undefined` when it does not exist. */
async function readTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Installs the commit-msg hook (#85) that runs the commit convention check locally. */
async function installCommitMsgHook(): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }
  try {
    const hooksDir = vscode.Uri.file(await new SimpleGitService().getHooksPath(cwd));
    const hookUri = vscode.Uri.joinPath(hooksDir, "commit-msg");
    const existing = await readTextIfExists(hookUri);
    if (classifyExistingHook(existing) === "foreign") {
      const replaceLabel = vscode.l10n.t("Replace");
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "A commit-msg hook already exists. Replace it? The current one is kept as commit-msg.backup.",
        ),
        { modal: true },
        replaceLabel,
      );
      if (choice !== replaceLabel) {
        return;
      }
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(hooksDir, "commit-msg.backup"),
        Buffer.from(existing ?? "", "utf8"),
      );
    }
    await vscode.workspace.fs.createDirectory(hooksDir);
    await vscode.workspace.fs.writeFile(hookUri, Buffer.from(buildCommitMsgHookScript(), "utf8"));
    await fs.chmod(hookUri.fsPath, 0o755);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Commit message hook installed in {0}.", hookUri.fsPath),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not install the commit message hook: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/** Removes the hook written by {@link installCommitMsgHook}, restoring a backed-up one. */
async function uninstallCommitMsgHook(): Promise<void> {
  const cwd = activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }
  try {
    const hooksDir = vscode.Uri.file(await new SimpleGitService().getHooksPath(cwd));
    const hookUri = vscode.Uri.joinPath(hooksDir, "commit-msg");
    const kind = classifyExistingHook(await readTextIfExists(hookUri));
    if (kind !== "managed") {
      void vscode.window.showInformationMessage(
        kind === "none"
          ? vscode.l10n.t("No commit-msg hook is installed.")
          : vscode.l10n.t(
              "The existing commit-msg hook was not installed by this extension; leaving it alone.",
            ),
      );
      return;
    }
    await vscode.workspace.fs.delete(hookUri);
    const backupUri = vscode.Uri.joinPath(hooksDir, "commit-msg.backup");
    const backup = await readTextIfExists(backupUri);
    if (backup !== undefined) {
      await vscode.workspace.fs.writeFile(hookUri, Buffer.from(backup, "utf8"));
      await fs.chmod(hookUri.fsPath, 0o755);
      await vscode.workspace.fs.delete(backupUri);
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("Commit message hook removed."));
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not remove the commit message hook: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

/**
 * "Run diagnostics" (#82): probes the remote detection, the stored token
 * and (only when a token already exists, so no prompt is ever raised) the
 * connection and its capabilities, then shows the report in the output
 * channel and offers to copy it.
 */
async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const resolution = await resolveRepository();
  const input: {
    -readonly [K in keyof DiagnosticsInput]: DiagnosticsInput[K];
  } = {
    extensionVersion: readExtensionVersion(context),
    vscodeVersion: vscode.version,
    resolution,
    tokenStored: false,
  };

  if (resolution.kind === "resolved") {
    input.tokenProvider = resolution.providerKind;
    const token = await context.secrets.get(secretKeyFor(resolution.providerKind));
    input.tokenStored = Boolean(token);
    if (token) {
      try {
        const config = vscode.workspace.getConfiguration("remoteProjectManager");
        const { provider, currentUser } = await connectProvider(
          resolution.providerKind,
          resolution.repository,
          token,
          config.get<number>("cacheTtlSeconds", 180),
          config.get<string>("gitlabHost", "") || undefined,
        );
        input.connection = {
          ok: true,
          username: currentUser.username,
          capabilities: await provider.getCapabilities({ forceRefresh: true }),
        };
      } catch (error) {
        input.connection = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const report = formatDiagnosticsReport(input);
  logger.info(`\n${report}`);
  logger.show();
  const copyLabel = vscode.l10n.t("Copy report");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t("Diagnostics written to the 'Remote Project Manager' output channel."),
    copyLabel,
  );
  if (choice === copyLabel) {
    await vscode.env.clipboard.writeText(report);
  }
}

/** Tree action (#80): creates and switches to a branch for the clicked issue. */
async function createBranchForTreeIssue(
  context: vscode.ExtensionContext,
  element: MyIssueSummary,
): Promise<void> {
  const connection = await getActiveConnection(context);
  if (!connection) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
      ),
    );
    return;
  }
  const { provider, cwd } = connection;
  const gitService = new SimpleGitService();
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const pattern = config.get<string>("branchNamePattern", "") || undefined;
  try {
    const issue = await provider.getIssue(element.id);
    const message = await requestCreateBranch(
      issue,
      cwd,
      gitService,
      new BranchManager(gitService),
      pattern,
    );
    if (message) {
      void vscode.window.showInformationMessage(message);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : `Could not create branch: ${String(error)}`,
    );
  }
}

/**
 * Periodically refreshes the sidebar (and the open panel) so assigned
 * issues and the activity-bar badge stay current without a manual
 * Refresh. Polls only while the window is focused, catches up as soon as
 * focus returns, and goes through the normal TTL cache, so the interval
 * is also bounded below by `cacheTtlSeconds`.
 */
function startAutoRefresh(treeDataProvider: MyIssuesTreeDataProvider): vscode.Disposable {
  let lastRunAt = Date.now();
  const tick = (): void => {
    const intervalSeconds = normalizePollInterval(
      vscode.workspace.getConfiguration("remoteProjectManager").get<number>("autoRefreshSeconds"),
    );
    const now = Date.now();
    if (
      !isPollDue({ intervalSeconds, windowFocused: vscode.window.state.focused, lastRunAt, now })
    ) {
      return;
    }
    lastRunAt = now;
    treeDataProvider.refresh();
    void activeController?.handleMessage({ type: "requestState" });
  };
  // Finer than any allowed interval, so a due poll is never late by much.
  const timer = setInterval(tick, 15_000);
  const focusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      tick();
    }
  });
  return new vscode.Disposable(() => {
    clearInterval(timer);
    focusListener.dispose();
  });
}

/** API this extension exposes to other extensions (e.g. AI agents) via `extensions.getExtension(...).exports`. */
export interface RemoteProjectManagerApi {
  /** The Markdown context block from the last "Copy Issue Context for AI" invocation, if any. */
  getActiveIssueContext(): string | undefined;
}

export function activate(context: vscode.ExtensionContext): RemoteProjectManagerApi {
  selectedRepositoryFolder = context.workspaceState.get<string>(SELECTED_REPOSITORY_KEY);
  const treeDataProvider = new MyIssuesTreeDataProvider(context);
  activeTreeProvider = treeDataProvider;
  const statusBar = new IssueStatusBar();
  logger.info("Remote Project Manager activated");
  const editorIntegration = registerEditorIntegration(context, {
    getEstablishedConnection: () => treeDataProvider.getEstablishedConnection(),
    getActiveConnection: () => getActiveConnection(context),
    resolveRepository,
    refreshTree: () => treeDataProvider.refresh(),
  });
  const treeView = vscode.window.createTreeView("remoteProjectManager.sidebar", {
    treeDataProvider,
  });
  const aiContextSync = new AiContextSync(
    context,
    () => treeDataProvider.getEstablishedConnection()?.provider,
  );
  const stateSync = new StateSync(
    context,
    () => treeDataProvider.getEstablishedConnection(),
    () => treeDataProvider.refresh(),
  );
  context.subscriptions.push(
    statusBar,
    stateSync,
    new vscode.Disposable(() => logger.dispose()),
    treeDataProvider.onDidSync(({ sync, folderPath }) => {
      statusBar.update(sync, folderPath);
      if (sync.kind === "ok") {
        editorIntegration.refresh();
        stateSync.onSynced(folderPath);
        void aiContextSync.onSynced(folderPath);
      }
    }),
  );
  registerRepositorySync(context, treeDataProvider);
  // Opening a folder ("Open Folder", "Open Recent") restarts the extension
  // host, so activation is the sync point for the newly loaded project.
  void syncWithRepository(context, treeDataProvider);
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
    vscode.commands.registerCommand("remoteProjectManager.installCommitMsgHook", () => {
      void installCommitMsgHook();
    }),
    vscode.commands.registerCommand("remoteProjectManager.uninstallCommitMsgHook", () => {
      void uninstallCommitMsgHook();
    }),
    vscode.commands.registerCommand("remoteProjectManager.openWalkthrough", () => {
      // The id is built from the manifest rather than hard-coded, so it survives a publisher rename.
      void vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        `${context.extension.id}#getStarted`,
        false,
      );
    }),
    vscode.commands.registerCommand("remoteProjectManager.selectRepository", () => {
      void selectRepository(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.runDiagnostics", () => {
      void runDiagnostics(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.refresh", () => {
      void openPanel(context, { kind: "refresh" });
    }),
    vscode.commands.registerCommand(
      "remoteProjectManager.composeCommit",
      (scm?: { readonly rootUri?: vscode.Uri }) => {
        void composeCommit(context, scm);
      },
    ),
    vscode.commands.registerCommand("remoteProjectManager.pickGitmoji", () => {
      void pickGitmojiCommand(context);
    }),
    vscode.commands.registerCommand(
      "remoteProjectManager.copyIssueContext",
      (element?: MyIssueSummary) => {
        void copyIssueContext(context, element);
      },
    ),
    vscode.commands.registerCommand(
      "remoteProjectManager.createPrFromIssue",
      (element?: MyIssueSummary) => {
        void createPrFromIssue(context, element);
      },
    ),
    vscode.commands.registerCommand(
      "remoteProjectManager.createBranchForIssue",
      (element: MyIssueSummary) => {
        void createBranchForTreeIssue(context, element);
      },
    ),
    vscode.commands.registerCommand(
      "remoteProjectManager.openIssueInBrowser",
      (element: MyIssueSummary) => {
        void vscode.env.openExternal(vscode.Uri.parse(element.url));
      },
    ),
    vscode.commands.registerCommand("remoteProjectManager.showGitGraph", () => {
      showGitGraph(context);
    }),
    vscode.commands.registerCommand("remoteProjectManager.lintCommitHistory", () => {
      void lintCommitHistory();
    }),
    vscode.commands.registerCommand("remoteProjectManager.exportMilestoneContext", () => {
      void exportMilestoneContext(context);
    }),
    treeView,
    treeDataProvider.onDidChangeAssignedCount((count) => {
      treeView.badge = count > 0 ? describeAssignedBadge(count) : undefined;
    }),
    startAutoRefresh(treeDataProvider),
  );

  return {
    getActiveIssueContext: () => lastIssueContext,
  };
}

export function deactivate(): void {
  // No cleanup required: webview panels and subscriptions are disposed
  // by VS Code when the extension host shuts down.
}
