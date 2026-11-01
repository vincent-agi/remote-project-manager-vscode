import type { IIssue } from "../models/issue.model";

/** The fields the sidebar tree needs for one assigned issue. */
export interface MyIssueSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly milestoneId: string | null;
  readonly updatedAt: string;
}

/**
 * Open issues assigned to `username` (case-insensitive, matching
 * {@link import("../automation/auto-branch-guard").shouldAutoCreateBranch}'s
 * convention), sorted by issue number ascending.
 */
export function selectMyOpenIssues(issues: readonly IIssue[], username: string): MyIssueSummary[] {
  const lowerUsername = username.toLowerCase();
  return issues
    .filter(
      (issue) =>
        issue.state === "open" &&
        issue.assignees.some((assignee) => assignee.toLowerCase() === lowerUsername),
    )
    .sort((a, b) => a.number - b.number)
    .map(({ id, number, title, url, labels, milestoneId, updatedAt }) => ({
      id,
      number,
      title,
      url,
      labels,
      milestoneId,
      updatedAt,
    }));
}

/** Where an assigned issue stands, derived from its labels. */
export type WorkStatus = "in-progress" | "todo" | "blocked";

export interface IssuePriority {
  readonly rank: number;
  readonly title: "Critical" | "High" | "Medium" | "Low";
}

const PRIORITY_TITLES = ["Critical", "High", "Medium", "Low"] as const;
const NAMED_PRIORITIES: Readonly<Record<string, number>> = {
  critical: 0,
  urgent: 0,
  blocker: 0,
  high: 1,
  medium: 2,
  normal: 2,
  low: 3,
};

/**
 * Reads an issue's priority from its labels (`priority: high`,
 * `priority/low`, `p0`..`p3`, bare `urgent`). The most urgent label wins.
 * Mirrors `priorityOf` in `src/webview-ui/issue-view-model.ts`, which
 * cannot be imported across the two build programs; a parity test keeps
 * them in step.
 */
export function priorityOf(labels: readonly string[]): IssuePriority | null {
  let best: number | null = null;
  for (const label of labels) {
    const lower = label.toLowerCase().trim();
    const level = /^p([0-3])$/.exec(lower)?.[1];
    const named = /^(?:priority\s*[:/-]?\s*)?([a-z]+)$/.exec(lower)?.[1];
    let rank: number | undefined;
    if (level !== undefined) {
      rank = Number(level);
    } else if (
      named !== undefined &&
      (lower.startsWith("priority") || named === "urgent" || named === "blocker")
    ) {
      rank = NAMED_PRIORITIES[named];
    }
    if (rank !== undefined && (best === null || rank < best)) {
      best = rank;
    }
  }
  return best === null ? null : { rank: best, title: PRIORITY_TITLES[best] };
}

function hasLabel(labels: readonly string[], wanted: string): boolean {
  return labels.some((label) => label.toLowerCase().trim() === wanted);
}

/** `blocked` wins over `in-progress`: a blocked task is not moving. */
export function workStatusOf(labels: readonly string[]): WorkStatus {
  if (hasLabel(labels, "blocked")) {
    return "blocked";
  }
  return hasLabel(labels, "in-progress") ? "in-progress" : "todo";
}

/** A collapsible group of assigned issues in the tree. */
export interface MyIssueGroup {
  readonly kind: "group";
  readonly status: WorkStatus;
  readonly label: string;
  readonly issues: MyIssueSummary[];
}

const GROUP_ORDER: readonly { status: WorkStatus; label: string }[] = [
  { status: "in-progress", label: "In progress" },
  { status: "todo", label: "To do" },
  { status: "blocked", label: "Blocked" },
];

/**
 * Splits assigned issues into In progress / To do / Blocked groups, in that
 * order, omitting empty ones. Inside a group, higher priority comes first,
 * then lower issue number.
 */
export function groupMyIssues(issues: readonly MyIssueSummary[]): MyIssueGroup[] {
  return GROUP_ORDER.map(({ status, label }) => ({
    kind: "group" as const,
    status,
    label,
    issues: issues
      .filter((issue) => workStatusOf(issue.labels) === status)
      .sort(
        (a, b) =>
          (priorityOf(a.labels)?.rank ?? Number.MAX_SAFE_INTEGER) -
            (priorityOf(b.labels)?.rank ?? Number.MAX_SAFE_INTEGER) || a.number - b.number,
      ),
  })).filter((group) => group.issues.length > 0);
}

/** Escapes Markdown control characters so issue text cannot alter the tooltip's formatting. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

/** Markdown tooltip body for an assigned issue. `milestoneTitle` is `null` when it has none. */
export function buildIssueTooltip(issue: MyIssueSummary, milestoneTitle: string | null): string {
  const priority = priorityOf(issue.labels);
  const lines = [
    `**#${issue.number} ${escapeMarkdown(issue.title)}**`,
    "",
    `Status: ${workStatusOf(issue.labels).replace("-", " ")}`,
    ...(priority ? [`Priority: ${priority.title}`] : []),
    ...(milestoneTitle ? [`Milestone: ${escapeMarkdown(milestoneTitle)}`] : []),
    ...(issue.labels.length > 0
      ? [`Labels: ${issue.labels.map((label) => `\`${label.replace(/`/g, "'")}\``).join(", ")}`]
      : []),
    `Updated: ${issue.updatedAt.slice(0, 10)}`,
  ];
  return lines.join("\n\n");
}

/** One-line description shown after the issue label: milestone and priority. */
export function buildIssueDescription(
  issue: MyIssueSummary,
  milestoneTitle: string | null,
): string {
  const priority = priorityOf(issue.labels);
  return [milestoneTitle, priority?.title]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
