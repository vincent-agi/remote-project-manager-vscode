import * as path from "node:path";
import * as vscode from "vscode";
import { SimpleGitService } from "./providers/git/simple-git.service";
import { scanTodos } from "./core/editor/todo-scan";
import { buildIssueDraft, buildPermalink } from "./core/editor/issue-from-code";
import type { IIssue } from "./core/models/issue.model";
import type {
  IAuthenticatedUser,
  IProjectProvider,
} from "./core/providers/project-provider.interface";
import type { RepositoryResolution } from "./core/workspace/repository-resolver";
import { logger } from "./logger";

export interface EditorIntegrationDeps {
  /** The connection the sidebar already holds — never prompts. */
  getEstablishedConnection():
    { provider: IProjectProvider; currentUser: IAuthenticatedUser } | undefined;
  /** A connection for user-initiated actions; may prompt for a token. */
  getActiveConnection(): Promise<{ provider: IProjectProvider; cwd: string } | null>;
  resolveRepository(): Promise<RepositoryResolution>;
  refreshTree(): void;
}

const TODO_LANGUAGE_SELECTOR: vscode.DocumentSelector = { scheme: "file" };
/** Lines of context kept around a TODO when it becomes an issue. */
const TODO_CONTEXT_LINES = 2;

function todoLensEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("remoteProjectManager")
    .get<boolean>("todoCodeLens", true);
}

function documentLines(document: vscode.TextDocument): string[] {
  return Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
}

function openIssueByNumberCommandUri(issueNumber: number): vscode.Uri {
  return vscode.Uri.parse(
    `command:remoteProjectManager.openIssueByNumber?${encodeURIComponent(JSON.stringify([issueNumber]))}`,
  );
}

/** CodeLens above each TODO/FIXME: the linked issue, or "Create issue". */
class TodoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly deps: EditorIntegrationDeps) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!todoLensEnabled()) {
      return [];
    }
    const markers = scanTodos(documentLines(document));
    if (markers.length === 0) {
      return [];
    }
    let issues: readonly IIssue[] = [];
    if (markers.some((marker) => marker.issueNumber !== null)) {
      try {
        issues = (await this.deps.getEstablishedConnection()?.provider.listIssues()) ?? [];
      } catch {
        // Titles are a nicety; fall back to the bare "#N" label.
      }
    }
    return markers.map((marker) => {
      const range = new vscode.Range(marker.line, 0, marker.line, 0);
      if (marker.issueNumber === null) {
        return new vscode.CodeLens(range, {
          title: vscode.l10n.t("$(add) Create issue from TODO"),
          command: "remoteProjectManager.createIssueFromTodo",
          arguments: [document.uri, marker.line],
        });
      }
      const issue = issues.find((candidate) => candidate.number === marker.issueNumber);
      return new vscode.CodeLens(range, {
        title: vscode.l10n.t(
          "$(issues) #{0}{1}{2}",
          marker.issueNumber,
          issue ? ` ${issue.title}` : "",
          issue?.state === "closed" ? vscode.l10n.t(" (closed)") : "",
        ),
        command: "remoteProjectManager.openIssueByNumber",
        arguments: [marker.issueNumber],
      });
    });
  }
}

/** Turns the `#N` in `TODO #N` into a clickable link. */
class TodoLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (!todoLensEnabled()) {
      return [];
    }
    return scanTodos(documentLines(document)).flatMap((marker) => {
      if (
        marker.issueNumber === null ||
        marker.referenceStart === undefined ||
        marker.referenceEnd === undefined
      ) {
        return [];
      }
      const link = new vscode.DocumentLink(
        new vscode.Range(marker.line, marker.referenceStart, marker.line, marker.referenceEnd),
        openIssueByNumberCommandUri(marker.issueNumber),
      );
      link.tooltip = vscode.l10n.t("Open issue #{0}", marker.issueNumber);
      return [link];
    });
  }
}

/** Opens issue `issueNumber` in the panel, or just the panel when it cannot be looked up. */
async function openIssueByNumber(deps: EditorIntegrationDeps, issueNumber: number): Promise<void> {
  try {
    const issues = await deps.getEstablishedConnection()?.provider.listIssues();
    const issue = issues?.find((candidate) => candidate.number === issueNumber);
    if (issue) {
      await vscode.commands.executeCommand("remoteProjectManager.openIssueFromTree", issue.id);
      return;
    }
    if (issues) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Issue #{0} was not found on the remote.", issueNumber),
      );
      return;
    }
  } catch (error) {
    logger.warn(`Could not look up issue #${issueNumber}`, error);
  }
  await vscode.commands.executeCommand("remoteProjectManager.openPanel");
}

interface CodeIssueRequest {
  readonly uri: vscode.Uri;
  /** One-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly languageId: string;
  readonly snippet: string;
  readonly title: string;
}

/** Best-effort permalink to the code at HEAD; `undefined` when it cannot be built. */
async function resolvePermalink(
  deps: EditorIntegrationDeps,
  request: CodeIssueRequest,
): Promise<{ permalink?: string; relativePath: string }> {
  const fallback = vscode.workspace.asRelativePath(request.uri, false).split(path.sep).join("/");
  try {
    const resolution = await deps.resolveRepository();
    if (resolution.kind !== "resolved" || !resolution.folderPath) {
      return { relativePath: fallback };
    }
    const gitService = new SimpleGitService();
    const root = await gitService.getRepoRoot(resolution.folderPath);
    const relativePath = path.relative(root, request.uri.fsPath).split(path.sep).join("/");
    if (relativePath.startsWith("..")) {
      return { relativePath: fallback };
    }
    const gitlabHost =
      vscode.workspace.getConfiguration("remoteProjectManager").get<string>("gitlabHost", "") ||
      undefined;
    return {
      relativePath,
      permalink: buildPermalink({
        providerKind: resolution.providerKind,
        repository: resolution.repository,
        gitlabHost,
        sha: await gitService.getHeadSha(resolution.folderPath),
        path: relativePath,
        startLine: request.startLine,
        endLine: request.endLine,
      }),
    };
  } catch (error) {
    logger.warn("Could not build a permalink", error);
    return { relativePath: fallback };
  }
}

/** Creates an issue describing a piece of code and offers to open it. */
async function createIssueFromCode(
  deps: EditorIntegrationDeps,
  request: CodeIssueRequest,
): Promise<IIssue | undefined> {
  const connection = await deps.getActiveConnection();
  if (!connection) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "No connected repository. Open the Remote Project Manager panel first, or set 'remoteProjectManager.repository'.",
      ),
    );
    return undefined;
  }
  try {
    const capabilities = await connection.provider.getCapabilities();
    if (!capabilities.canWriteIssues) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Your account cannot create issues on this repository (canWriteIssues is false).",
        ),
      );
      return undefined;
    }
    const { permalink, relativePath } = await resolvePermalink(deps, request);
    const draft = buildIssueDraft({
      title: request.title,
      path: relativePath,
      startLine: request.startLine,
      endLine: request.endLine,
      languageId: request.languageId,
      snippet: request.snippet,
      permalink,
    });
    const issue = await connection.provider.createIssue({ title: draft.title, body: draft.body });
    deps.refreshTree();
    const openLabel = vscode.l10n.t("Open");
    void vscode.window
      .showInformationMessage(
        vscode.l10n.t("Created issue #{0}: {1}", issue.number, issue.title),
        openLabel,
      )
      .then((choice) => {
        if (choice === openLabel) {
          void vscode.commands.executeCommand("remoteProjectManager.openIssueFromTree", issue.id);
        }
      });
    return issue;
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Could not create the issue: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
    return undefined;
  }
}

async function createIssueFromTodo(
  deps: EditorIntegrationDeps,
  uri: vscode.Uri,
  line: number,
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const marker = scanTodos(documentLines(document)).find((candidate) => candidate.line === line);
  if (!marker || marker.issueNumber !== null) {
    return;
  }
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("Issue title"),
    value: marker.text || `${marker.keyword} in ${path.basename(uri.fsPath)}`,
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t("Title is required.")),
  });
  if (title === undefined) {
    return;
  }
  const first = Math.max(0, line - TODO_CONTEXT_LINES);
  const last = Math.min(document.lineCount - 1, line + TODO_CONTEXT_LINES);
  const snippet = documentLines(document)
    .slice(first, last + 1)
    .join("\n");
  const issue = await createIssueFromCode(deps, {
    uri,
    startLine: first + 1,
    endLine: last + 1,
    languageId: document.languageId,
    snippet,
    title,
  });
  if (issue) {
    // Link the marker to its new issue: `TODO` becomes `TODO #N`.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(line, marker.keywordEnd), ` #${issue.number}`);
    await vscode.workspace.applyEdit(edit);
  }
}

async function createIssueFromSelection(deps: EditorIntegrationDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(vscode.l10n.t("Select some code first."));
    return;
  }
  const { selection, document } = editor;
  // A selection ending at column 0 of a line does not include that line.
  const lastLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  const firstLineText = document.getText(selection).split("\n")[0]?.trim() ?? "";
  const title = await vscode.window.showInputBox({
    title: vscode.l10n.t("Issue title"),
    value: firstLineText.slice(0, 80),
    validateInput: (value) => (value.trim() ? undefined : vscode.l10n.t("Title is required.")),
  });
  if (title === undefined) {
    return;
  }
  await createIssueFromCode(deps, {
    uri: document.uri,
    startLine: selection.start.line + 1,
    endLine: lastLine + 1,
    languageId: document.languageId,
    snippet: document.getText(selection),
    title,
  });
}

/** Registers the CodeLens/link providers and the code-to-issue commands (#88, #89). */
export function registerEditorIntegration(
  context: vscode.ExtensionContext,
  deps: EditorIntegrationDeps,
): { refresh(): void } {
  const lensProvider = new TodoCodeLensProvider(deps);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(TODO_LANGUAGE_SELECTOR, lensProvider),
    vscode.languages.registerDocumentLinkProvider(TODO_LANGUAGE_SELECTOR, new TodoLinkProvider()),
    vscode.commands.registerCommand("remoteProjectManager.openIssueByNumber", (n: number) => {
      void openIssueByNumber(deps, n);
    }),
    vscode.commands.registerCommand(
      "remoteProjectManager.createIssueFromTodo",
      (uri: vscode.Uri, line: number) => {
        void createIssueFromTodo(deps, uri, line);
      },
    ),
    vscode.commands.registerCommand("remoteProjectManager.createIssueFromSelection", () => {
      void createIssueFromSelection(deps);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("remoteProjectManager.todoCodeLens")) {
        lensProvider.refresh();
      }
    }),
  );
  return { refresh: () => lensProvider.refresh() };
}
