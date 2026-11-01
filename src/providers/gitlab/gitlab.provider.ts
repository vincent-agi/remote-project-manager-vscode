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
  mapDomainIssueStateToGitlab,
  mapGitlabIssueToDomain,
  mapGitlabMilestoneToDomain,
  mapGitlabNoteToDomain,
  type RawGitlabIssue,
  type RawGitlabMilestone,
  type RawGitlabNote,
} from "./gitlab.mappers";

const DEVELOPER_ACCESS_LEVEL = 30;

/**
 * Minimal slice of the gitbeaker REST client this provider depends on.
 * Kept narrow so tests can supply a plain fake instead of a real
 * gitbeaker client instance.
 */
export interface GitlabClient {
  Issues: {
    all(params: { projectId: string; scope: "all" }): Promise<readonly RawGitlabIssue[]>;
    show(projectId: string, issueIid: number): Promise<RawGitlabIssue>;
    create(
      projectId: string,
      title: string,
      options: Record<string, unknown>,
    ): Promise<RawGitlabIssue>;
    edit(
      projectId: string,
      issueIid: number,
      options: Record<string, unknown>,
    ): Promise<RawGitlabIssue>;
  };
  IssueNotes: {
    all(projectId: string, issueIid: number): Promise<readonly RawGitlabNote[]>;
    create(projectId: string, issueIid: number, body: string): Promise<RawGitlabNote>;
  };
  ProjectMilestones: {
    all(projectId: string): Promise<readonly RawGitlabMilestone[]>;
    show(projectId: string, milestoneId: number): Promise<RawGitlabMilestone>;
    create(
      projectId: string,
      title: string,
      options: Record<string, unknown>,
    ): Promise<RawGitlabMilestone>;
    edit(
      projectId: string,
      milestoneId: number,
      options: Record<string, unknown>,
    ): Promise<RawGitlabMilestone>;
  };
  ProjectLabels: {
    all(projectId: string): Promise<readonly { name: string; color?: string }[]>;
  };
  ProjectMembers: {
    all(
      projectId: string,
      options?: { includeInherited?: boolean },
    ): Promise<readonly { id: number; username: string }[]>;
  };
  Projects: {
    show(projectId: string): Promise<{
      permissions?: {
        project_access?: { access_level: number } | null;
        group_access?: { access_level: number } | null;
      };
    }>;
  };
  Users: {
    showCurrentUser(): Promise<{ username: string }>;
  };
}

/**
 * GitLab connector implementing {@link IProjectProvider} on top of
 * gitbeaker. Issues are addressed by the composite id
 * `"namespace/project#iid"`, matching GitLab's issue endpoints which key
 * on the project-scoped `iid`. Milestones are addressed by GitLab's
 * internal `id` directly, since GitLab's milestone endpoints key on that
 * id rather than the milestone's `iid`.
 */
export class GitlabProvider implements IProjectProvider {
  constructor(
    private readonly client: GitlabClient,
    private readonly projectPath: string,
  ) {}

  private parseIssueIid(id: string): number {
    const match = id.match(/#(\d+)$/);
    if (!match) {
      throw new Error(`Not a valid GitLab issue id: '${id}'`);
    }
    return Number(match[1]);
  }

  async getCurrentUser(): Promise<IAuthenticatedUser> {
    const user = await this.client.Users.showCurrentUser();
    return { username: user.username };
  }

  async getCapabilities(_options?: FetchOptions): Promise<ProviderCapabilities> {
    const project = await this.client.Projects.show(this.projectPath);
    // GitLab can return both project_access and group_access at once
    // (direct grant plus inherited group grant); the effective
    // permission is the higher of the two, not "project_access if
    // present, else group_access".
    const accessLevel = Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    );
    const canWrite = accessLevel >= DEVELOPER_ACCESS_LEVEL;
    return {
      canReadIssues: true,
      canWriteIssues: canWrite,
      canReadMilestones: true,
      canWriteMilestones: canWrite,
    };
  }

  async listIssues(_options?: FetchOptions): Promise<readonly IIssue[]> {
    const rawIssues = await this.client.Issues.all({ projectId: this.projectPath, scope: "all" });
    return rawIssues.map((issue) => mapGitlabIssueToDomain(issue, this.projectPath));
  }

  async getIssue(id: string): Promise<IIssue> {
    const raw = await this.client.Issues.show(this.projectPath, this.parseIssueIid(id));
    return mapGitlabIssueToDomain(raw, this.projectPath);
  }

  /**
   * GitLab's issue endpoints take `assignee_ids` (numeric user ids), not
   * usernames. Resolve the domain model's usernames against the
   * project's members (case-insensitively, matching the convention used
   * elsewhere in this codebase). A username with no matching member is
   * silently dropped rather than failing the whole request.
   */
  private async resolveAssigneeIds(
    usernames: readonly string[] | undefined,
  ): Promise<number[] | undefined> {
    if (usernames === undefined) {
      return undefined;
    }
    if (usernames.length === 0) {
      return [];
    }
    // includeInherited: GitLab's plain /members endpoint (gitbeaker's
    // default) only lists direct members; access granted via a parent
    // group/subgroup — the common pattern on larger projects — needs
    // /members/all instead.
    const members = await this.client.ProjectMembers.all(this.projectPath, {
      includeInherited: true,
    });
    const idByUsername = new Map(
      members.map((member) => [member.username.toLowerCase(), member.id]),
    );
    return usernames
      .map((username) => idByUsername.get(username.toLowerCase()))
      .filter((id): id is number => id !== undefined);
  }

  async createIssue(input: CreateIssueInput): Promise<IIssue> {
    const raw = await this.client.Issues.create(this.projectPath, input.title, {
      description: input.body,
      labels: input.labels?.join(","),
      assignee_ids: await this.resolveAssigneeIds(input.assignees),
      milestone_id: input.milestoneId ?? undefined,
    });
    return mapGitlabIssueToDomain(raw, this.projectPath);
  }

  async updateIssue(id: string, patch: UpdateIssueInput): Promise<IIssue> {
    const raw = await this.client.Issues.edit(this.projectPath, this.parseIssueIid(id), {
      title: patch.title,
      description: patch.body,
      labels: patch.labels?.join(","),
      assignee_ids: await this.resolveAssigneeIds(patch.assignees),
      milestone_id: patch.milestoneId === undefined ? undefined : patch.milestoneId,
      state_event: patch.state
        ? mapDomainIssueStateToGitlab(patch.state) === "closed"
          ? "close"
          : "reopen"
        : undefined,
    });
    return mapGitlabIssueToDomain(raw, this.projectPath);
  }

  async listMilestones(_options?: FetchOptions): Promise<readonly IMilestone[]> {
    const rawMilestones = await this.client.ProjectMilestones.all(this.projectPath);
    return rawMilestones.map(mapGitlabMilestoneToDomain);
  }

  async getMilestone(id: string): Promise<IMilestone> {
    const raw = await this.client.ProjectMilestones.show(this.projectPath, Number(id));
    return mapGitlabMilestoneToDomain(raw);
  }

  async createMilestone(input: CreateMilestoneInput): Promise<IMilestone> {
    const raw = await this.client.ProjectMilestones.create(this.projectPath, input.title, {
      description: input.description,
      due_date: input.dueOn ?? undefined,
    });
    return mapGitlabMilestoneToDomain(raw);
  }

  async updateMilestone(id: string, patch: UpdateMilestoneInput): Promise<IMilestone> {
    const raw = await this.client.ProjectMilestones.edit(this.projectPath, Number(id), {
      title: patch.title,
      description: patch.description,
      due_date: patch.dueOn ?? undefined,
      state_event: patch.state ? (patch.state === "closed" ? "close" : "activate") : undefined,
    });
    return mapGitlabMilestoneToDomain(raw);
  }

  async listComments(issueId: string): Promise<readonly IComment[]> {
    const notes = await this.client.IssueNotes.all(this.projectPath, this.parseIssueIid(issueId));
    return notes
      .filter((note) => !note.system)
      .map(mapGitlabNoteToDomain)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async addComment(issueId: string, body: string): Promise<IComment> {
    const note = await this.client.IssueNotes.create(
      this.projectPath,
      this.parseIssueIid(issueId),
      body,
    );
    return mapGitlabNoteToDomain(note);
  }

  async listLabels(_options?: FetchOptions): Promise<readonly string[]> {
    const labels = await this.client.ProjectLabels.all(this.projectPath);
    return labels.map((label) => label.name);
  }

  async listLabelColors(_options?: FetchOptions): Promise<Readonly<Record<string, string>>> {
    const labels = await this.client.ProjectLabels.all(this.projectPath);
    return Object.fromEntries(
      labels.flatMap((label) => (label.color ? [[label.name, label.color.replace(/^#/, "")]] : [])),
    );
  }

  async listAssignableUsers(_options?: FetchOptions): Promise<readonly string[]> {
    const members = await this.client.ProjectMembers.all(this.projectPath, {
      includeInherited: true,
    });
    return members.map((member) => member.username);
  }
}
