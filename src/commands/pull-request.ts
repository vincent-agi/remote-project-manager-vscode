/** Creating a pull request / merge request from an issue. */
import * as vscode from "vscode";
import { SimpleGitService } from "../providers/git/simple-git.service";
import { type MyIssueSummary } from "../core/tree/my-issues";
import { extractIssueNumberFromBranch } from "../core/git/branch-issue-ref";
import { buildCompareUrl } from "../core/git/compare-url";
import { buildConventionalPrTitle, buildPrBody, type CommitRef } from "../core/git/pr-body";
import { resolveRepository } from "../repository";
import { findMilestoneForIssue, resolveActiveIssueViaBranch } from "./issue-context";
import { getActiveConnection } from "../connection";

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
export async function createPrFromIssue(
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
