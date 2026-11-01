import { describe, expect, it } from "vitest";
import {
  buildDiagnosticChecks,
  formatDiagnosticsReport,
  type DiagnosticsInput,
} from "../../../src/core/diagnostics/report";

const base: DiagnosticsInput = {
  extensionVersion: "0.0.1",
  vscodeVersion: "1.90.0",
  resolution: { kind: "resolved", providerKind: "github", repository: "o/r", folderPath: "/w" },
  tokenProvider: "github",
  tokenStored: true,
};

describe("buildDiagnosticChecks", () => {
  it("reports a missing remote as an error and stops", () => {
    const checks = buildDiagnosticChecks({
      ...base,
      resolution: { kind: "none" },
      tokenProvider: undefined,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("error");
  });

  it("warns on multiple candidates", () => {
    const [check] = buildDiagnosticChecks({
      ...base,
      resolution: {
        kind: "candidates",
        candidates: [
          { folderPath: "/a", folderName: "a", provider: "github", repository: "o/a" },
          { folderPath: "/b", folderName: "b", provider: "gitlab", repository: "o/b" },
        ],
      },
    });
    expect(check.status).toBe("warning");
    expect(check.detail).toContain("github:o/a");
  });

  it("flags a missing token", () => {
    const checks = buildDiagnosticChecks({ ...base, tokenStored: false });
    expect(checks.find((check) => check.name === "Token stored")?.status).toBe("error");
  });

  it("reports connection failures", () => {
    const checks = buildDiagnosticChecks({ ...base, connection: { ok: false, error: "401" } });
    expect(checks.at(-1)).toMatchObject({ name: "Connection", status: "error", detail: "401" });
  });

  it("lists every capability on success, warning on missing ones", () => {
    const checks = buildDiagnosticChecks({
      ...base,
      connection: {
        ok: true,
        username: "me",
        capabilities: {
          canReadIssues: true,
          canWriteIssues: false,
          canReadMilestones: true,
          canWriteMilestones: true,
        },
      },
    });
    expect(checks.find((check) => check.name === "canWriteIssues")?.status).toBe("warning");
    expect(checks.find((check) => check.name === "canReadIssues")?.status).toBe("ok");
    expect(checks.find((check) => check.name === "Connection")?.detail).toContain("me");
  });
});

describe("formatDiagnosticsReport", () => {
  it("never leaks a token present in an error message", () => {
    const report = formatDiagnosticsReport({
      ...base,
      connection: { ok: false, error: "bad ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    expect(report).not.toContain("ghp_");
    expect(report).toContain("[redacted]");
    expect(report).toContain("Extension: 0.0.1");
  });
});
