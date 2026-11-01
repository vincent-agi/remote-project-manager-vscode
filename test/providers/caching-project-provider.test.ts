import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CachingProjectProvider } from "../../src/providers/caching-project-provider";
import type { IIssue } from "../../src/core/models/issue.model";
import type { IMilestone } from "../../src/core/models/milestone.model";
import type {
  IProjectProvider,
  ProviderCapabilities,
} from "../../src/core/providers/project-provider.interface";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const issue: IIssue = {
  id: "acme/widgets#1",
  number: 1,
  title: "Bug",
  body: "",
  state: "open",
  labels: [],
  assignees: [],
  milestoneId: null,
  url: "https://example.com/1",
  provider: "github",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  commentsCount: 0,
};

const milestone: IMilestone = {
  id: "1",
  number: 1,
  title: "v1.0",
  description: "",
  state: "open",
  dueOn: null,
  url: "https://example.com/m1",
  provider: "github",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const capabilities: ProviderCapabilities = {
  canReadIssues: true,
  canWriteIssues: true,
  canReadMilestones: true,
  canWriteMilestones: true,
};

function makeInner(): IProjectProvider {
  return {
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    getCurrentUser: vi.fn().mockResolvedValue({ username: "octocat" }),
    listIssues: vi.fn().mockResolvedValue([issue]),
    getIssue: vi.fn().mockResolvedValue(issue),
    createIssue: vi.fn().mockResolvedValue(issue),
    updateIssue: vi.fn().mockResolvedValue(issue),
    listMilestones: vi.fn().mockResolvedValue([milestone]),
    getMilestone: vi.fn().mockResolvedValue(milestone),
    createMilestone: vi.fn().mockResolvedValue(milestone),
    updateMilestone: vi.fn().mockResolvedValue(milestone),
    listLabels: vi.fn().mockResolvedValue(["bug"]),
    listAssignableUsers: vi.fn().mockResolvedValue(["octocat"]),
    listLabelColors: vi.fn().mockResolvedValue({}),
    listComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn(),
  };
}

describe("CachingProjectProvider.listIssues", () => {
  it("calls the inner provider once for repeated calls within the TTL", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listIssues();
    await provider.listIssues();

    expect(inner.listIssues).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listIssues();
    vi.advanceTimersByTime(60_001);
    await provider.listIssues();

    expect(inner.listIssues).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when forceRefresh is set", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listIssues();
    await provider.listIssues({ forceRefresh: true });

    expect(inner.listIssues).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent calls for the same key instead of issuing two fetches", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    const [a, b] = await Promise.all([provider.listIssues(), provider.listIssues()]);

    expect(inner.listIssues).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe("CachingProjectProvider.listMilestones and getCapabilities", () => {
  it("also cache their results independently", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listMilestones();
    await provider.listMilestones();
    await provider.getCapabilities();
    await provider.getCapabilities();

    expect(inner.listMilestones).toHaveBeenCalledTimes(1);
    expect(inner.getCapabilities).toHaveBeenCalledTimes(1);
  });
});

describe("CachingProjectProvider.listLabels and listAssignableUsers", () => {
  it("also cache their results independently", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listLabels();
    await provider.listLabels();
    await provider.listAssignableUsers();
    await provider.listAssignableUsers();

    expect(inner.listLabels).toHaveBeenCalledTimes(1);
    expect(inner.listAssignableUsers).toHaveBeenCalledTimes(1);
  });
});

describe("CachingProjectProvider write-through invalidation", () => {
  it("invalidates cached lists after updateIssue", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listIssues();
    await provider.updateIssue(issue.id, { state: "closed" });
    await provider.listIssues();

    expect(inner.listIssues).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached lists after createMilestone", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listMilestones();
    await provider.createMilestone({ title: "v2.0" });
    await provider.listMilestones();

    expect(inner.listMilestones).toHaveBeenCalledTimes(2);
  });
});

describe("CachingProjectProvider passthroughs", () => {
  it("does not cache getIssue, getMilestone, or getCurrentUser", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.getIssue(issue.id);
    await provider.getIssue(issue.id);
    await provider.getMilestone(milestone.id);
    await provider.getCurrentUser();

    expect(inner.getIssue).toHaveBeenCalledTimes(2);
    expect(inner.getMilestone).toHaveBeenCalledTimes(1);
    expect(inner.getCurrentUser).toHaveBeenCalledTimes(1);
  });
});

describe("CachingProjectProvider comments", () => {
  it("reads comments straight through, uncached", async () => {
    const inner = makeInner();
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listComments("x#1");
    await provider.listComments("x#1");

    expect(inner.listComments).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached issue list after a comment is added", async () => {
    const inner = makeInner();
    (inner.addComment as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "1" });
    const provider = new CachingProjectProvider(inner, 60_000);

    await provider.listIssues();
    await provider.addComment("x#1", "hi");
    await provider.listIssues();

    expect(inner.listIssues).toHaveBeenCalledTimes(2);
  });
});
