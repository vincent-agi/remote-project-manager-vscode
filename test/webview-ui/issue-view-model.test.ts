import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  filterIssues,
  matchesQuery,
  NO_MILESTONE,
  PRESET_FILTERS,
  readSavedFilters,
  removeSavedFilter,
  sameFilter,
  upsertSavedFilter,
  groupIssues,
  priorityOf,
  readListPrefs,
  sortIssues,
  type IssueLike,
} from "../../src/webview-ui/issue-view-model";

function issue(overrides: Partial<IssueLike> & { number: number }): IssueLike {
  return {
    id: `id-${overrides.number}`,
    title: "Title",
    body: "",
    state: "open",
    labels: [],
    assignees: [],
    milestoneId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const issues = [
  issue({ number: 1, title: "Login fails", labels: ["bug"], assignees: ["me"], milestoneId: "m1" }),
  issue({ number: 2, title: "Add dark mode", body: "theme support", state: "closed" }),
  issue({ number: 3, title: "Refactor", labels: ["tech-debt"], assignees: ["other"] }),
];

describe("matchesQuery", () => {
  it("matches title, body and labels case-insensitively", () => {
    expect(matchesQuery(issues[0], "LOGIN")).toBe(true);
    expect(matchesQuery(issues[1], "theme")).toBe(true);
    expect(matchesQuery(issues[0], "bug")).toBe(true);
  });

  it("requires every word to match somewhere", () => {
    expect(matchesQuery(issues[0], "login bug")).toBe(true);
    expect(matchesQuery(issues[0], "login nope")).toBe(false);
  });

  it("matches the issue number with or without #", () => {
    expect(matchesQuery(issues[2], "#3")).toBe(true);
    expect(matchesQuery(issues[2], "3")).toBe(true);
    expect(matchesQuery(issues[2], "#4")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesQuery(issues[0], "   ")).toBe(true);
  });
});

describe("filterIssues", () => {
  it("returns everything for the empty filter", () => {
    expect(filterIssues(issues, EMPTY_FILTER, "me")).toHaveLength(3);
  });

  it("filters by state, label and assignee (@me resolves to the current user)", () => {
    expect(
      filterIssues(issues, { ...EMPTY_FILTER, state: "closed" }, "me").map((i) => i.number),
    ).toEqual([2]);
    expect(
      filterIssues(issues, { ...EMPTY_FILTER, label: "bug" }, "me").map((i) => i.number),
    ).toEqual([1]);
    expect(
      filterIssues(issues, { ...EMPTY_FILTER, assignee: "@me" }, "me").map((i) => i.number),
    ).toEqual([1]);
    expect(filterIssues(issues, { ...EMPTY_FILTER, assignee: "@me" }, null)).toEqual([]);
  });

  it("filters by milestone, including 'no milestone'", () => {
    expect(
      filterIssues(issues, { ...EMPTY_FILTER, milestone: "m1" }, "me").map((i) => i.number),
    ).toEqual([1]);
    expect(
      filterIssues(issues, { ...EMPTY_FILTER, milestone: NO_MILESTONE }, "me").map((i) => i.number),
    ).toEqual([2, 3]);
  });

  it("combines criteria with AND", () => {
    const result = filterIssues(
      issues,
      { ...EMPTY_FILTER, query: "refactor", state: "open" },
      "me",
    );
    expect(result.map((i) => i.number)).toEqual([3]);
  });
});

describe("presets", () => {
  it("'My open issues' selects only open issues assigned to me", () => {
    const preset = PRESET_FILTERS.find((p) => p.name === "My open issues")!;
    expect(filterIssues(issues, preset.filter, "me").map((i) => i.number)).toEqual([1]);
  });

  it("'No milestone' selects issues without a milestone", () => {
    const preset = PRESET_FILTERS.find((p) => p.name === "No milestone")!;
    expect(filterIssues(issues, preset.filter, "me").map((i) => i.number)).toEqual([2, 3]);
  });
});

describe("saved filters", () => {
  const filter = { ...EMPTY_FILTER, label: "bug" };

  it("round-trips through the stored prefs and drops malformed entries", () => {
    const saved = readSavedFilters({
      savedFilters: [
        { name: "Bugs", filter },
        { name: "Bugs", filter: EMPTY_FILTER },
        { name: "", filter },
        { name: "Bad", filter: { query: 1 } },
        "nope",
        null,
      ],
    });
    expect(saved).toEqual([{ name: "Bugs", filter }]);
    expect(readSavedFilters({})).toEqual([]);
    expect(readSavedFilters({ savedFilters: "x" })).toEqual([]);
  });

  it("upserts by name and rejects blank or preset names", () => {
    const first = upsertSavedFilter([], " Bugs ", filter)!;
    expect(first).toEqual([{ name: "Bugs", filter }]);
    const replaced = upsertSavedFilter(first, "Bugs", EMPTY_FILTER)!;
    expect(replaced).toEqual([{ name: "Bugs", filter: EMPTY_FILTER }]);
    expect(upsertSavedFilter(first, "  ", filter)).toBeNull();
    expect(upsertSavedFilter(first, "My open issues", filter)).toBeNull();
  });

  it("removes by name", () => {
    expect(removeSavedFilter([{ name: "Bugs", filter }], "Bugs")).toEqual([]);
  });

  it("compares filters structurally, ignoring surrounding query whitespace", () => {
    expect(sameFilter(filter, { ...filter, query: "  " })).toBe(true);
    expect(sameFilter(filter, EMPTY_FILTER)).toBe(false);
  });
});

describe("priorityOf", () => {
  it("reads common priority label conventions", () => {
    expect(priorityOf(["priority: high"])?.title).toBe("High");
    expect(priorityOf(["priority/low"])?.title).toBe("Low");
    expect(priorityOf(["priority-critical"])?.title).toBe("Critical");
    expect(priorityOf(["P0"])?.title).toBe("Critical");
    expect(priorityOf(["p2"])?.title).toBe("Medium");
    expect(priorityOf(["urgent"])?.rank).toBe(0);
  });

  it("picks the most urgent label and ignores unrelated ones", () => {
    expect(priorityOf(["bug", "priority: low", "priority: high"])?.title).toBe("High");
    expect(priorityOf(["bug", "high"])).toBeNull();
    expect(priorityOf([])).toBeNull();
  });
});

describe("sortIssues", () => {
  const list = [
    issue({
      number: 1,
      title: "b",
      updatedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-01-02T00:00:00Z",
    }),
    issue({
      number: 2,
      title: "A",
      updatedAt: "2026-05-01T00:00:00Z",
      createdAt: "2026-01-03T00:00:00Z",
      labels: ["priority: high"],
    }),
    issue({
      number: 3,
      title: "c",
      updatedAt: "2026-04-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      labels: ["P0"],
    }),
  ];
  const numbers = (sorted: readonly IssueLike[]): number[] => sorted.map((i) => i.number);

  it("keeps the provider order by default and never mutates the input", () => {
    const copy = [...list];
    expect(numbers(sortIssues(list, "default"))).toEqual([1, 2, 3]);
    sortIssues(list, "title");
    expect(list).toEqual(copy);
  });

  it("sorts by update date, creation date, number and title", () => {
    expect(numbers(sortIssues(list, "updated"))).toEqual([2, 3, 1]);
    expect(numbers(sortIssues(list, "created"))).toEqual([2, 1, 3]);
    expect(numbers(sortIssues(list, "number-desc"))).toEqual([3, 2, 1]);
    expect(numbers(sortIssues(list, "number-asc"))).toEqual([1, 2, 3]);
    expect(numbers(sortIssues(list, "title"))).toEqual([2, 1, 3]);
  });

  it("sorts by priority with unranked issues last", () => {
    expect(numbers(sortIssues(list, "priority"))).toEqual([3, 2, 1]);
  });
});

describe("groupIssues", () => {
  const titles = new Map([
    ["m1", "v1"],
    ["m2", "Alpha"],
  ]);
  const list = [
    issue({ number: 1, milestoneId: "m1", labels: ["bug"], assignees: ["zed"] }),
    issue({ number: 2, milestoneId: null, state: "closed" }),
    issue({ number: 3, milestoneId: "m2", labels: ["ui", "bug"], assignees: ["amy"] }),
    issue({ number: 4, milestoneId: "m1", labels: ["bug"] }),
  ];
  const summary = (sections: ReturnType<typeof groupIssues<IssueLike>>): string[] =>
    sections.map((section) => `${section.title}:${section.issues.map((i) => i.number).join(",")}`);

  it("returns a single untitled section for no grouping", () => {
    expect(summary(groupIssues(list, "none", titles))).toEqual([":1,2,3,4"]);
  });

  it("groups by milestone alphabetically with 'No milestone' last", () => {
    expect(summary(groupIssues(list, "milestone", titles))).toEqual([
      "Alpha:3",
      "v1:1,4",
      "No milestone:2",
    ]);
  });

  it("groups by first label, with 'No label' last", () => {
    expect(summary(groupIssues(list, "label", titles))).toEqual(["bug:1,4", "ui:3", "No label:2"]);
  });

  it("groups by state open-first and by assignee with 'Unassigned' last", () => {
    expect(summary(groupIssues(list, "state", titles))).toEqual(["Open:1,3,4", "Closed:2"]);
    expect(summary(groupIssues(list, "assignee", titles))).toEqual([
      "amy:3",
      "zed:1",
      "Unassigned:2,4",
    ]);
  });

  it("groups by priority rank with 'No priority' last", () => {
    const withPriority = [
      issue({ number: 1, labels: ["priority: low"] }),
      issue({ number: 2 }),
      issue({ number: 3, labels: ["P0"] }),
    ];
    expect(summary(groupIssues(withPriority, "priority", titles))).toEqual([
      "Critical:3",
      "Low:1",
      "No priority:2",
    ]);
  });
});

describe("readListPrefs", () => {
  it("falls back to defaults for missing or unknown values", () => {
    expect(readListPrefs({})).toEqual({ sort: "default", group: "none" });
    expect(readListPrefs({ issueSort: "nope", issueGroup: 3 })).toEqual({
      sort: "default",
      group: "none",
    });
  });

  it("accepts valid stored values", () => {
    expect(readListPrefs({ issueSort: "updated", issueGroup: "milestone" })).toEqual({
      sort: "updated",
      group: "milestone",
    });
  });
});
