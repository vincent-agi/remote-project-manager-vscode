/** Creating and switching to a branch for an issue: base-branch picker, dirty-tree prompt and outcome reporting. */
import * as vscode from "vscode";
import type { IIssue } from "./core/models/issue.model";
import type { SimpleGitService } from "./providers/git/simple-git.service";
import type { BranchManager } from "./core/git/branch-manager";
import type { DirtyTreeDecision } from "./core/git/branch-manager.interface";
import { pickDefaultBaseBranch } from "./core/git/pick-default-base-branch";

/** Asks the user how to proceed given a dirty working tree, via a modal. */
export async function promptDirtyWorkingTree(issueNumber: number): Promise<DirtyTreeDecision> {
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
export function reportBranchCreationOutcome(
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
export async function requestCreateBranch(
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
