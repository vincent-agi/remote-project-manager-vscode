import type { IIssue } from "../models/issue.model";

const IN_PROGRESS_LABEL = "in-progress";
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** What the commit-time automation should do for the current branch. */
export type CommitSyncAction =
  | { readonly kind: "none" }
  | { readonly kind: "mark-in-progress"; readonly issue: IIssue }
  | { readonly kind: "remind-no-issue"; readonly branch: string };

/** Inputs of {@link decideCommitSync}. */
export interface CommitSyncInput {
  readonly branch: string | null;
  readonly defaultBranch: string;
  /** Number of commits on the branch not yet on the default branch. */
  readonly commitsAhead: number;
  /** Issue number the branch name encodes, if any. */
  readonly branchIssueNumber: number | null;
  readonly issues: readonly IIssue[];
  readonly username: string;
}

function hasInProgressLabel(issue: IIssue): boolean {
  return issue.labels.some((label) => label.toLowerCase() === IN_PROGRESS_LABEL);
}

function isAssignedTo(issue: IIssue, username: string): boolean {
  const lower = username.toLowerCase();
  return issue.assignees.some((assignee) => assignee.toLowerCase() === lower);
}

/**
 * Decides, right after a commit, whether to flag the branch's issue as
 * "in-progress" or to remind the user that the branch maps to no issue.
 * Nothing happens on the default branch, on a detached HEAD, or while the
 * branch has no commit of its own; only open issues assigned to the user
 * are touched, and never twice.
 */
export function decideCommitSync(input: CommitSyncInput): CommitSyncAction {
  const { branch, defaultBranch, commitsAhead, branchIssueNumber, issues, username } = input;
  if (!branch || branch === "HEAD" || branch === defaultBranch || commitsAhead < 1) {
    return { kind: "none" };
  }
  if (branchIssueNumber === null) {
    return { kind: "remind-no-issue", branch };
  }
  const issue = issues.find((candidate) => candidate.number === branchIssueNumber);
  if (
    !issue ||
    issue.state !== "open" ||
    !isAssignedTo(issue, username) ||
    hasInProgressLabel(issue)
  ) {
    return { kind: "none" };
  }
  return { kind: "mark-in-progress", issue };
}

/** The label set to send so `issue` gains "in-progress" without losing anything. */
export function labelsWithInProgress(issue: IIssue): string[] {
  return [...issue.labels, IN_PROGRESS_LABEL];
}

/**
 * Open issues that a commit on the default branch already closes through a
 * closing keyword (`Fixes #N`, `Closes #N`, `Resolves #N`) but that are still
 * open — e.g. the host did not auto-close them. Sorted by issue number.
 */
export function findIssuesClosedByCommits(
  openIssues: readonly IIssue[],
  defaultBranchMessages: readonly string[],
): IIssue[] {
  const closedNumbers = new Set<number>();
  for (const message of defaultBranchMessages) {
    for (const match of message.matchAll(CLOSING_KEYWORD)) {
      closedNumbers.add(Number(match[1]));
    }
  }
  return openIssues
    .filter((issue) => issue.state === "open" && closedNumbers.has(issue.number))
    .sort((a, b) => a.number - b.number);
}
