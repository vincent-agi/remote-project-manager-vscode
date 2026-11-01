/** Housekeeping commands: sign out, git graph, commit linting, the commit-msg hook, diagnostics and tree actions. */
import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import { SimpleGitService } from "../providers/git/simple-git.service";
import { type MyIssueSummary } from "../core/tree/my-issues";
import { BranchManager } from "../core/git/branch-manager";
import { buildCommitMsgHookScript, classifyExistingHook } from "../core/git/commit-msg-hook";
import { openGitGraph } from "../git-graph-panel";
import { logger } from "../logger";
import { formatDiagnosticsReport, type DiagnosticsInput } from "../core/diagnostics/report";
import { lintCommits } from "../core/git/lint-commits";
import { type CommitRef } from "../core/git/pr-body";
import { connectProvider, getActiveConnection, secretKeyFor } from "../connection";
import { resolveRepository } from "../repository";
import { requestCreateBranch } from "../branch-flow";
import type { MyIssuesTreeDataProvider } from "../tree-view";
import { state } from "../state";

/**
 * Clears the stored GitLab Personal Access Token from `SecretStorage`.
 * There is no way to detect a revoked/expired token proactively, so this
 * is the escape hatch for switching accounts or recovering from a stale
 * token: the next GitLab connection prompts for a fresh one.
 */
export async function signOutGitLab(
  context: vscode.ExtensionContext,
  treeDataProvider: MyIssuesTreeDataProvider,
): Promise<void> {
  await context.secrets.delete(secretKeyFor("gitlab"));
  treeDataProvider.invalidateConnection();
  // The AI-context/git-automation commands (getActiveConnection) reuse
  // activeProvider with no freshness check — clear it too so they
  // re-resolve and re-prompt for a token instead of silently reusing a
  // provider built with the now-deleted one.
  if (state.activeProviderKind === "gitlab") {
    state.activeProvider = undefined;
    state.activeFolderPath = undefined;
    state.activeProviderKind = undefined;
  }
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Signed out of GitLab. You'll be prompted for a new token next time the panel connects to a GitLab repository.",
    ),
  );
}

/** Shows the semantic Git Graph (#59): commits grouped by referenced issue, browsable via QuickPick. */
export function showGitGraph(context: vscode.ExtensionContext): void {
  const cwd = state.activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) {
    void vscode.window.showErrorMessage(vscode.l10n.t("No workspace folder open."));
    return;
  }
  openGitGraph(context, cwd, () => state.activeProvider);
}

/** Lints recent commit history against the Gitmoji/Conventional Commit convention (#60), never rewriting history. */
export async function lintCommitHistory(): Promise<void> {
  const cwd = state.activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
export async function installCommitMsgHook(): Promise<void> {
  const cwd = state.activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
export async function uninstallCommitMsgHook(): Promise<void> {
  const cwd = state.activeFolderPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
export async function runDiagnostics(context: vscode.ExtensionContext): Promise<void> {
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
          config.get<string>("giteaHost", "") || undefined,
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
export async function createBranchForTreeIssue(
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
