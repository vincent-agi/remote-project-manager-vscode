import type { IComment } from "../../core/models/comment.model";
import type { IIssue, IssueState } from "../../core/models/issue.model";
import type { IMilestone, MilestoneState } from "../../core/models/milestone.model";

/** Minimal shape of a GitHub REST API issue, limited to fields we map. */
export interface RawGithubIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: "open" | "closed";
  readonly labels: ReadonlyArray<string | { name?: string }>;
  readonly assignees: ReadonlyArray<{ login: string }> | null;
  readonly milestone: { id: number } | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at?: string | null;
  readonly comments?: number;
}

/** Minimal shape of a GitHub REST API milestone, limited to fields we map. */
export interface RawGithubMilestone {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly description?: string | null;
  readonly state: "open" | "closed";
  readonly due_on?: string | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** GitHub issue/milestone state already matches the domain state 1:1. */
export function mapGithubStateToDomain(state: "open" | "closed"): IssueState {
  return state;
}

/** Domain issue state already matches GitHub's state 1:1. */
export function mapDomainIssueStateToGithub(state: IssueState): "open" | "closed" {
  return state;
}

function labelName(label: string | { name?: string }): string {
  return typeof label === "string" ? label : (label.name ?? "");
}

/**
 * Maps a raw GitHub REST issue to the domain {@link IIssue} shape.
 *
 * @param raw - Issue payload as returned by the GitHub REST API.
 * @param repoFullName - `"owner/repo"`, used to build a repo-qualified id.
 */
export function mapGithubIssueToDomain(raw: RawGithubIssue, repoFullName: string): IIssue {
  return {
    id: `${repoFullName}#${raw.number}`,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: mapGithubStateToDomain(raw.state),
    labels: raw.labels.map(labelName).filter((name) => name.length > 0),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    milestoneId: raw.milestone ? String(raw.milestone.id) : null,
    url: raw.html_url,
    provider: "github",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    commentsCount: raw.comments ?? 0,
  };
}

/** GitHub milestone state already matches the domain state 1:1. */
export function mapGithubMilestoneStateToDomain(state: "open" | "closed"): MilestoneState {
  return state;
}

/**
 * Maps a raw GitHub REST milestone to the domain {@link IMilestone} shape.
 *
 * @param raw - Milestone payload as returned by the GitHub REST API.
 */
export function mapGithubMilestoneToDomain(raw: RawGithubMilestone): IMilestone {
  return {
    id: String(raw.id),
    number: raw.number,
    title: raw.title,
    description: raw.description ?? "",
    state: mapGithubMilestoneStateToDomain(raw.state),
    dueOn: raw.due_on ?? null,
    url: raw.html_url,
    provider: "github",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Minimal shape of a GitHub REST API issue comment, limited to fields we map. */
export interface RawGithubComment {
  readonly id: number;
  readonly user: { login: string } | null;
  readonly body?: string | null;
  readonly created_at: string;
  readonly html_url: string;
}

export function mapGithubCommentToDomain(raw: RawGithubComment): IComment {
  return {
    id: String(raw.id),
    author: raw.user?.login ?? "ghost",
    body: raw.body ?? "",
    createdAt: raw.created_at,
    url: raw.html_url,
  };
}
