import { describe, expect, it } from "vitest";
import { previewBranchPattern } from "../../../src/core/settings/branch-pattern";

const sample = { title: "Add dark mode", number: 42, labels: ["enhancement"] };

describe("previewBranchPattern", () => {
  it("previews the default pattern for an empty value", () => {
    expect(previewBranchPattern("", sample)).toEqual({
      example: "feature/42-add-dark-mode",
      warnings: [],
    });
  });

  it("previews a custom pattern", () => {
    expect(previewBranchPattern("${issue_id}/${type}-${slug}", sample).example).toBe(
      "42/feature-add-dark-mode",
    );
  });

  it("warns about unknown placeholders, once each", () => {
    const { warnings } = previewBranchPattern("${type}/${issue_id}-${nope}-${nope}", sample);
    expect(warnings).toContainEqual({ kind: "unknown-placeholder", name: "nope" });
    expect(warnings.filter((warning) => warning.kind === "unknown-placeholder")).toHaveLength(1);
  });

  it("warns when the pattern cannot link a branch back to its issue", () => {
    expect(previewBranchPattern("${type}/${slug}", sample).warnings).toContainEqual({
      kind: "missing-issue-id",
    });
  });

  it("warns when the result is not a valid git ref", () => {
    const { warnings } = previewBranchPattern("${type} ${issue_id}", sample);
    expect(warnings.map((warning) => warning.kind)).toContain("invalid-ref");
  });
});

describe("describeBranchPatternWarning", () => {
  it("renders every warning kind as readable text", async () => {
    const { describeBranchPatternWarning } =
      await import("../../../src/core/settings/branch-pattern");
    expect(describeBranchPatternWarning({ kind: "unknown-placeholder", name: "nope" })).toBe(
      "Unknown placeholder ${nope}: it will be left as is.",
    );
    expect(describeBranchPatternWarning({ kind: "missing-issue-id" })).toContain("${issue_id}");
    expect(describeBranchPatternWarning({ kind: "invalid-ref", example: "a b" })).toBe(
      "'a b' is not a valid git branch name.",
    );
  });
});
