import { describe, expect, it } from "vitest";
import { buildConventionalPrTitle, buildPrBody, buildPrTitle } from "../../../src/core/git/pr-body";
import type { IIssue } from "../../../src/core/models/issue.model";
import type { IMilestone } from "../../../src/core/models/milestone.model";

function makeIssue(overrides: Partial<IIssue> = {}): IIssue {
  return {
    id: "acme/widgets#42",
    number: 42,
    title: "Add Gitmoji picker",
    body: "",
    state: "open",
    labels: [],
    assignees: [],
    milestoneId: null,
    url: "https://example.com/42",
    provider: "github",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    commentsCount: 0,
    ...overrides,
  };
}

function makeMilestone(overrides: Partial<IMilestone> = {}): IMilestone {
  return {
    id: "m1",
    number: 10,
    title: "AI-Driven Project & Code Management",
    description: "",
    state: "open",
    dueOn: null,
    url: "https://example.com/milestone/10",
    provider: "github",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildPrTitle", () => {
  it("appends the issue number to the title", () => {
    expect(buildPrTitle(makeIssue())).toBe("Add Gitmoji picker (#42)");
  });
});

describe("buildPrBody", () => {
  it("includes a Closes trailer, summary, commit list, and milestone link", () => {
    const issue = makeIssue({ body: "As a developer, I want a picker." });
    const milestone = makeMilestone();
    const body = buildPrBody(issue, milestone, [
      { hash: "abc1234567", message: "feat: ✨ add picker\n\nRefs #42" },
      { hash: "def8901234", message: "test: ✅ cover picker" },
    ]);

    expect(body).toContain("Closes #42 — Add Gitmoji picker");
    expect(body).toContain("As a developer, I want a picker.");
    expect(body).toContain("- abc1234 feat: ✨ add picker");
    expect(body).toContain("- def8901 test: ✅ cover picker");
    expect(body).toContain("Part of milestone: AI-Driven Project & Code Management (#10)");
  });

  it("omits the milestone line when there is no milestone", () => {
    const body = buildPrBody(makeIssue(), null, []);
    expect(body).not.toContain("Part of milestone");
  });

  it("omits the commit list when there are no commits", () => {
    const body = buildPrBody(makeIssue(), null, []);
    expect(body).not.toContain("**Commits**");
  });
});

describe("buildConventionalPrTitle", () => {
  const commit = (message: string): { hash: string; message: string } => ({
    hash: "abc1234",
    message,
  });

  it("falls back to the issue title when no commit follows the convention", () => {
    expect(buildConventionalPrTitle(makeIssue(), [commit("random message")])).toBe(
      "Add Gitmoji picker (#42)",
    );
    expect(buildConventionalPrTitle(makeIssue(), [])).toBe("Add Gitmoji picker (#42)");
  });

  it("reuses the description of a single conforming commit", () => {
    expect(buildConventionalPrTitle(makeIssue(), [commit("fix(ui): 🐛 repair the picker")])).toBe(
      "fix(ui): 🐛 repair the picker (#42)",
    );
  });

  it("picks the most significant type and the issue title for several commits", () => {
    const title = buildConventionalPrTitle(makeIssue(), [
      commit("chore: 🔧 tidy"),
      commit("feat: ✨ add picker"),
      commit("docs: 📝 explain"),
    ]);
    expect(title).toBe("feat: ✨ Add Gitmoji picker (#42)");
  });

  it("keeps the scope only when every commit shares it", () => {
    expect(
      buildConventionalPrTitle(makeIssue(), [commit("feat(ui): ✨ a"), commit("fix(ui): 🐛 b")]),
    ).toBe("feat(ui): ✨ Add Gitmoji picker (#42)");
    expect(
      buildConventionalPrTitle(makeIssue(), [commit("feat(ui): ✨ a"), commit("fix(git): 🐛 b")]),
    ).toBe("feat: ✨ Add Gitmoji picker (#42)");
  });

  it("does not duplicate an existing issue reference", () => {
    expect(buildConventionalPrTitle(makeIssue(), [commit("fix: 🐛 repair it (#42)")])).toBe(
      "fix: 🐛 repair it (#42)",
    );
  });
});
