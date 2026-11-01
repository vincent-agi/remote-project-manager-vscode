import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../src/core/diagnostics/redact";

describe("redactSecrets", () => {
  it("redacts GitHub tokens", () => {
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end")).toBe(
      "token [redacted] end",
    );
    expect(redactSecrets("github_pat_11ABCDEFG0abcdefghijklmnop_qrstuv")).toBe("[redacted]");
  });

  it("redacts GitLab tokens", () => {
    expect(redactSecrets("glpat-abcdefghijklmnopqrst")).toBe("[redacted]");
  });

  it("redacts Authorization headers but keeps the header name", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe("Authorization: [redacted]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("Issue #53 moved to in-progress")).toBe("Issue #53 moved to in-progress");
  });
});
