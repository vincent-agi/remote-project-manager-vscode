import { describe, expect, it } from "vitest";
import { buildStatusBarModel, type SyncState } from "../../../src/core/status/status-bar-model";

const ok: SyncState = {
  kind: "ok",
  issues: [
    { id: "id-53", number: 53, title: "Escape date fallback" },
    { id: "id-61", number: 61, title: "A".repeat(80) },
  ],
};

describe("buildStatusBarModel", () => {
  it("is hidden when unavailable", () => {
    expect(buildStatusBarModel("fix/53-x", { kind: "unavailable" }).visible).toBe(false);
  });

  it("shows a spinner while loading", () => {
    const model = buildStatusBarModel("fix/53-x", { kind: "loading" });
    expect(model.visible).toBe(true);
    expect(model.text).toContain("sync~spin");
  });

  it("flags an authentication error", () => {
    const model = buildStatusBarModel("fix/53-x", { kind: "auth-error" });
    expect(model.severity).toBe("error");
    expect(model.command).toBe("remoteProjectManager.openPanel");
  });

  it("shows the issue matching the branch and opens it on click", () => {
    const model = buildStatusBarModel("fix/53-escape-date-fallback", ok);
    expect(model.text).toBe("$(issues) #53 Escape date fallback");
    expect(model.command).toBe("remoteProjectManager.openIssueFromTree");
    expect(model.commandArguments).toEqual(["id-53"]);
    expect(model.severity).toBe("normal");
  });

  it("truncates long titles", () => {
    const model = buildStatusBarModel("feature/61-long", ok);
    expect(model.text.endsWith("…")).toBe(true);
    expect(model.text.length).toBeLessThan(60);
  });

  it("warns when the branch references no issue", () => {
    const model = buildStatusBarModel("main", ok);
    expect(model.text).toBe("$(circle-slash) No linked issue");
    expect(model.severity).toBe("warning");
  });

  it("warns when the branch issue is unknown to the remote", () => {
    const model = buildStatusBarModel("fix/999-gone", ok);
    expect(model.text).toBe("$(issues) #999");
    expect(model.severity).toBe("warning");
    expect(model.command).toBe("remoteProjectManager.openPanel");
  });

  it("handles a detached HEAD (null branch)", () => {
    const model = buildStatusBarModel(null, ok);
    expect(model.text).toBe("$(circle-slash) No linked issue");
  });
});
