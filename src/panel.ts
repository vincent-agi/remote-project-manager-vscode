/** The central webview panel: creation, controller wiring (templates, settings, preferences), and the open/reveal lifecycle. */
import * as vscode from "vscode";
import { isAuthError } from "./core/auth/is-auth-error";
import type { ProviderKind } from "./core/models/issue.model";
import { SimpleGitService } from "./providers/git/simple-git.service";
import { repositoryKey, type RepositoryCandidate } from "./core/workspace/repository-resolver";
import { generateBranchName } from "./core/automation/branch-name";
import { shouldAutoCreateBranch } from "./core/automation/auto-branch-guard";
import { BranchManager } from "./core/git/branch-manager";
import { PanelController } from "./webview/panel-controller";
import type { InboundMessage } from "./webview/messages";
import { getWebviewHtml } from "./webview/webview-html";
import { describeBranchPatternWarning, previewBranchPattern } from "./core/settings/branch-pattern";
import {
  buildSettingEntries,
  findSettingDescriptor,
  validateSettingValue,
} from "./core/settings/settings-schema";
import type { SettingsBridge } from "./webview/panel-controller";
import { parseIssueTemplate, type IssueTemplate } from "./core/templates/issue-template";
import { connectRepository, makeCredentialStore } from "./connection";
import {
  rememberRepository,
  resolveRepository,
  switchRepository,
  toRepositoryOptionView,
} from "./repository";
import {
  promptDirtyWorkingTree,
  reportBranchCreationOutcome,
  requestCreateBranch,
} from "./branch-flow";
import { state } from "./state";

/** `workspaceState` key holding the panel's UI preferences (saved filters, sort order, ...). */
const UI_PREFS_KEY = "remoteProjectManager.uiPrefs";

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
  state.activeFolderPath = folderPath;
  state.activeProvider = provider;
  state.activeProviderKind = providerKind;

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

export async function openPanel(
  context: vscode.ExtensionContext,
  pendingAction?: PendingPanelAction,
): Promise<void> {
  if (state.openPanelInFlight) {
    await state.openPanelInFlight;
    return openPanel(context, pendingAction);
  }
  const run = openPanelImpl(context, pendingAction);
  state.openPanelInFlight = run.finally(() => {
    state.openPanelInFlight = undefined;
  });
  return run;
}

async function openPanelImpl(
  context: vscode.ExtensionContext,
  pendingAction?: PendingPanelAction,
): Promise<void> {
  if (state.activePanel && state.activeController) {
    state.activePanel.reveal();
    if (pendingAction) {
      applyPendingAction(state.activePanel, state.activeController, pendingAction);
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
  state.activePanel = panel;
  state.activeRepositoryKey = repositoryKey(resolution);
  panel.onDidDispose(() => {
    if (state.activePanel === panel) {
      state.activePanel = undefined;
      state.activeRepositoryKey = undefined;
      state.activeController = undefined;
      state.activeFolderPath = undefined;
      state.activeProvider = undefined;
      state.activeProviderKind = undefined;
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
    state.activeController = controller;
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
      state.activeController = controller;
      state.activeRepositoryKey = repositoryKey({
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
      state.activeTreeProvider?.invalidateConnection();
    }
  });
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
