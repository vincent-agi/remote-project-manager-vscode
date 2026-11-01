import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_CONTEXT_FILE,
  digestContext,
  needsRegeneration,
  resolveAiContextTargets,
} from "../../../src/core/ai/context-targets";

const display = (result: ReturnType<typeof resolveAiContextTargets>): string[] =>
  result.targets.map((target) => target.displayPath);

describe("resolveAiContextTargets", () => {
  it("uses the single legacy setting when the list is empty", () => {
    expect(display(resolveAiContextTargets("docs/ai.md", []))).toEqual(["docs/ai.md"]);
  });

  it("falls back to the default when both are empty", () => {
    expect(display(resolveAiContextTargets("  ", ["", "  "]))).toEqual([DEFAULT_AI_CONTEXT_FILE]);
  });

  it("prefers the list over the single setting", () => {
    expect(display(resolveAiContextTargets("ignored.md", ["CLAUDE.md", "AGENTS.md"]))).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
    ]);
  });

  it("deduplicates after normalization, keeping the first position", () => {
    expect(
      display(resolveAiContextTargets("", ["CLAUDE.md", "./CLAUDE.md", "docs//x.md", "docs/x.md"])),
    ).toEqual(["CLAUDE.md", "docs/x.md"]);
  });

  it("rejects paths that escape the workspace and keeps the safe ones", () => {
    const result = resolveAiContextTargets("", ["../outside.md", "CLAUDE.md", "a/../../b.md"]);
    expect(display(result)).toEqual(["CLAUDE.md"]);
    expect(result.rejected).toEqual(["../outside.md", "a/../../b.md"]);
  });

  it("rejects entries that name no file", () => {
    const result = resolveAiContextTargets("", ["./", "."]);
    expect(result.targets).toEqual([]);
    expect(result.rejected).toEqual(["./", "."]);
  });

  it("splits targets into segments", () => {
    expect(resolveAiContextTargets("", [".github/x.md"]).targets[0].segments).toEqual([
      ".github",
      "x.md",
    ]);
  });
});

describe("digestContext / needsRegeneration", () => {
  it("fingerprints content stably", () => {
    expect(digestContext("a")).toBe(digestContext("a"));
    expect(digestContext("a")).not.toBe(digestContext("b"));
  });

  it("regenerates only when enabled, tracked and changed", () => {
    const tracked = { milestoneId: "m1", digest: digestContext("old") };
    const changed = digestContext("new");
    expect(needsRegeneration(true, tracked, changed)).toBe(true);
    expect(needsRegeneration(true, tracked, tracked.digest)).toBe(false);
    expect(needsRegeneration(false, tracked, changed)).toBe(false);
    expect(needsRegeneration(true, undefined, changed)).toBe(false);
  });
});
