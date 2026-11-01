import { describe, expect, it, vi } from "vitest";
import { GithubProvider, type GithubClient } from "../../../src/providers/github/github.provider";

function makeClient(overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn(),
      create: vi.fn(),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      createComment: vi.fn(),
      update: vi.fn(),
      listMilestones: vi.fn().mockResolvedValue({ data: [] }),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
      listAssignees: vi.fn().mockResolvedValue({ data: [] }),
    },
    repos: {
      get: vi.fn(),
    },
    users: {
      getAuthenticated: vi.fn(),
    },
    ...overrides,
  };
}

const rawIssue = {
  id: 1,
  number: 42,
  title: "Bug",
  body: "desc",
  state: "open" as const,
  labels: [],
  assignees: [],
  milestone: null,
  html_url: "https://github.com/acme/widgets/issues/42",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const rawPullRequest = { ...rawIssue, number: 43, pull_request: {} };

const rawMilestone = {
  id: 7,
  number: 3,
  title: "v1.0",
  description: "",
  state: "open" as const,
  due_on: null,
  html_url: "https://github.com/acme/widgets/milestone/3",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("GithubProvider.listIssues", () => {
  it("maps issues and excludes pull requests", async () => {
    const client = makeClient({
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: [rawIssue, rawPullRequest] }),
      } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const issues = await provider.listIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(42);
  });

  it("paginates through every page instead of only the first 100", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ ...rawIssue, number: i + 1 }));
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [{ ...rawIssue, number: 101 }] });
    const client = makeClient({ issues: { listForRepo } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const issues = await provider.listIssues();

    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(101);
    expect(issues[100].number).toBe(101);
  });
});

describe("GithubProvider.getIssue", () => {
  it("fetches by the number embedded in the composite id", async () => {
    const get = vi.fn().mockResolvedValue({ data: rawIssue });
    const client = makeClient({ issues: { get } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const issue = await provider.getIssue("acme/widgets#42");

    expect(get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", issue_number: 42 });
    expect(issue.id).toBe("acme/widgets#42");
  });
});

describe("GithubProvider.createIssue", () => {
  it("sends title and body and maps the response", async () => {
    const create = vi.fn().mockResolvedValue({ data: rawIssue });
    const client = makeClient({ issues: { create } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const issue = await provider.createIssue({ title: "Bug", body: "desc" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", title: "Bug", body: "desc" }),
    );
    expect((create.mock.calls[0][0] as { milestone?: unknown }).milestone).toBeUndefined();
    expect(issue.number).toBe(42);
  });

  it("resolves the milestone_number from milestoneId and sends it", async () => {
    const create = vi.fn().mockResolvedValue({ data: rawIssue });
    const listMilestones = vi.fn().mockResolvedValue({ data: [rawMilestone] });
    const client = makeClient({
      issues: { create, listMilestones } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    await provider.createIssue({ title: "Bug", body: "desc", milestoneId: "7" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ milestone: 3 }));
  });
});

describe("GithubProvider.updateIssue", () => {
  it("maps the domain state to GitHub's state field", async () => {
    const update = vi.fn().mockResolvedValue({ data: { ...rawIssue, state: "closed" } });
    const client = makeClient({ issues: { update } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const issue = await provider.updateIssue("acme/widgets#42", { state: "closed" });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        issue_number: 42,
        state: "closed",
      }),
    );
    expect(issue.state).toBe("closed");
  });
});

describe("GithubProvider.listMilestones", () => {
  it("maps milestones", async () => {
    const client = makeClient({
      issues: {
        listMilestones: vi.fn().mockResolvedValue({ data: [rawMilestone] }),
      } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const milestones = await provider.listMilestones();

    expect(milestones).toEqual([
      {
        id: "7",
        number: 3,
        title: "v1.0",
        description: "",
        state: "open",
        dueOn: null,
        url: "https://github.com/acme/widgets/milestone/3",
        provider: "github",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("paginates through every page instead of only the first 100", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ...rawMilestone,
      id: i + 1,
      number: i + 1,
    }));
    const listMilestones = vi
      .fn()
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [{ ...rawMilestone, id: 101, number: 101 }] });
    const client = makeClient({ issues: { listMilestones } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const milestones = await provider.listMilestones();

    expect(listMilestones).toHaveBeenCalledTimes(2);
    expect(milestones).toHaveLength(101);
  });
});

describe("GithubProvider.getMilestone", () => {
  it("finds the milestone by domain id among all milestones", async () => {
    const client = makeClient({
      issues: {
        listMilestones: vi.fn().mockResolvedValue({ data: [rawMilestone] }),
      } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const milestone = await provider.getMilestone("7");

    expect(milestone.title).toBe("v1.0");
  });

  it("throws when no milestone matches the id", async () => {
    const client = makeClient({
      issues: {
        listMilestones: vi.fn().mockResolvedValue({ data: [] }),
      } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    await expect(provider.getMilestone("999")).rejects.toThrow(/999/);
  });
});

describe("GithubProvider.createMilestone", () => {
  it("sends title and maps the response", async () => {
    const createMilestone = vi.fn().mockResolvedValue({ data: rawMilestone });
    const client = makeClient({ issues: { createMilestone } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const milestone = await provider.createMilestone({ title: "v1.0" });

    expect(createMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", title: "v1.0" }),
    );
    expect(milestone.id).toBe("7");
  });
});

describe("GithubProvider.updateMilestone", () => {
  it("resolves the milestone_number from the domain id, then updates", async () => {
    const listMilestones = vi.fn().mockResolvedValue({ data: [rawMilestone] });
    const updateMilestone = vi
      .fn()
      .mockResolvedValue({ data: { ...rawMilestone, state: "closed" } });
    const client = makeClient({
      issues: { listMilestones, updateMilestone } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const milestone = await provider.updateMilestone("7", { state: "closed" });

    expect(updateMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "widgets",
        milestone_number: 3,
        state: "closed",
      }),
    );
    expect(milestone.state).toBe("closed");
  });
});

describe("GithubProvider.listLabels", () => {
  it("returns label names", async () => {
    const listLabelsForRepo = vi
      .fn()
      .mockResolvedValue({ data: [{ name: "bug" }, { name: "docs" }] });
    const client = makeClient({
      issues: { listLabelsForRepo } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const labels = await provider.listLabels();

    expect(labels).toEqual(["bug", "docs"]);
  });

  it("paginates through every page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
    const listLabelsForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: fullPage })
      .mockResolvedValueOnce({ data: [{ name: "last" }] });
    const client = makeClient({
      issues: { listLabelsForRepo } as unknown as GithubClient["issues"],
    });
    const provider = new GithubProvider(client, "acme", "widgets");

    const labels = await provider.listLabels();

    expect(listLabelsForRepo).toHaveBeenCalledTimes(2);
    expect(labels).toHaveLength(101);
    expect(labels[100]).toBe("last");
  });
});

describe("GithubProvider.listAssignableUsers", () => {
  it("returns assignee logins", async () => {
    const listAssignees = vi.fn().mockResolvedValue({ data: [{ login: "octocat" }] });
    const client = makeClient({ issues: { listAssignees } as unknown as GithubClient["issues"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const users = await provider.listAssignableUsers();

    expect(users).toEqual(["octocat"]);
  });
});

describe("GithubProvider.getCurrentUser", () => {
  it("returns the authenticated account's login as username", async () => {
    const getAuthenticated = vi.fn().mockResolvedValue({ data: { login: "octocat" } });
    const client = makeClient({ users: { getAuthenticated } as unknown as GithubClient["users"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const user = await provider.getCurrentUser();

    expect(user).toEqual({ username: "octocat" });
  });
});

describe("GithubProvider.getCapabilities", () => {
  it("maps push permission to write capability", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: { permissions: { pull: true, push: true, admin: false } } });
    const client = makeClient({ repos: { get } as unknown as GithubClient["repos"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const capabilities = await provider.getCapabilities();

    expect(capabilities).toEqual({
      canReadIssues: true,
      canWriteIssues: true,
      canReadMilestones: true,
      canWriteMilestones: true,
    });
  });

  it("maps missing push permission to read-only", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: { permissions: { pull: true, push: false, admin: false } } });
    const client = makeClient({ repos: { get } as unknown as GithubClient["repos"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const capabilities = await provider.getCapabilities();

    expect(capabilities.canWriteIssues).toBe(false);
    expect(capabilities.canWriteMilestones).toBe(false);
  });

  it("maps the Triage role to issue write access, but not milestone write access", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: { permissions: { pull: true, push: false, triage: true } } });
    const client = makeClient({ repos: { get } as unknown as GithubClient["repos"] });
    const provider = new GithubProvider(client, "acme", "widgets");

    const capabilities = await provider.getCapabilities();

    expect(capabilities.canWriteIssues).toBe(true);
    expect(capabilities.canWriteMilestones).toBe(false);
  });
});

describe("GithubProvider comments", () => {
  const rawComment = {
    id: 9,
    user: { login: "octocat" },
    body: "hello",
    created_at: "2026-02-01T00:00:00Z",
    html_url: "https://github.com/acme/widgets/issues/42#issuecomment-9",
  };

  it("lists comments for the issue number encoded in the id and maps them", async () => {
    const listComments = vi
      .fn()
      .mockResolvedValue({ data: [rawComment, { ...rawComment, id: 10, user: null, body: null }] });
    const client = makeClient();
    client.issues.listComments = listComments;
    const provider = new GithubProvider(client, "acme", "widgets");

    const comments = await provider.listComments("acme/widgets#42");

    expect(listComments).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      per_page: 100,
      page: 1,
    });
    expect(comments).toEqual([
      {
        id: "9",
        author: "octocat",
        body: "hello",
        createdAt: "2026-02-01T00:00:00Z",
        url: rawComment.html_url,
      },
      {
        id: "10",
        author: "ghost",
        body: "",
        createdAt: "2026-02-01T00:00:00Z",
        url: rawComment.html_url,
      },
    ]);
  });

  it("paginates comment lists past 100 items", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ ...rawComment, id: index }));
    const listComments = vi
      .fn()
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: [{ ...rawComment, id: 500 }] });
    const client = makeClient();
    client.issues.listComments = listComments;

    const comments = await new GithubProvider(client, "acme", "widgets").listComments(
      "acme/widgets#42",
    );

    expect(comments).toHaveLength(101);
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it("posts a comment and maps the result", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: rawComment });
    const client = makeClient();
    client.issues.createComment = createComment;

    const comment = await new GithubProvider(client, "acme", "widgets").addComment(
      "acme/widgets#42",
      "hello",
    );

    expect(createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      issue_number: 42,
      body: "hello",
    });
    expect(comment.id).toBe("9");
  });

  it("rejects a malformed issue id", async () => {
    await expect(
      new GithubProvider(makeClient(), "acme", "widgets").listComments("nope"),
    ).rejects.toThrow(/Not a valid GitHub issue id/);
  });
});

describe("GithubProvider.listLabelColors", () => {
  it("maps label names to their colours, skipping labels without one", async () => {
    const client = makeClient();
    client.issues.listLabelsForRepo = vi.fn().mockResolvedValue({
      data: [{ name: "bug", color: "d73a4a" }, { name: "plain" }],
    });
    expect(await new GithubProvider(client, "acme", "widgets").listLabelColors()).toEqual({
      bug: "d73a4a",
    });
  });
});
