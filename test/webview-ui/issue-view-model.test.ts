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
