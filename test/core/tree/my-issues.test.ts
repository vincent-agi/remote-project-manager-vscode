import { describe, expect, it } from "vitest";
import {
  buildIssueDescription,
  buildIssueTooltip,
  escapeMarkdown,
  groupMyIssues,
  priorityOf,
  selectMyOpenIssues,
  workStatusOf,
  type MyIssueSummary,
} from "../../../src/core/tree/my-issues";
import { priorityOf as webviewPriorityOf } from "../../../src/webview-ui/issue-view-model";
import type { IIssue } from "../../../src/core/models/issue.model";

function makeIssue(overrides: Partial<IIssue> = {}): IIssue {
  return {
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
    ...overrides,
  };
}

describe("selectMyOpenIssues", () => {
  it("keeps only open issues assigned to the given username", () => {
    const issues = [
      makeIssue({ id: "1", number: 1, assignees: ["octocat"] }),
      makeIssue({ id: "2", number: 2, assignees: ["someone-else"] }),
      makeIssue({ id: "3", number: 3, state: "closed", assignees: ["octocat"] }),
    ];

    expect(selectMyOpenIssues(issues, "octocat")).toEqual([
      {
        id: "1",
        number: 1,
        title: "Bug",
        url: "https://example.com/1",
        labels: [],
        milestoneId: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("matches usernames case-insensitively", () => {
    const issues = [makeIssue({ id: "1", number: 1, assignees: ["OctoCat"] })];

    expect(selectMyOpenIssues(issues, "octocat")).toHaveLength(1);
  });

  it("sorts by issue number ascending", () => {
    const issues = [
      makeIssue({ id: "2", number: 20, assignees: ["octocat"] }),
      makeIssue({ id: "1", number: 5, assignees: ["octocat"] }),
    ];

    expect(selectMyOpenIssues(issues, "octocat").map((issue) => issue.number)).toEqual([5, 20]);
  });

  it("returns an empty list when nothing is assigned to the user", () => {
    const issues = [makeIssue({ assignees: ["someone-else"] })];

    expect(selectMyOpenIssues(issues, "octocat")).toEqual([]);
  });
});

function summary(number: number, labels: string[] = []): MyIssueSummary {
  return {
    id: `id-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://example.com/${number}`,
    labels,
    milestoneId: null,
    updatedAt: "2026-02-03T10:00:00Z",
  };
}

describe("workStatusOf", () => {
  it("derives the status from labels, blocked winning over in-progress", () => {
    expect(workStatusOf([])).toBe("todo");
    expect(workStatusOf(["In-Progress"])).toBe("in-progress");
    expect(workStatusOf(["in-progress", "Blocked"])).toBe("blocked");
  });
});

describe("groupMyIssues", () => {
  it("orders groups In progress / To do / Blocked and omits empty ones", () => {
    const groups = groupMyIssues([
      summary(1, ["blocked"]),
      summary(2),
      summary(3, ["in-progress"]),
    ]);
    expect(
      groups.map((group) => `${group.label}:${group.issues.map((i) => i.number).join(",")}`),
    ).toEqual(["In progress:3", "To do:2", "Blocked:1"]);
    expect(groupMyIssues([summary(2)]).map((group) => group.label)).toEqual(["To do"]);
    expect(groupMyIssues([])).toEqual([]);
  });

  it("sorts inside a group by priority, then number", () => {
    const [group] = groupMyIssues([
      summary(5),
      summary(4, ["priority: low"]),
      summary(9, ["P0"]),
      summary(3, ["priority: low"]),
    ]);
    expect(group.issues.map((issue) => issue.number)).toEqual([9, 3, 4, 5]);
  });
});

describe("priority parity with the webview implementation", () => {
  const cases = [
    [],
    ["bug"],
    ["priority: high"],
    ["priority/low"],
    ["priority-critical"],
    ["P0"],
    ["p2"],
    ["p4"],
    ["urgent"],
    ["blocker"],
    ["high"],
    ["bug", "priority: low", "priority: high"],
    ["Priority : Medium"],
  ];
  it.each(cases)("agrees for %j", (...labels) => {
    expect(priorityOf(labels)?.rank ?? null).toBe(webviewPriorityOf(labels)?.rank ?? null);
    expect(priorityOf(labels)?.title ?? null).toBe(webviewPriorityOf(labels)?.title ?? null);
  });
});

describe("tooltip and description", () => {
  it("escapes Markdown in the title and milestone", () => {
    expect(escapeMarkdown("a*b_c [d](e)")).toBe("a\\*b\\_c \\[d\\]\\(e\\)");
    const tooltip = buildIssueTooltip({ ...summary(7), title: "Fix *bold* [x](y)" }, "v1 [beta]");
    expect(tooltip).toContain("**#7 Fix \\*bold\\* \\[x\\]\\(y\\)**");
    expect(tooltip).toContain("Milestone: v1 \\[beta\\]");
  });

  it("lists status, priority, labels and update date", () => {
    const tooltip = buildIssueTooltip(summary(1, ["in-progress", "priority: high"]), null);
    expect(tooltip).toContain("Status: in progress");
    expect(tooltip).toContain("Priority: High");
    expect(tooltip).toContain("`in-progress`, `priority: high`");
    expect(tooltip).toContain("Updated: 2026-02-03");
    expect(tooltip).not.toContain("Milestone:");
  });

  it("joins milestone and priority in the description", () => {
    expect(buildIssueDescription(summary(1, ["P1"]), "v1.0")).toBe("v1.0 · High");
    expect(buildIssueDescription(summary(1), "v1.0")).toBe("v1.0");
    expect(buildIssueDescription(summary(1), null)).toBe("");
  });
});
