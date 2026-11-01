import { describe, expect, it } from "vitest";
import { buildIssueDraft, buildPermalink } from "../../../src/core/editor/issue-from-code";

const location = {
  providerKind: "github" as const,
  repository: "o/r",
  sha: "abc123",
  path: "src/my dir/a.ts",
  startLine: 10,
  endLine: 10,
};

describe("buildPermalink", () => {
  it("builds a GitHub single-line permalink with an encoded path", () => {
    expect(buildPermalink(location)).toBe(
      "https://github.com/o/r/blob/abc123/src/my%20dir/a.ts#L10",
    );
  });

  it("builds a GitHub range", () => {
    expect(buildPermalink({ ...location, endLine: 14 })).toMatch(/#L10-L14$/);
  });

  it("builds GitLab permalinks on the configured host", () => {
    expect(
      buildPermalink({ ...location, providerKind: "gitlab", gitlabHost: "git.x.io", endLine: 12 }),
    ).toBe("https://git.x.io/o/r/-/blob/abc123/src/my%20dir/a.ts#L10-12");
    expect(buildPermalink({ ...location, providerKind: "gitlab" })).toContain(
      "https://gitlab.com/",
    );
  });
});

describe("buildPermalink for Gitea", () => {
  it("links to the commit's source view with line anchors", () => {
    const gitea = { ...location, providerKind: "gitea" as const, giteaHost: "git.example.com" };
    expect(buildPermalink(gitea)).toBe(
      "https://git.example.com/o/r/src/commit/abc123/src/my%20dir/a.ts#L10",
    );
    expect(buildPermalink({ ...gitea, endLine: 14 })).toMatch(/#L10-L14$/);
  });
});

describe("buildIssueDraft", () => {
  const input = {
    title: "  Handle empty list ",
    path: "src/a.ts",
    startLine: 3,
    endLine: 5,
    languageId: "typescript",
    snippet: "const a = 1;\nconst b = 2;\n\n",
  };

  it("references file:line range and fences the snippet with its language", () => {
    const draft = buildIssueDraft(input);
    expect(draft.title).toBe("Handle empty list");
    expect(draft.body).toContain("`src/a.ts:3-5`");
    expect(draft.body).toContain("```typescript\nconst a = 1;\nconst b = 2;\n```");
  });

  it("links the reference when a permalink is known", () => {
    expect(buildIssueDraft({ ...input, permalink: "https://x/y" }).body).toContain(
      "[`src/a.ts:3-5`](https://x/y)",
    );
  });

  it("uses a longer fence than any backtick run in the snippet", () => {
    const draft = buildIssueDraft({ ...input, snippet: "```js\nx\n```" });
    expect(draft.body).toContain("````typescript");
  });

  it("truncates very long snippets and says so", () => {
    const snippet = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    const draft = buildIssueDraft({ ...input, snippet });
    expect(draft.body).toContain("… (20 more lines)");
    expect(draft.body).not.toContain("line 59");
  });

  it("uses a single line number for one-line selections", () => {
    expect(buildIssueDraft({ ...input, startLine: 7, endLine: 7 }).body).toContain("`src/a.ts:7`");
  });
});
