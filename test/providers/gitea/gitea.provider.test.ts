import { describe, expect, it, vi } from "vitest";
import type { GiteaClient } from "../../../src/providers/gitea/gitea.client";
import { GiteaProvider } from "../../../src/providers/gitea/gitea.provider";

type Handler = (
  method: string,
  path: string,
  options?: { query?: Record<string, unknown>; body?: unknown },
) => unknown;

/** A fake client answering from a routing function; records every call. */
function makeClient(handler: Handler) {
  const request = vi.fn((method: string, path: string, options?: never) =>
    Promise.resolve(handler(method, path, options)),
  );
  return { client: { request } as unknown as GiteaClient, request };
}

const WEB = "https://git.example.com/acme/widgets";
const provider = (client: GiteaClient) => new GiteaProvider(client, "acme", "widgets", WEB);

const rawIssue = {
  number: 42,
  title: "Bug",
  body: "desc",
  state: "open",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [{ login: "tea" }],
  milestone: { id: 7 },
  html_url: "https://git.example.com/acme/widgets/issues/42",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  comments: 3,
};

const rawMilestone = {
  id: 7,
  title: "v1.0",
  description: "first",
  state: "open",
  due_on: "2026-06-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
};

describe("GiteaProvider identity and capabilities", () => {
  it("returns the authenticated login", async () => {
    const { client } = makeClient(() => ({ login: "tea" }));
    expect(await provider(client).getCurrentUser()).toEqual({ username: "tea" });
  });

  it("maps push (or admin) permission to write access", async () => {
    const write = makeClient(() => ({ permissions: { pull: true, push: true } }));
    expect(await provider(write.client).getCapabilities()).toEqual({
      canReadIssues: true,
      canWriteIssues: true,
      canReadMilestones: true,
      canWriteMilestones: true,
    });
    const readOnly = makeClient(() => ({ permissions: { pull: true, push: false } }));
    expect((await provider(readOnly.client).getCapabilities()).canWriteIssues).toBe(false);
    const admin = makeClient(() => ({ permissions: { admin: true } }));
    expect((await provider(admin.client).getCapabilities()).canWriteMilestones).toBe(true);
  });
});

describe("GiteaProvider issues", () => {
  it("lists issues across pages until an empty page, skipping pull requests", async () => {
    const { client, request } = makeClient((_method, _path, options) => {
      const page = options?.query?.page;
      if (page === 1) {
        return [rawIssue, { ...rawIssue, number: 43, pull_request: {} }];
      }
      if (page === 2) {
        return [{ ...rawIssue, number: 44 }];
      }
      return [];
    });
    const issues = await provider(client).listIssues();
    expect(issues.map((issue) => issue.number)).toEqual([42, 44]);
    expect(request).toHaveBeenCalledWith("GET", "/repos/acme/widgets/issues", {
      query: { state: "all", type: "issues", page: 1, limit: 50 },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("maps an issue to the domain model", async () => {
    const { client } = makeClient(() => rawIssue);
    expect(await provider(client).getIssue("acme/widgets#42")).toEqual({
      id: "acme/widgets#42",
      number: 42,
      title: "Bug",
      body: "desc",
      state: "open",
      labels: ["bug"],
      assignees: ["tea"],
      milestoneId: "7",
      url: rawIssue.html_url,
      provider: "gitea",
      createdAt: rawIssue.created_at,
      updatedAt: rawIssue.updated_at,
      closedAt: null,
      commentsCount: 3,
    });
  });

  it("tolerates missing optional fields", async () => {
    const { client } = makeClient(() => ({
      ...rawIssue,
      body: null,
      labels: null,
      assignees: null,
      milestone: null,
      comments: undefined,
    }));
    const issue = await provider(client).getIssue("acme/widgets#42");
    expect(issue).toMatchObject({
      body: "",
      labels: [],
      assignees: [],
      milestoneId: null,
      commentsCount: 0,
    });
  });

  it("rejects a malformed issue id", async () => {
    const { client } = makeClient(() => rawIssue);
    await expect(provider(client).getIssue("nope")).rejects.toThrow(/Not a valid Gitea issue id/);
  });

  it("creates an issue sending label ids resolved from names (case-insensitive)", async () => {
    const { client, request } = makeClient((method, path, options) => {
      if (path.endsWith("/labels")) {
        return options?.query?.page === 1
          ? [
              { id: 5, name: "Bug" },
              { id: 6, name: "ui" },
            ]
          : [];
      }
      return rawIssue;
    });
    await provider(client).createIssue({
      title: "T",
      body: "B",
      labels: ["bug", "UI"],
      assignees: ["tea"],
      milestoneId: "7",
    });
    expect(request).toHaveBeenLastCalledWith("POST", "/repos/acme/widgets/issues", {
      body: { title: "T", body: "B", labels: [5, 6], assignees: ["tea"], milestone: 7 },
    });
  });

  it("fails clearly on an unknown label instead of dropping it", async () => {
    const { client } = makeClient((method, path) => (path.endsWith("/labels") ? [] : rawIssue));
    await expect(
      provider(client).createIssue({ title: "T", body: "", labels: ["ghost"] }),
    ).rejects.toThrow(/No label named 'ghost'/);
  });

  it("edits fields with PATCH and clears the milestone with 0", async () => {
    const { client, request } = makeClient(() => rawIssue);
    await provider(client).updateIssue("acme/widgets#42", {
      title: "New",
      state: "closed",
      assignees: ["tea"],
      milestoneId: null,
    });
    expect(request).toHaveBeenCalledWith("PATCH", "/repos/acme/widgets/issues/42", {
      body: { title: "New", state: "closed", assignees: ["tea"], milestone: 0 },
    });
  });

  it("changes labels through their own endpoint and returns the fresh issue", async () => {
    const { client, request } = makeClient((method, path, options) => {
      if (path.endsWith("/labels") && method === "GET") {
        return options?.query?.page === 1 ? [{ id: 9, name: "bug" }] : [];
      }
      return rawIssue;
    });
    await provider(client).updateIssue("acme/widgets#42", { labels: ["bug"] });
    expect(request).toHaveBeenCalledWith("PUT", "/repos/acme/widgets/issues/42/labels", {
      body: { labels: [9] },
    });
    expect(request.mock.calls.some((c) => c[0] === "PATCH")).toBe(false);
    expect(request).toHaveBeenLastCalledWith("GET", "/repos/acme/widgets/issues/42");
  });
});

describe("GiteaProvider comments", () => {
  const rawComment = {
    id: 3,
    user: { login: "tea" },
    body: "hi",
    created_at: "2026-02-01T00:00:00Z",
    html_url: "https://git.example.com/acme/widgets/issues/42#issuecomment-3",
  };

  it("lists comments, mapping a deleted author to ghost", async () => {
    const { client } = makeClient((_m, _p, options) =>
      options?.query?.page === 1 ? [rawComment, { ...rawComment, id: 4, user: null }] : [],
    );
    const comments = await provider(client).listComments("acme/widgets#42");
    expect(comments.map((comment) => [comment.id, comment.author])).toEqual([
      ["3", "tea"],
      ["4", "ghost"],
    ]);
  });

  it("posts a comment", async () => {
    const { client, request } = makeClient(() => rawComment);
    const comment = await provider(client).addComment("acme/widgets#42", "hi");
    expect(request).toHaveBeenCalledWith("POST", "/repos/acme/widgets/issues/42/comments", {
      body: { body: "hi" },
    });
    expect(comment.url).toBe(rawComment.html_url);
  });
});

describe("GiteaProvider milestones", () => {
  it("maps milestones, using the id as the number and building the web link", async () => {
    const { client } = makeClient((_m, _p, options) =>
      options?.query?.page === 1 ? [rawMilestone] : [],
    );
    const [milestone] = await provider(client).listMilestones();
    expect(milestone).toEqual({
      id: "7",
      number: 7,
      title: "v1.0",
      description: "first",
      state: "open",
      dueOn: "2026-06-01T00:00:00Z",
      url: `${WEB}/milestone/7`,
      provider: "gitea",
      createdAt: rawMilestone.created_at,
      updatedAt: rawMilestone.updated_at,
    });
  });

  it("creates a milestone with a full due date-time", async () => {
    const { client, request } = makeClient(() => rawMilestone);
    await provider(client).createMilestone({ title: "v1", description: "d", dueOn: "2026-06-01" });
    expect(request).toHaveBeenCalledWith("POST", "/repos/acme/widgets/milestones", {
      body: { title: "v1", description: "d", due_on: "2026-06-01T00:00:00Z" },
    });
  });

  it("updates a milestone, clearing the due date with null", async () => {
    const { client, request } = makeClient(() => rawMilestone);
    await provider(client).updateMilestone("7", { state: "closed", dueOn: null });
    expect(request).toHaveBeenCalledWith("PATCH", "/repos/acme/widgets/milestones/7", {
      body: { state: "closed", due_on: null },
    });
  });
});

describe("GiteaProvider labels and assignees", () => {
  it("lists label names and colours (without #)", async () => {
    const labels = [
      { id: 1, name: "bug", color: "#d73a4a" },
      { id: 2, name: "plain" },
    ];
    const { client } = makeClient((_m, _p, options) => (options?.query?.page === 1 ? labels : []));
    expect(await provider(client).listLabels()).toEqual(["bug", "plain"]);
    expect(await provider(client).listLabelColors()).toEqual({ bug: "d73a4a" });
  });

  it("lists assignable users", async () => {
    const { client } = makeClient((_m, _p, options) =>
      options?.query?.page === 1 ? [{ login: "tea" }] : [],
    );
    expect(await provider(client).listAssignableUsers()).toEqual(["tea"]);
  });
});
