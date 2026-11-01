import type { IComment } from "../../core/models/comment.model";
import type { IIssue, IssueState } from "../../core/models/issue.model";
import type { IMilestone, MilestoneState } from "../../core/models/milestone.model";

/** GitLab's own issue state vocabulary. */
export type GitlabIssueState = "opened" | "closed";

/** GitLab's own milestone state vocabulary. */
export type GitlabMilestoneState = "active" | "closed";

/** Minimal shape of a GitLab API issue, limited to fields we map. */
export interface RawGitlabIssue {
  readonly iid: number;
  readonly title: string;
  readonly description?: string | null;
  readonly state: GitlabIssueState;
  readonly labels: readonly string[];
  readonly assignees: ReadonlyArray<{ username: string }> | null;
  readonly milestone: { id: number } | null;
  readonly web_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at?: string | null;
  readonly user_notes_count?: number;
}

/** Minimal shape of a GitLab API milestone, limited to fields we map. */
export interface RawGitlabMilestone {
  readonly id: number;
  readonly iid: number;
  readonly title: string;
  readonly description?: string | null;
  readonly state: GitlabMilestoneState;
  readonly due_date?: string | null;
  readonly web_url: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Maps GitLab's issue state vocabulary to the domain state. */
export function mapGitlabIssueStateToDomain(state: GitlabIssueState): IssueState {
  return state === "opened" ? "open" : "closed";
}

/** Maps the domain issue state to GitLab's issue state vocabulary. */
export function mapDomainIssueStateToGitlab(state: IssueState): GitlabIssueState {
  return state === "open" ? "opened" : "closed";
}

/** Maps GitLab's milestone state vocabulary to the domain state. */
export function mapGitlabMilestoneStateToDomain(state: GitlabMilestoneState): MilestoneState {
  return state === "active" ? "open" : "closed";
}

/** Maps the domain milestone state to GitLab's milestone state vocabulary. */
export function mapDomainMilestoneStateToGitlab(state: MilestoneState): GitlabMilestoneState {
  return state === "open" ? "active" : "closed";
}

/**
 * Maps a raw GitLab API issue to the domain {@link IIssue} shape.
 *
 * @param raw - Issue payload as returned by the GitLab API.
 * @param projectPath - `"namespace/project"`, used to build a project-qualified id.
 */
export function mapGitlabIssueToDomain(raw: RawGitlabIssue, projectPath: string): IIssue {
  return {
    id: `${projectPath}#${raw.iid}`,
    number: raw.iid,
    title: raw.title,
    body: raw.description ?? "",
    state: mapGitlabIssueStateToDomain(raw.state),
    labels: raw.labels,
    assignees: (raw.assignees ?? []).map((assignee) => assignee.username),
    milestoneId: raw.milestone ? String(raw.milestone.id) : null,
    url: raw.web_url,
    provider: "gitlab",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    commentsCount: raw.user_notes_count ?? 0,
  };
}

/**
 * Maps a raw GitLab API milestone to the domain {@link IMilestone} shape.
 *
 * @param raw - Milestone payload as returned by the GitLab API.
 */
export function mapGitlabMilestoneToDomain(raw: RawGitlabMilestone): IMilestone {
  return {
    id: String(raw.id),
    number: raw.iid,
    title: raw.title,
    description: raw.description ?? "",
    state: mapGitlabMilestoneStateToDomain(raw.state),
    dueOn: raw.due_date ?? null,
    url: raw.web_url,
    provider: "gitlab",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Minimal shape of a GitLab issue note, limited to fields we map. */
export interface RawGitlabNote {
  readonly id: number;
  readonly author: { username: string } | null;
  readonly body: string;
  readonly created_at: string;
  /** True for activity notes ("changed the description", "added label"). */
  readonly system?: boolean;
}

export function mapGitlabNoteToDomain(raw: RawGitlabNote): IComment {
  return {
    id: String(raw.id),
    author: raw.author?.username ?? "ghost",
    body: raw.body,
    createdAt: raw.created_at,
  };
}
