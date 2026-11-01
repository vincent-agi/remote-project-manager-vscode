import { describe, expect, it } from "vitest";
import {
  decideCommitSync,
  findIssuesClosedByCommits,
  labelsWithInProgress,
} from "../../../src/core/automation/state-sync";
import type { IIssue } from "../../../src/core/models/issue.model";

function makeIssue(overrides: Partial<IIssue> = {}): IIssue {
  return {
    id: "o/r#53",
    number: 53,
    title: "t",
    body: "",
    state: "open",
    labels: ["bug"],
    assignees: ["Me"],
    milestoneId: null,
    url: "u",
    provider: "github",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    commentsCount: 0,
    ...overrides,
  };
}

const base = {
  branch: "fix/53-thing",
  defaultBranch: "main",
  commitsAhead: 1,
  branchIssueNumber: 53,
  issues: [makeIssue()],
  username: "me",
};

describe("decideCommitSync", () => {
  it("marks the assigned open issue as in-progress after the first commit", () => {
    const action = decideCommitSync(base);
    expect(action.kind).toBe("mark-in-progress");
  });

  it("does nothing on the default branch, detached HEAD, or with no commit ahead", () => {
    expect(decideCommitSync({ ...base, branch: "main" }).kind).toBe("none");
    expect(decideCommitSync({ ...base, branch: "HEAD" }).kind).toBe("none");
    expect(decideCommitSync({ ...base, branch: null }).kind).toBe("none");
    expect(decideCommitSync({ ...base, commitsAhead: 0 }).kind).toBe("none");
  });

  it("does nothing when already in-progress (any case), closed, or not assigned to the user", () => {
    expect(
      decideCommitSync({ ...base, issues: [makeIssue({ labels: ["In-Progress"] })] }).kind,
    ).toBe("none");
    expect(decideCommitSync({ ...base, issues: [makeIssue({ state: "closed" })] }).kind).toBe(
      "none",
    );
    expect(decideCommitSync({ ...base, issues: [makeIssue({ assignees: ["other"] })] }).kind).toBe(
      "none",
    );
    expect(decideCommitSync({ ...base, issues: [] }).kind).toBe("none");
  });

  it("reminds when the branch maps to no issue", () => {
    expect(decideCommitSync({ ...base, branch: "tidy-up", branchIssueNumber: null })).toEqual({
      kind: "remind-no-issue",
      branch: "tidy-up",
    });
  });
});

describe("labelsWithInProgress", () => {
  it("appends the label and keeps the others", () => {
    expect(labelsWithInProgress(makeIssue({ labels: ["bug", "ui"] }))).toEqual([
      "bug",
      "ui",
      "in-progress",
    ]);
  });
});

describe("findIssuesClosedByCommits", () => {
  const issues = [makeIssue({ number: 7 }), makeIssue({ number: 9 }), makeIssue({ number: 12 })];

  it("finds issues closed by a closing keyword, sorted by number", () => {
    const found = findIssuesClosedByCommits(issues, [
      "feat: ✨ a\n\nFixes #12",
      "fix: 🐛 b\n\ncloses #7 and resolved #99",
    ]);
    expect(found.map((issue) => issue.number)).toEqual([7, 12]);
  });

  it("ignores Refs and plain mentions", () => {
    expect(findIssuesClosedByCommits(issues, ["feat: a\n\nRefs #9", "see #7"])).toEqual([]);
  });

  it("ignores issues that are already closed", () => {
    expect(
      findIssuesClosedByCommits([makeIssue({ number: 7, state: "closed" })], ["Fixes #7"]),
    ).toEqual([]);
  });
});
