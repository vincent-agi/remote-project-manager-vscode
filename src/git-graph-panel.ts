import * as vscode from "vscode";
import { extractIssueNumberFromCommitMessage } from "./core/git/commit-issue-ref";
import type { IProjectProvider } from "./core/providers/project-provider.interface";
import { SimpleGitService } from "./providers/git/simple-git.service";
import { getGitGraphHtml } from "./webview/webview-html";
import { logger } from "./logger";

/** How many commits the graph loads. */
const GRAPH_COMMIT_LIMIT = 300;
/** Git's well-known empty tree, the left side of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface GraphCommitView {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly date: string;
  readonly refs: readonly string[];
  readonly subject: string;
  readonly issueNumber: number | null;
}

type GraphInboundMessage =
  | { readonly type: "requestGraph" }
  | { readonly type: "openDiff"; readonly hash: string }
  | { readonly type: "copyHash"; readonly hash: string };

/** Shape of the built-in `vscode.git` API this panel uses for native diffs. */
interface GitDiffApi {
  readonly repositories: readonly {
    readonly rootUri: vscode.Uri;
    diffBetween(
      ref1: string,
      ref2: string,
    ): Promise<readonly { uri: vscode.Uri; originalUri: vscode.Uri }[]>;
  }[];
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

async function getGitApi(): Promise<GitDiffApi | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitDiffApi }>(
    "vscode.git",
  );
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
}

/** Opens the commit's changes in VS Code's multi-file diff editor, or as a patch as a fallback. */
async function openCommitDiff(
  gitService: SimpleGitService,
  cwd: string,
  commit: GraphCommitView,
): Promise<void> {
  const title = `${commit.hash.slice(0, 7)}: ${commit.subject}`;
  try {
    const api = await getGitApi();
    const repository = api?.repositories.find((candidate) => candidate.rootUri.fsPath === cwd);
    if (api && repository) {
      const parent = commit.parents[0] ?? EMPTY_TREE;
      const changes = await repository.diffBetween(parent, commit.hash);
      if (changes.length > 0) {
        await vscode.commands.executeCommand(
          "vscode.changes",
          title,
          changes.map((change) => [
            change.uri,
            api.toGitUri(change.originalUri, parent),
            api.toGitUri(change.uri, commit.hash),
          ]),
        );
        return;
      }
    }
  } catch (error) {
    logger.warn("Native diff unavailable, falling back to a patch", error);
  }
  const patch = await gitService.getCommitPatch(cwd, commit.hash);
  const document = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
  await vscode.window.showTextDocument(document, { preview: true });
}

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Opens (or reveals) the interactive Git Graph: every branch's recent
 * commits laid out as a graph, filterable by issue, with a click opening
 * the commit's diff in the native editor.
 */
export function openGitGraph(
  context: vscode.ExtensionContext,
  cwd: string,
  getProvider: () => IProjectProvider | undefined,
): void {
  if (currentPanel) {
    currentPanel.reveal();
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    "remoteProjectManager.gitGraph",
    "Git Graph",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview-ui"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
      ],
    },
  );
  currentPanel = panel;
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  panel.webview.html = getGitGraphHtml(panel.webview, context.extensionUri);
  panel.onDidDispose(() => {
    currentPanel = undefined;
  });

  const gitService = new SimpleGitService();
  let commits: GraphCommitView[] = [];

  const sendGraph = async (): Promise<void> => {
    try {
      const [log, currentBranch] = await Promise.all([
        gitService.getGraphLog(cwd, GRAPH_COMMIT_LIMIT),
        gitService.getCurrentBranch(cwd).catch(() => null),
      ]);
      commits = log.map((entry) => ({
        hash: entry.hash,
        parents: entry.parents,
        author: entry.author,
        date: entry.date,
        refs: entry.refs,
        subject: entry.message.split("\n")[0] ?? "",
        issueNumber: extractIssueNumberFromCommitMessage(entry.message),
      }));
      let issues: { number: number; title: string }[] = [];
      try {
        issues = ((await getProvider()?.listIssues()) ?? []).map(({ number, title }) => ({
          number,
          title,
        }));
      } catch {
        // Titles are a nicety; the graph works without them.
      }
      void panel.webview.postMessage({
        type: "graph",
        commits,
        issues,
        head: currentBranch,
      });
    } catch (error) {
      void panel.webview.postMessage({
        type: "error",
        message: `Could not read git history: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  panel.webview.onDidReceiveMessage((message: GraphInboundMessage) => {
    switch (message.type) {
      case "requestGraph":
        void sendGraph();
        return;
      case "openDiff": {
        const commit = commits.find((candidate) => candidate.hash === message.hash);
        if (commit) {
          void openCommitDiff(gitService, cwd, commit).catch((error: unknown) => {
            void vscode.window.showErrorMessage(
              `Could not open the diff: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
        return;
      }
      case "copyHash":
        void vscode.env.clipboard.writeText(message.hash).then(() => {
          void vscode.window.showInformationMessage(`Copied ${message.hash.slice(0, 7)}.`);
        });
        return;
    }
  });
}
