/** AI-context commands: copy an issue's context and export a milestone's context to files. */
import * as vscode from "vscode";
import type { IIssue } from "../core/models/issue.model";
import type { IProjectProvider } from "../core/providers/project-provider.interface";
import { SimpleGitService } from "../providers/git/simple-git.service";
import { type MyIssueSummary } from "../core/tree/my-issues";
import { extractIssueNumberFromBranch } from "../core/git/branch-issue-ref";
import { readAiContextTargets, trackExportedContext, writeContextFiles } from "../ai-context-files";
import { digestContext } from "../core/ai/context-targets";
import { formatIssueContext } from "../core/ai/issue-context";
import { formatMilestoneContext } from "../core/ai/milestone-context";
import type { IMilestone } from "../core/models/milestone.model";
import { getActiveConnection } from "../connection";
import { state } from "../state";

/**
 * Resolves the "active issue" for git-automation commands (#56, #57,
 * #58, #61) from the current branch name, via
 * {@link extractIssueNumberFromBranch} — consistent with how this
 * extension names branches it creates itself
 * (`remoteProjectManager.branchNamePattern`). Returns `null` when the
 * branch encodes no issue number or doesn't match any known issue;
 * callers fall back to letting the user pick manually.
 */
export async function resolveActiveIssueViaBranch(
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
export async function findMilestoneForIssue(
  provider: IProjectProvider,
  issue: IIssue,
): Promise<IMilestone | null> {
  if (!issue.milestoneId) {
    return null;
  }
  const milestones = await provider.listMilestones();
  return milestones.find((milestone) => milestone.id === issue.milestoneId) ?? null;
}

/** Copies the active issue's context (#57) to the clipboard for pasting into an AI coding assistant. */
export async function copyIssueContext(
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
  state.lastIssueContext = contextBlock;
  await vscode.env.clipboard.writeText(contextBlock);
  void vscode.window.showInformationMessage(
    vscode.l10n.t("Copied issue #{0} context to clipboard.", issue.number),
  );
}

/** Exports the active milestone's context to a configurable Markdown file for AI agents (#61), idempotently. */
export async function exportMilestoneContext(context: vscode.ExtensionContext): Promise<void> {
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
