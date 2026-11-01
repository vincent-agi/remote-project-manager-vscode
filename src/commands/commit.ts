/** Commit commands: the Conventional Commit + Gitmoji composer and the Gitmoji picker. */
import * as vscode from "vscode";
import { SimpleGitService } from "../providers/git/simple-git.service";
import { extractIssueNumberFromBranch } from "../core/git/branch-issue-ref";
import { suggestCommitScope, suggestCommitType } from "../core/git/commit-suggestions";
import {
  buildCommitMessage,
  COMMIT_TYPES,
  type CommitType,
  type IssueReferenceKind,
} from "../core/git/commit-message";
import { parseGitmojis, type Gitmoji } from "../core/git/gitmoji";
import { state } from "../state";

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
 * Interactive commit-composition flow (#54, #55, #56): walks through
 * type, scope, Gitmoji, description, and an optional issue reference
 * (pre-filled from the current branch, see
 * {@link resolveActiveIssueViaBranch}'s sibling
 * {@link extractIssueNumberFromBranch}), then drops the composed message
 * into the Source Control input box (or the clipboard, if the git
 * extension isn't available).
 */
export async function composeCommit(
  context: vscode.ExtensionContext,
  scm?: { readonly rootUri?: vscode.Uri },
): Promise<void> {
  // The Source Control title button passes the clicked repository, so in a
  // multi-root workspace the message lands in that repository's input box.
  const cwd =
    scm?.rootUri?.fsPath ??
    state.activeFolderPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
export async function pickGitmojiCommand(context: vscode.ExtensionContext): Promise<void> {
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
