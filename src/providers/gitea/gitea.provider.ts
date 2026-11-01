import type { IComment } from "../../core/models/comment.model";
import type { IIssue } from "../../core/models/issue.model";
import type { IMilestone } from "../../core/models/milestone.model";
import type {
  CreateIssueInput,
  CreateMilestoneInput,
  FetchOptions,
  IAuthenticatedUser,
  IProjectProvider,
  ProviderCapabilities,
  UpdateIssueInput,
  UpdateMilestoneInput,
} from "../../core/providers/project-provider.interface";
import type { GiteaClient } from "./gitea.client";
import {
  mapGiteaCommentToDomain,
  mapGiteaIssueToDomain,
  mapGiteaMilestoneToDomain,
  type RawGiteaComment,
  type RawGiteaIssue,
  type RawGiteaMilestone,
} from "./gitea.mappers";

/** Items requested per page; Gitea may serve fewer if its own maximum is lower. */
const PAGE_SIZE = 50;
/** Hard stop against a server that never returns an empty page. */
const MAX_PAGES = 200;

/** A Gitea label as listed by the repository labels endpoint. */
interface RawGiteaLabel {
  readonly id: number;
  readonly name: string;
  readonly color?: string;
}

/**
 * Gitea connector implementing {@link IProjectProvider} over Gitea's REST
 * API v1 (also served by Forgejo). Issues use the composite id
 * `"owner/repo#number"`, like the GitHub provider.
 *
 * Differences from GitHub that this class absorbs:
 * - labels are sent as numeric ids, so names are resolved against the
 *   repository's label list;
 * - an issue edit cannot change labels, which go through their own endpoint;
 * - milestones have no per-repository number (the id is used);
 * - pull requests appear among issues and are filtered out.
 *
 * `webBaseUrl` is `https://host/owner/repo`, used for milestone links.
 */
export class GiteaProvider implements IProjectProvider {
  constructor(
    private readonly client: GiteaClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly webBaseUrl: string,
  ) {}

  private get repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  private get repoFullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  private parseIssueNumber(id: string): number {
    const match = id.match(/#(\d+)$/);
    if (!match) {
      throw new Error(`Not a valid Gitea issue id: '${id}'`);
    }
    return Number(match[1]);
  }

  /** Reads every page of a list endpoint, stopping at the first empty page. */
  private async paginateAll<T>(
    path: string,
    query: Readonly<Record<string, string | number>> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.client.request<readonly T[]>("GET", path, {
        query: { ...query, page, limit: PAGE_SIZE },
      });
      if (data.length === 0) {
        break;
      }
      items.push(...data);
    }
    return items;
  }

  private listRawLabels(): Promise<RawGiteaLabel[]> {
    return this.paginateAll<RawGiteaLabel>(`${this.repoPath}/labels`);
  }

  /** Label names -> ids; unknown names are an error rather than silently dropped. */
  private async resolveLabelIds(names: readonly string[]): Promise<number[]> {
    if (names.length === 0) {
      return [];
    }
    const labels = await this.listRawLabels();
    return names.map((name) => {
      const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
      if (!found) {
        throw new Error(`No label named '${name}' in ${this.repoFullName}`);
      }
      return found.id;
    });
  }

  async getCurrentUser(): Promise<IAuthenticatedUser> {
    const user = await this.client.request<{ login: string }>("GET", "/user");
    return { username: user.login };
  }

  async getCapabilities(_options?: FetchOptions): Promise<ProviderCapabilities> {
    const repository = await this.client.request<{
      permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    }>("GET", this.repoPath);
    const canWrite = Boolean(repository.permissions?.push || repository.permissions?.admin);
    const canRead = Boolean(repository.permissions?.pull ?? true);
    return {
      canReadIssues: canRead,
      canWriteIssues: canWrite,
      canReadMilestones: canRead,
      canWriteMilestones: canWrite,
    };
  }

  async listIssues(_options?: FetchOptions): Promise<readonly IIssue[]> {
    const issues = await this.paginateAll<RawGiteaIssue>(`${this.repoPath}/issues`, {
      state: "all",
      type: "issues",
    });
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => mapGiteaIssueToDomain(issue, this.repoFullName));
  }

  async getIssue(id: string): Promise<IIssue> {
    const raw = await this.client.request<RawGiteaIssue>(
      "GET",
      `${this.repoPath}/issues/${this.parseIssueNumber(id)}`,
    );
    return mapGiteaIssueToDomain(raw, this.repoFullName);
  }

  async createIssue(input: CreateIssueInput): Promise<IIssue> {
    const raw = await this.client.request<RawGiteaIssue>("POST", `${this.repoPath}/issues`, {
      body: {
        title: input.title,
        body: input.body,
        labels: await this.resolveLabelIds(input.labels ?? []),
        ...(input.assignees ? { assignees: [...input.assignees] } : {}),
        ...(input.milestoneId ? { milestone: Number(input.milestoneId) } : {}),
      },
    });
    return mapGiteaIssueToDomain(raw, this.repoFullName);
  }

  async updateIssue(id: string, patch: UpdateIssueInput): Promise<IIssue> {
    const number = this.parseIssueNumber(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      body.title = patch.title;
    }
    if (patch.body !== undefined) {
      body.body = patch.body;
    }
    if (patch.state !== undefined) {
      body.state = patch.state;
    }
    if (patch.assignees !== undefined) {
      body.assignees = [...patch.assignees];
    }
    if (patch.milestoneId !== undefined) {
      // 0 clears the milestone.
      body.milestone = patch.milestoneId === null ? 0 : Number(patch.milestoneId);
    }
    let raw: RawGiteaIssue | undefined;
    if (Object.keys(body).length > 0) {
      raw = await this.client.request<RawGiteaIssue>("PATCH", `${this.repoPath}/issues/${number}`, {
        body,
      });
    }
    if (patch.labels !== undefined) {
      await this.client.request("PUT", `${this.repoPath}/issues/${number}/labels`, {
        body: { labels: await this.resolveLabelIds(patch.labels) },
      });
      raw = undefined; // the edit response predates the label change
    }
    raw ??= await this.client.request<RawGiteaIssue>("GET", `${this.repoPath}/issues/${number}`);
    return mapGiteaIssueToDomain(raw, this.repoFullName);
  }

  async listComments(issueId: string): Promise<readonly IComment[]> {
    const comments = await this.paginateAll<RawGiteaComment>(
      `${this.repoPath}/issues/${this.parseIssueNumber(issueId)}/comments`,
    );
    return comments.map(mapGiteaCommentToDomain);
  }

  async addComment(issueId: string, body: string): Promise<IComment> {
    const raw = await this.client.request<RawGiteaComment>(
      "POST",
      `${this.repoPath}/issues/${this.parseIssueNumber(issueId)}/comments`,
      { body: { body } },
    );
    return mapGiteaCommentToDomain(raw);
  }

  private toMilestone(raw: RawGiteaMilestone): IMilestone {
    return mapGiteaMilestoneToDomain(raw, `${this.webBaseUrl}`);
  }

  async listMilestones(_options?: FetchOptions): Promise<readonly IMilestone[]> {
    const milestones = await this.paginateAll<RawGiteaMilestone>(`${this.repoPath}/milestones`, {
      state: "all",
    });
    return milestones.map((milestone) => this.toMilestone(milestone));
  }

  async getMilestone(id: string): Promise<IMilestone> {
    return this.toMilestone(
      await this.client.request<RawGiteaMilestone>("GET", `${this.repoPath}/milestones/${id}`),
    );
  }

  async createMilestone(input: CreateMilestoneInput): Promise<IMilestone> {
    return this.toMilestone(
      await this.client.request<RawGiteaMilestone>("POST", `${this.repoPath}/milestones`, {
        body: {
          title: input.title,
          description: input.description ?? "",
          ...(input.dueOn ? { due_on: toIsoDateTime(input.dueOn) } : {}),
        },
      }),
    );
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<IMilestone> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      body.title = patch.title;
    }
    if (patch.description !== undefined) {
      body.description = patch.description;
    }
    if (patch.state !== undefined) {
      body.state = patch.state;
    }
    if (patch.dueOn !== undefined) {
      body.due_on = patch.dueOn === null ? null : toIsoDateTime(patch.dueOn);
    }
    return this.toMilestone(
      await this.client.request<RawGiteaMilestone>("PATCH", `${this.repoPath}/milestones/${id}`, {
        body,
      }),
    );
  }

  async listLabels(_options?: FetchOptions): Promise<readonly string[]> {
    return (await this.listRawLabels()).map((label) => label.name);
  }

  async listLabelColors(_options?: FetchOptions): Promise<Readonly<Record<string, string>>> {
    const labels = await this.listRawLabels();
    return Object.fromEntries(
      labels.flatMap((label) => (label.color ? [[label.name, label.color.replace(/^#/, "")]] : [])),
    );
  }

  async listAssignableUsers(_options?: FetchOptions): Promise<readonly string[]> {
    const users = await this.paginateAll<{ login: string }>(`${this.repoPath}/assignees`);
    return users.map((user) => user.login);
  }
}

/** The webview's date input yields `YYYY-MM-DD`; Gitea wants a full date-time. */
function toIsoDateTime(value: string): string {
  return value.includes("T") ? value : `${value}T00:00:00Z`;
}
