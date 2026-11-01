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
import {
  mapDomainIssueStateToGithub,
  mapGithubCommentToDomain,
  mapGithubIssueToDomain,
  mapGithubMilestoneToDomain,
  type RawGithubComment,
  type RawGithubIssue,
  type RawGithubMilestone,
} from "./github.mappers";

type RawGithubPullRequestIssue = RawGithubIssue & { pull_request?: unknown };

/**
 * GitHub's REST API requires `due_on` as a full ISO 8601 date-time, but the
 * webview's `<input type="date">` only ever produces a bare `YYYY-MM-DD`.
 */
function toGithubDueOn(dueOn: string | null | undefined): string | undefined {
  if (!dueOn) {
    return undefined;
  }
  return dueOn.includes("T") ? dueOn : `${dueOn}T00:00:00Z`;
}

/**
 * Minimal slice of the Octokit REST client this provider depends on.
 * Kept narrow so tests can supply a plain fake instead of a real Octokit
 * instance.
 */
export interface GithubClient {
  issues: {
    listForRepo(params: {
      owner: string;
      repo: string;
      state: "all";
      per_page: number;
      page: number;
    }): Promise<{
      data: readonly RawGithubPullRequestIssue[];
    }>;
    get(params: { owner: string; repo: string; issue_number: number }): Promise<{
      data: RawGithubIssue;
    }>;
    create(params: Record<string, unknown>): Promise<{ data: RawGithubIssue }>;
    listComments(params: {
      owner: string;
      repo: string;
      issue_number: number;
      per_page: number;
      page: number;
    }): Promise<{ data: readonly RawGithubComment[] }>;
    createComment(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: RawGithubComment }>;
    update(params: Record<string, unknown>): Promise<{ data: RawGithubIssue }>;
    listMilestones(params: {
      owner: string;
      repo: string;
      state: "all";
      per_page: number;
      page: number;
    }): Promise<{
      data: readonly RawGithubMilestone[];
    }>;
    createMilestone(params: Record<string, unknown>): Promise<{ data: RawGithubMilestone }>;
    updateMilestone(params: Record<string, unknown>): Promise<{ data: RawGithubMilestone }>;
    listLabelsForRepo(params: {
      owner: string;
      repo: string;
      per_page: number;
      page: number;
    }): Promise<{
      data: readonly { name: string; color?: string }[];
    }>;
    listAssignees(params: {
      owner: string;
      repo: string;
      per_page: number;
      page: number;
    }): Promise<{
      data: readonly { login: string }[];
    }>;
  };
  repos: {
    get(params: { owner: string; repo: string }): Promise<{
      data: { permissions?: { pull?: boolean; push?: boolean; triage?: boolean } };
    }>;
  };
  users: {
    getAuthenticated(): Promise<{ data: { login: string } }>;
  };
}

/**
 * GitHub connector implementing {@link IProjectProvider} on top of Octokit.
 *
 * Issues are addressed by the composite id `"owner/repo#number"` produced
 * by {@link mapGithubIssueToDomain}. Milestones are addressed by their
 * internal GitHub id; since GitHub's milestone endpoints require the
 * per-repo `milestone_number` instead, this provider resolves that number
 * by listing milestones and matching on id.
 */
export class GithubProvider implements IProjectProvider {
  constructor(
    private readonly client: GithubClient,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  private get repoFullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  private parseIssueNumber(id: string): number {
    const match = id.match(/#(\d+)$/);
    if (!match) {
      throw new Error(`Not a valid GitHub issue id: '${id}'`);
    }
    return Number(match[1]);
  }

  /**
   * Collects every item across all pages of a paginated GitHub REST list
   * endpoint (`per_page: 100`). Octokit's plain REST calls (as opposed to
   * `octokit.paginate`) only ever return a single page, so without this
   * any list past the first 100 items would silently go missing.
   */
  private async paginateAll<T>(
    fetchPage: (page: number) => Promise<{ data: readonly T[] }>,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const { data } = await fetchPage(page);
      items.push(...data);
      if (data.length < 100) {
        return items;
      }
      page += 1;
    }
  }

  private fetchAllRawMilestones(): Promise<RawGithubMilestone[]> {
    return this.paginateAll((page) =>
      this.client.issues.listMilestones({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        per_page: 100,
        page,
      }),
    );
  }

  private async findRawMilestoneById(id: string): Promise<RawGithubMilestone> {
    const milestones = await this.fetchAllRawMilestones();
    const found = milestones.find((milestone) => String(milestone.id) === id);
    if (!found) {
      throw new Error(`No milestone found with id '${id}' in ${this.repoFullName}`);
    }
    return found;
  }

  async getCurrentUser(): Promise<IAuthenticatedUser> {
    const { data } = await this.client.users.getAuthenticated();
    return { username: data.login };
  }

  async getCapabilities(_options?: FetchOptions): Promise<ProviderCapabilities> {
    const { data } = await this.client.repos.get({ owner: this.owner, repo: this.repo });
    const canWrite = Boolean(data.permissions?.push);
    // GitHub's "Triage" role grants issue/label/assignee write access
    // (create, edit, assign, comment) without repo push access — but
    // not milestone create/edit, which stays gated on push.
    const canWriteIssues = canWrite || Boolean(data.permissions?.triage);
    const canRead = Boolean(data.permissions?.pull ?? true);
    return {
      canReadIssues: canRead,
      canWriteIssues,
      canReadMilestones: canRead,
      canWriteMilestones: canWrite,
    };
  }

  async listIssues(_options?: FetchOptions): Promise<readonly IIssue[]> {
    const issues = await this.paginateAll((page) =>
      this.client.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "all",
        per_page: 100,
        page,
      }),
    );
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => mapGithubIssueToDomain(issue, this.repoFullName));
  }

  async getIssue(id: string): Promise<IIssue> {
    const issueNumber = this.parseIssueNumber(id);
    const { data } = await this.client.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
    });
    return mapGithubIssueToDomain(data, this.repoFullName);
  }

  async createIssue(input: CreateIssueInput): Promise<IIssue> {
    const milestoneNumber = input.milestoneId
      ? (await this.findRawMilestoneById(input.milestoneId)).number
      : undefined;
    const { data } = await this.client.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
      assignees: input.assignees,
      milestone: milestoneNumber,
    });
    return mapGithubIssueToDomain(data, this.repoFullName);
  }

  async listComments(issueId: string): Promise<readonly IComment[]> {
    const issueNumber = this.parseIssueNumber(issueId);
    const comments = await this.paginateAll((page) =>
      this.client.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      }),
    );
    return comments.map(mapGithubCommentToDomain);
  }

  async addComment(issueId: string, body: string): Promise<IComment> {
    const { data } = await this.client.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: this.parseIssueNumber(issueId),
      body,
    });
    return mapGithubCommentToDomain(data);
  }

  async updateIssue(id: string, patch: UpdateIssueInput): Promise<IIssue> {
    const issueNumber = this.parseIssueNumber(id);
    let milestoneNumber: number | null | undefined;
    if (patch.milestoneId === null) {
      milestoneNumber = null;
    } else if (patch.milestoneId !== undefined) {
      milestoneNumber = (await this.findRawMilestoneById(patch.milestoneId)).number;
    }
    const { data } = await this.client.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      title: patch.title,
      body: patch.body,
      state: patch.state ? mapDomainIssueStateToGithub(patch.state) : undefined,
      labels: patch.labels,
      assignees: patch.assignees,
      milestone: milestoneNumber,
    });
    return mapGithubIssueToDomain(data, this.repoFullName);
  }

  async listMilestones(_options?: FetchOptions): Promise<readonly IMilestone[]> {
    const milestones = await this.fetchAllRawMilestones();
    return milestones.map(mapGithubMilestoneToDomain);
  }

  async getMilestone(id: string): Promise<IMilestone> {
    return mapGithubMilestoneToDomain(await this.findRawMilestoneById(id));
  }

  async createMilestone(input: CreateMilestoneInput): Promise<IMilestone> {
    const { data } = await this.client.issues.createMilestone({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      description: input.description,
      due_on: toGithubDueOn(input.dueOn),
    });
    return mapGithubMilestoneToDomain(data);
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<IMilestone> {
    const raw = await this.findRawMilestoneById(id);
    const { data } = await this.client.issues.updateMilestone({
      owner: this.owner,
      repo: this.repo,
      milestone_number: raw.number,
      title: patch.title,
      description: patch.description,
      state: patch.state,
      due_on: toGithubDueOn(patch.dueOn),
    });
    return mapGithubMilestoneToDomain(data);
  }

  async listLabels(_options?: FetchOptions): Promise<readonly string[]> {
    const labels = await this.paginateAll((page) =>
      this.client.issues.listLabelsForRepo({
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
        page,
      }),
    );
    return labels.map((label) => label.name);
  }

  async listLabelColors(_options?: FetchOptions): Promise<Readonly<Record<string, string>>> {
    const labels = await this.paginateAll((page) =>
      this.client.issues.listLabelsForRepo({
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
        page,
      }),
    );
    return Object.fromEntries(
      labels.flatMap((label) => (label.color ? [[label.name, label.color]] : [])),
    );
  }

  async listAssignableUsers(_options?: FetchOptions): Promise<readonly string[]> {
    const users = await this.paginateAll((page) =>
      this.client.issues.listAssignees({ owner: this.owner, repo: this.repo, per_page: 100, page }),
    );
    return users.map((user) => user.login);
  }
}
