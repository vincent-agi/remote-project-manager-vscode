import { describe, expect, it, vi } from "vitest";
import { PanelController } from "../../src/webview/panel-controller";
import type {
  IProjectProvider,
  ProviderCapabilities,
} from "../../src/core/providers/project-provider.interface";
import type { IIssue } from "../../src/core/models/issue.model";
import type { IMilestone } from "../../src/core/models/milestone.model";

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

function makeProvider(capabilities: ProviderCapabilities): IProjectProvider {
  return {
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    getCurrentUser: vi.fn().mockResolvedValue({ username: "octocat" }),
    listIssues: vi.fn().mockResolvedValue([issue]),
    getIssue: vi.fn().mockResolvedValue(issue),
    createIssue: vi.fn().mockResolvedValue(issue),
    updateIssue: vi.fn().mockResolvedValue({ ...issue, state: "closed" }),
    listMilestones: vi.fn().mockResolvedValue([milestone]),
    getMilestone: vi.fn(),
    createMilestone: vi.fn().mockResolvedValue(milestone),
    updateMilestone: vi.fn().mockResolvedValue({ ...milestone, state: "closed" }),
    listLabels: vi.fn().mockResolvedValue(["bug"]),
    listAssignableUsers: vi.fn().mockResolvedValue(["octocat"]),
  };
}

const fullAccess: ProviderCapabilities = {
  canReadIssues: true,
  canWriteIssues: true,
  canReadMilestones: true,
  canWriteMilestones: true,
};

const readOnly: ProviderCapabilities = {
  canReadIssues: true,
  canWriteIssues: false,
  canReadMilestones: true,
  canWriteMilestones: false,
};

describe("PanelController.handleMessage 'requestState'", () => {
  it("posts capabilities, issues, and milestones", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({ type: "requestState" });

    expect(postMessage).toHaveBeenCalledWith({
      type: "state",
      issues: [issue],
      milestones: [milestone],
      capabilities: fullAccess,
      currentUser: { username: "octocat" },
      availableLabels: ["bug"],
      availableAssignableUsers: ["octocat"],
    });
  });
});

describe("PanelController.handleMessage 'requestState' with forceRefresh", () => {
  it("forwards forceRefresh to the provider's read methods", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({ type: "requestState", forceRefresh: true });

    expect(provider.listIssues).toHaveBeenCalledWith({ forceRefresh: true });
    expect(provider.listMilestones).toHaveBeenCalledWith({ forceRefresh: true });
    expect(provider.getCapabilities).toHaveBeenCalledWith({ forceRefresh: true });
    expect(provider.listLabels).toHaveBeenCalledWith({ forceRefresh: true });
    expect(provider.listAssignableUsers).toHaveBeenCalledWith({ forceRefresh: true });
  });
});

describe("PanelController getCurrentUser caching", () => {
  it("fetches the current user once and reuses it across repeated requestState calls", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({ type: "requestState" });
    await controller.handleMessage({ type: "requestState", forceRefresh: true });
    await controller.handleMessage({ type: "createIssue", input: { title: "New", body: "" } });

    expect(provider.getCurrentUser).toHaveBeenCalledTimes(1);
  });
});

describe("PanelController.handleMessage 'updateIssue'", () => {
  it("updates and re-sends state when the account can write", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({
      type: "updateIssue",
      id: issue.id,
      patch: { state: "closed" },
    });

    expect(provider.updateIssue).toHaveBeenCalledWith(issue.id, { state: "closed" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }));
  });

  it("sends an error and does not call the provider when read-only", async () => {
    const provider = makeProvider(readOnly);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({
      type: "updateIssue",
      id: issue.id,
      patch: { state: "closed" },
    });

    expect(provider.updateIssue).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringMatching(/canWriteIssues/),
    });
  });
});

describe("PanelController.handleMessage 'createIssue'", () => {
  it("creates and re-sends state when the account can write", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({ type: "createIssue", input: { title: "New", body: "" } });

    expect(provider.createIssue).toHaveBeenCalledWith({ title: "New", body: "" });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "state" }));
  });
});

describe("PanelController.handleMessage 'updateMilestone'", () => {
  it("sends an error and does not call the provider when read-only", async () => {
    const provider = makeProvider(readOnly);
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({
      type: "updateMilestone",
      id: milestone.id,
      patch: { state: "closed" },
    });

    expect(provider.updateMilestone).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: expect.stringMatching(/canWriteMilestones/),
    });
  });
});

describe("PanelController.handleMessage 'createBranchForIssue'", () => {
  it("looks up the issue and forwards it to onCreateBranchRequest, toasting the result", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onCreateBranchRequest = vi
      .fn()
      .mockResolvedValue("Switched to new branch 'issue/1-bug'.");
    const controller = new PanelController(provider, postMessage, undefined, onCreateBranchRequest);

    await controller.handleMessage({ type: "requestState" });
    postMessage.mockClear();
    await controller.handleMessage({ type: "createBranchForIssue", id: issue.id });

    expect(onCreateBranchRequest).toHaveBeenCalledWith(issue);
    expect(postMessage).toHaveBeenCalledWith({
      type: "actionSuccess",
      message: "Switched to new branch 'issue/1-bug'.",
    });
  });

  it("stays silent when onCreateBranchRequest resolves null (user cancelled)", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onCreateBranchRequest = vi.fn().mockResolvedValue(null);
    const controller = new PanelController(provider, postMessage, undefined, onCreateBranchRequest);

    await controller.handleMessage({ type: "requestState" });
    postMessage.mockClear();
    await controller.handleMessage({ type: "createBranchForIssue", id: issue.id });

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("sends an error when the issue id is unknown", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onCreateBranchRequest = vi.fn();
    const controller = new PanelController(provider, postMessage, undefined, onCreateBranchRequest);

    await controller.handleMessage({ type: "requestState" });
    postMessage.mockClear();
    await controller.handleMessage({ type: "createBranchForIssue", id: "unknown" });

    expect(onCreateBranchRequest).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "error", message: "Issue not found." });
  });

  it("reports an error when onCreateBranchRequest throws", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onCreateBranchRequest = vi
      .fn()
      .mockRejectedValue(
        new Error("No workspace folder resolved for this repository; cannot create a branch."),
      );
    const controller = new PanelController(provider, postMessage, undefined, onCreateBranchRequest);

    await controller.handleMessage({ type: "requestState" });
    postMessage.mockClear();
    await controller.handleMessage({ type: "createBranchForIssue", id: issue.id });

    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "No workspace folder resolved for this repository; cannot create a branch.",
    });
  });
});

describe("PanelController issue transition hook", () => {
  it("does not notify on the very first state fetch (no baseline to diff against)", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onIssueTransition = vi.fn();
    const controller = new PanelController(provider, postMessage, onIssueTransition);

    await controller.handleMessage({ type: "requestState" });

    expect(onIssueTransition).not.toHaveBeenCalled();
  });

  it("notifies onIssueTransition when an update closes the issue", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onIssueTransition = vi.fn();
    const controller = new PanelController(provider, postMessage, onIssueTransition);

    // Establishes the baseline snapshot (open, no labels).
    await controller.handleMessage({ type: "requestState" });

    (provider.updateIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issue,
      state: "closed",
    });
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, state: "closed" },
    ]);

    await controller.handleMessage({
      type: "updateIssue",
      id: issue.id,
      patch: { state: "closed" },
    });

    expect(onIssueTransition).toHaveBeenCalledWith(
      expect.objectContaining({ state: "closed" }),
      "closed",
    );
  });

  it("detects a label added externally between two state fetches (e.g. via manual Refresh)", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onIssueTransition = vi.fn();
    const controller = new PanelController(provider, postMessage, onIssueTransition);

    // Baseline: no labels.
    await controller.handleMessage({ type: "requestState" });

    // Someone added the "in-progress" label directly on GitHub/GitLab;
    // the user then clicks Refresh in the panel.
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, labels: ["in-progress"] },
    ]);

    await controller.handleMessage({ type: "requestState", forceRefresh: true });

    expect(onIssueTransition).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["in-progress"] }),
      "started-in-progress",
    );
  });

  it("does not notify when nothing changed between two fetches", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onIssueTransition = vi.fn();
    const controller = new PanelController(provider, postMessage, onIssueTransition);

    await controller.handleMessage({ type: "requestState" });
    onIssueTransition.mockClear();
    await controller.handleMessage({ type: "requestState" });

    expect(onIssueTransition).not.toHaveBeenCalled();
  });

  it("does not notify when the transition is 'none' (e.g. a title-only edit)", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onIssueTransition = vi.fn();
    const controller = new PanelController(provider, postMessage, onIssueTransition);

    await controller.handleMessage({ type: "requestState" });

    (provider.updateIssue as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...issue,
      title: "Renamed",
    });
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, title: "Renamed" },
    ]);

    await controller.handleMessage({
      type: "updateIssue",
      id: issue.id,
      patch: { title: "Renamed" },
    });

    expect(onIssueTransition).not.toHaveBeenCalled();
  });
});

describe("PanelController new-assignment hook", () => {
  it("does not notify on the very first state fetch (no baseline to diff against)", async () => {
    const provider = makeProvider(fullAccess);
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, assignees: ["octocat"] },
    ]);
    const postMessage = vi.fn();
    const onNewAssignment = vi.fn();
    const controller = new PanelController(
      provider,
      postMessage,
      undefined,
      undefined,
      onNewAssignment,
    );

    await controller.handleMessage({ type: "requestState" });

    expect(onNewAssignment).not.toHaveBeenCalled();
  });

  it("notifies when the current user is newly added to an issue's assignees", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onNewAssignment = vi.fn();
    const controller = new PanelController(
      provider,
      postMessage,
      undefined,
      undefined,
      onNewAssignment,
    );

    // Baseline: unassigned.
    await controller.handleMessage({ type: "requestState" });

    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, assignees: ["octocat"] },
    ]);
    await controller.handleMessage({ type: "requestState", forceRefresh: true });

    expect(onNewAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ assignees: ["octocat"] }),
    );
  });

  it("does not notify when a different user is assigned", async () => {
    const provider = makeProvider(fullAccess);
    const postMessage = vi.fn();
    const onNewAssignment = vi.fn();
    const controller = new PanelController(
      provider,
      postMessage,
      undefined,
      undefined,
      onNewAssignment,
    );

    await controller.handleMessage({ type: "requestState" });

    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, assignees: ["someone-else"] },
    ]);
    await controller.handleMessage({ type: "requestState", forceRefresh: true });

    expect(onNewAssignment).not.toHaveBeenCalled();
  });

  it("does not notify when the user was already assigned", async () => {
    const provider = makeProvider(fullAccess);
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, assignees: ["octocat"] },
    ]);
    const postMessage = vi.fn();
    const onNewAssignment = vi.fn();
    const controller = new PanelController(
      provider,
      postMessage,
      undefined,
      undefined,
      onNewAssignment,
    );

    await controller.handleMessage({ type: "requestState" });
    onNewAssignment.mockClear();
    (provider.listIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...issue, assignees: ["octocat"], title: "Renamed" },
    ]);
    await controller.handleMessage({ type: "requestState", forceRefresh: true });

    expect(onNewAssignment).not.toHaveBeenCalled();
  });
});

describe("PanelController error handling", () => {
  it("posts an error message when the provider throws", async () => {
    const provider = makeProvider(fullAccess);
    (provider.listIssues as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const postMessage = vi.fn();
    const controller = new PanelController(provider, postMessage);

    await controller.handleMessage({ type: "requestState" });

    expect(postMessage).toHaveBeenCalledWith({ type: "error", message: "network down" });
  });

  it("also invokes onError with the raw error, alongside posting the error message", async () => {
    const provider = makeProvider(fullAccess);
    const authError = new Error("401 Unauthorized");
    (provider.listIssues as ReturnType<typeof vi.fn>).mockRejectedValue(authError);
    const postMessage = vi.fn();
    const onError = vi.fn();
    const controller = new PanelController(
      provider,
      postMessage,
      undefined,
      undefined,
      undefined,
      onError,
    );

    await controller.handleMessage({ type: "requestState" });

    expect(onError).toHaveBeenCalledWith(authError);
    expect(postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "401 Unauthorized",
      authError: true,
    });
  });
});

describe("PanelController UI preferences", () => {
  it("posts the stored preferences before the state on requestState", async () => {
    const posted: { type: string }[] = [];
    const store = { get: vi.fn().mockReturnValue({ sort: "updated" }), set: vi.fn() };
    const controller = new PanelController(
      makeProvider(fullAccess),
      (message) => posted.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    await controller.handleMessage({ type: "requestState" });

    expect(posted.map((message) => message.type)).toEqual(["uiPrefs", "state"]);
    expect(posted[0]).toEqual({ type: "uiPrefs", prefs: { sort: "updated" } });
  });

  it("persists saved preferences without refetching", async () => {
    const provider = makeProvider(fullAccess);
    const store = { get: vi.fn().mockReturnValue({}), set: vi.fn() };
    const controller = new PanelController(
      provider,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    await controller.handleMessage({ type: "saveUiPrefs", prefs: { sort: "number" } });

    expect(store.set).toHaveBeenCalledWith({ sort: "number" });
    expect(provider.listIssues).not.toHaveBeenCalled();
  });

  it("ignores saveUiPrefs and skips uiPrefs when no store is wired", async () => {
    const posted: { type: string }[] = [];
    const controller = new PanelController(makeProvider(fullAccess), (message) =>
      posted.push(message),
    );

    await controller.handleMessage({ type: "saveUiPrefs", prefs: {} });
    await controller.handleMessage({ type: "requestState" });

    expect(posted.map((message) => message.type)).toEqual(["state"]);
  });
});

describe("PanelController connection feedback", () => {
  it("flags authentication failures so the webview can offer to reconnect", async () => {
    const provider = makeProvider(fullAccess);
    (provider.getCapabilities as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );
    const posted: { type: string; authError?: boolean }[] = [];
    const controller = new PanelController(provider, (message) => posted.push(message));

    await controller.handleMessage({ type: "requestState" });

    expect(posted.at(-1)).toMatchObject({ type: "error", authError: true });
  });

  it("does not flag other errors", async () => {
    const provider = makeProvider(fullAccess);
    (provider.listIssues as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const posted: { type: string; authError?: boolean }[] = [];
    const controller = new PanelController(provider, (message) => posted.push(message));

    await controller.handleMessage({ type: "requestState" });

    expect(posted.at(-1)?.authError).toBeUndefined();
  });

  it("includes the issue list's fetch time when the provider reports one", async () => {
    const provider = Object.assign(makeProvider(fullAccess), {
      getIssuesFetchedAt: () => 1234,
    });
    const posted: { type: string; dataFetchedAt?: number }[] = [];
    const controller = new PanelController(provider, (message) => posted.push(message));

    await controller.handleMessage({ type: "requestState" });

    expect(posted.find((message) => message.type === "state")?.dataFetchedAt).toBe(1234);
  });

  it("forwards a reconnect request", async () => {
    const onReconnect = vi.fn();
    const controller = new PanelController(
      makeProvider(fullAccess),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onReconnect,
    );

    await controller.handleMessage({ type: "reconnect" });

    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("PanelController issue templates", () => {
  it("answers requestIssueTemplates with the loaded templates", async () => {
    const posted: { type: string; templates?: unknown }[] = [];
    const templates = [{ name: "Bug", body: "b", labels: ["bug"] }];
    const controller = new PanelController(
      makeProvider(fullAccess),
      (message) => posted.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(templates),
    );

    await controller.handleMessage({ type: "requestIssueTemplates" });

    expect(posted).toEqual([{ type: "issueTemplates", templates }]);
  });

  it("falls back to an empty list when loading fails, and ignores the request without a loader", async () => {
    const posted: { type: string; templates?: unknown }[] = [];
    const failing = new PanelController(
      makeProvider(fullAccess),
      (message) => posted.push(message),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => Promise.reject(new Error("fs")),
    );
    await failing.handleMessage({ type: "requestIssueTemplates" });
    expect(posted).toEqual([{ type: "issueTemplates", templates: [] }]);

    const none = new PanelController(makeProvider(fullAccess), (message) => posted.push(message));
    await none.handleMessage({ type: "requestIssueTemplates" });
    expect(posted).toHaveLength(1);
  });
});
