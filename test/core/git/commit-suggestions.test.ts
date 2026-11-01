import { describe, expect, it } from "vitest";
import { suggestCommitScope, suggestCommitType } from "../../../src/core/git/commit-suggestions";

describe("suggestCommitType", () => {
  it("suggests docs for documentation-only changes", () => {
    expect(suggestCommitType(["README.md", "docs/a/b.md"])).toBe("docs");
  });

  it("suggests test for test-only changes", () => {
    expect(suggestCommitType(["test/core/git/x.test.ts", "src/y.spec.ts"])).toBe("test");
  });

  it("suggests ci for workflow changes", () => {
    expect(suggestCommitType([".github/workflows/ci.yml"])).toBe("ci");
  });

  it("suggests build for manifest/config changes", () => {
    expect(suggestCommitType(["package.json", "package-lock.json"])).toBe("build");
  });

  it("falls back to the branch prefix for mixed source changes", () => {
    expect(suggestCommitType(["src/a.ts", "README.md"], "fix/53-thing")).toBe("fix");
    expect(suggestCommitType(["src/a.ts"], "feature/61-thing")).toBe("feat");
  });

  it("returns undefined when nothing can be inferred", () => {
    expect(suggestCommitType(["src/a.ts"], "main")).toBeUndefined();
    expect(suggestCommitType(["src/a.ts"], "weird/9-x")).toBeUndefined();
    expect(suggestCommitType([], null)).toBeUndefined();
  });

  it("uses the branch prefix when nothing is staged", () => {
    expect(suggestCommitType([], "docs/1-x")).toBe("docs");
  });
});

describe("suggestCommitScope", () => {
  it("skips generic segments", () => {
    expect(suggestCommitScope(["src/core/git/a.ts", "test/core/git/a.test.ts"])).toBe("git");
  });

  it("returns undefined when files span several areas", () => {
    expect(suggestCommitScope(["src/webview/a.ts", "src/core/git/b.ts"])).toBeUndefined();
  });

  it("returns undefined for root-level files", () => {
    expect(suggestCommitScope(["src/extension.ts"])).toBeUndefined();
    expect(suggestCommitScope(["package.json"])).toBeUndefined();
  });

  it("returns undefined with no files", () => {
    expect(suggestCommitScope([])).toBeUndefined();
  });
});
