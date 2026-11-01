import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCommitMsgHookScript,
  classifyExistingHook,
  HOOK_MARKER,
} from "../../../src/core/git/commit-msg-hook";

function runHook(message: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "rpm-hook-"));
  const hook = join(dir, "commit-msg");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(hook, buildCommitMsgHookScript(), { mode: 0o755 });
  writeFileSync(file, message);
  const result = spawnSync("sh", [hook, file], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("classifyExistingHook", () => {
  it("distinguishes none, managed and foreign hooks", () => {
    expect(classifyExistingHook(undefined)).toBe("none");
    expect(classifyExistingHook(`#!/bin/sh\n${HOOK_MARKER}\n`)).toBe("managed");
    expect(classifyExistingHook("#!/bin/sh\nexit 0\n")).toBe("foreign");
  });
});

describe("buildCommitMsgHookScript", () => {
  it("starts with a shebang and carries the marker", () => {
    const script = buildCommitMsgHookScript();
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(HOOK_MARKER);
  });

  it("accepts a conforming message", () => {
    expect(runHook("feat(ui): ✨ add a status bar item\n\nFixes #79\n").status).toBe(0);
  });

  it("rejects a non-conforming message with an explanation", () => {
    const result = runHook("added stuff\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match");
  });

  it("skips git comment lines when finding the subject", () => {
    expect(runHook("# a comment\nfix: 🐛 repair it\n").status).toBe(0);
  });

  it("lets merge and fixup commits through", () => {
    expect(runHook("Merge branch 'x' into main\n").status).toBe(0);
    expect(runHook("fixup! feat: ✨ thing\n").status).toBe(0);
  });

  it("round-trips the script to disk intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "rpm-hook-"));
    const hook = join(dir, "commit-msg");
    writeFileSync(hook, buildCommitMsgHookScript());
    expect(readFileSync(hook, "utf8")).toBe(buildCommitMsgHookScript());
  });
});
