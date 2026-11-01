import type { IIssue } from "../models/issue.model";
import type { IMilestone } from "../models/milestone.model";

/** A single commit as read from `git log`. */
export interface CommitRef {
  readonly hash: string;
  readonly message: string;
}

/** Composes a PR title from the issue: `<type>: <title> (#<number>)`. */
export function buildPrTitle(issue: IIssue): string {
  return `${issue.title} (#${issue.number})`;
}

/**
 * Composes a PR/MR description from an issue, its milestone, and the
 * commits on the branch ahead of the base branch: the issue summary
 * (title/state/labels/URL, first line of body), a bullet list of commits
 * (short hash + subject line only), and a semantic link to the
 * milestone. Pure and provider-agnostic — the caller decides how to hand
 * this to GitHub/GitLab (direct API create, or a prefilled compare/MR
 * URL).
 */
export function buildPrBody(
  issue: IIssue,
  milestone: IMilestone | null,
  commits: readonly CommitRef[],
): string {
  const lines: string[] = [];
  lines.push(`Closes #${issue.number} — ${issue.title}`);
  lines.push("");

  const summary = issue.body.trim().split("\n")[0];
  if (summary) {
    lines.push(summary);
    lines.push("");
  }

  if (commits.length > 0) {
    lines.push("**Commits**");
    for (const commit of commits) {
      const subject = commit.message.split("\n")[0];
      lines.push(`- ${commit.hash.slice(0, 7)} ${subject}`);
    }
    lines.push("");
  }

  if (milestone) {
    lines.push(`Part of milestone: ${milestone.title} (#${milestone.number})`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Commit types ordered from most to least significant for naming a PR. */
const TYPE_PRIORITY = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "docs",
  "test",
  "build",
  "ci",
  "style",
  "chore",
] as const;

const SUBJECT_PATTERN = /^([a-z]+)(?:\(([\w./-]+)\))?: (\S+) (.+)$/u;

/**
 * Composes a Conventional Commits PR title (`<type>(<scope>): <gitmoji>
 * <description> (#<n>)`) from the branch's commits: the most significant
 * type among them, the scope they all share (if any), and the gitmoji of
 * the first commit of that type. The description is the commit's own when
 * there is exactly one conforming commit, the issue title otherwise. Falls
 * back to {@link buildPrTitle} when no commit follows the convention.
 */
export function buildConventionalPrTitle(issue: IIssue, commits: readonly CommitRef[]): string {
  const parsed = commits
    .map((commit) => SUBJECT_PATTERN.exec(commit.message.split("\n")[0] ?? ""))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, type, scope, gitmoji, description]) => ({ type, scope, gitmoji, description }));
  if (parsed.length === 0) {
    return buildPrTitle(issue);
  }

  const chosen =
    TYPE_PRIORITY.map((type) => parsed.find((commit) => commit.type === type)).find(Boolean) ??
    parsed[0];
  const scopes = new Set(parsed.map((commit) => commit.scope));
  const [onlyScope] = scopes;
  const scope = scopes.size === 1 && onlyScope ? `(${onlyScope})` : "";
  const description = parsed.length === 1 ? chosen.description : issue.title;
  const suffix = description.includes(`(#${issue.number})`) ? "" : ` (#${issue.number})`;
  return `${chosen.type}${scope}: ${chosen.gitmoji} ${description}${suffix}`;
}
