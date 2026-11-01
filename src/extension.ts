import * as vscode from "vscode";
import { type MyIssueSummary } from "./core/tree/my-issues";
import { IssueStatusBar } from "./status-bar";
import { StateSync } from "./state-sync";
import { AiContextSync } from "./ai-context-files";
import { describeAssignedBadge } from "./core/polling/poll-schedule";
import { registerEditorIntegration } from "./editor-integration";
import { logger } from "./logger";
import {
  SELECTED_REPOSITORY_KEY,
  registerRepositorySync,
  resolveRepository,
  selectRepository,
  syncWithRepository,
} from "./repository";
import { openPanel } from "./panel";
import { MyIssuesTreeDataProvider, startAutoRefresh } from "./tree-view";
import {
  createBranchForTreeIssue,
  installCommitMsgHook,
  lintCommitHistory,
  runDiagnostics,
  showGitGraph,
  signOutGitLab,
  uninstallCommitMsgHook,
} from "./commands/maintenance";
import { getActiveConnection } from "./connection";
import { composeCommit, pickGitmojiCommand } from "./commands/commit";
import { copyIssueContext, exportMilestoneContext } from "./commands/issue-context";
import { createPrFromIssue } from "./commands/pull-request";
import { state } from "./state";

/** API this extension exposes to other extensions (e.g. AI agents) via `extensions.getExtension(...).exports`. */
export interface RemoteProjectManagerApi {
  /** The Markdown context block from the last "Copy Issue Context for AI" invocation, if any. */
  getActiveIssueContext(): string | undefined;
}

export function activate(context: vscode.ExtensionContext): RemoteProjectManagerApi {
  state.selectedRepositoryFolder = context.workspaceState.get<string>(SELECTED_REPOSITORY_KEY);
  const treeDataProvider = new MyIssuesTreeDataProvider(context);
  state.activeTreeProvider = treeDataProvider;
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
    getActiveIssueContext: () => state.lastIssueContext,
  };
}

export function deactivate(): void {
  // No cleanup required: webview panels and subscriptions are disposed
  // by VS Code when the extension host shuts down.
}
