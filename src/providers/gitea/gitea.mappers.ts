import type { IComment } from "../../core/models/comment.model";
import type { IIssue } from "../../core/models/issue.model";
import type { IMilestone } from "../../core/models/milestone.model";

/** Minimal shape of a Gitea API issue, limited to fields we map. */
export interface RawGiteaIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: "open" | "closed";
  readonly labels?: readonly { name: string; color?: string }[] | null;
  readonly assignees?: readonly { login: string }[] | null;
  readonly milestone?: { id: number } | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at?: string | null;
  readonly comments?: number;
  /** Present when the "issue" is really a pull request. */
  readonly pull_request?: unknown;
}

/** Minimal shape of a Gitea API milestone, limited to fields we map. */
export interface RawGiteaMilestone {
  readonly id: number;
  readonly title: string;
  readonly description?: string | null;
  readonly state: "open" | "closed";
  readonly due_on?: string | null;
  readonly created_at: string;
  readonly updated_at?: string | null;
}

/** Minimal shape of a Gitea API issue comment, limited to fields we map. */
export interface RawGiteaComment {
  readonly id: number;
  readonly user: { login: string } | null;
  readonly body?: string | null;
  readonly created_at: string;
  readonly html_url?: string;
}

export function mapGiteaIssueToDomain(raw: RawGiteaIssue, repoFullName: string): IIssue {
  return {
    id: `${repoFullName}#${raw.number}`,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels: (raw.labels ?? []).map((label) => label.name).filter((name) => name.length > 0),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    milestoneId: raw.milestone ? String(raw.milestone.id) : null,
    url: raw.html_url,
    provider: "gitea",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
    commentsCount: raw.comments ?? 0,
  };
}

/**
 * Gitea milestones have no per-repository number, so the id doubles as the
 * number shown to the user. `webBaseUrl` is `https://host/owner/repo`.
 */
export function mapGiteaMilestoneToDomain(raw: RawGiteaMilestone, webBaseUrl: string): IMilestone {
  return {
    id: String(raw.id),
    number: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    state: raw.state,
    dueOn: raw.due_on ?? null,
    url: `${webBaseUrl}/milestone/${raw.id}`,
    provider: "gitea",
    createdAt: raw.created_at,
    updatedAt: raw.updated_at ?? raw.created_at,
  };
}

export function mapGiteaCommentToDomain(raw: RawGiteaComment): IComment {
  return {
    id: String(raw.id),
    author: raw.user?.login ?? "ghost",
    body: raw.body ?? "",
    createdAt: raw.created_at,
    ...(raw.html_url ? { url: raw.html_url } : {}),
  };
}
