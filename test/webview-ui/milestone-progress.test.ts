import { describe, expect, it } from "vitest";
import { computeMilestoneProgress, describeDue } from "../../src/webview-ui/milestone-progress";

const NOW = new Date("2026-06-15T12:00:00Z");
const open = { state: "open" as const };

describe("computeMilestoneProgress", () => {
  it("computes counts and a rounded percentage", () => {
    const progress = computeMilestoneProgress(
      { ...open, dueOn: null },
      ["closed", "open", "closed"],
      NOW,
    );
    expect(progress).toMatchObject({ open: 1, closed: 2, total: 3, percent: 67 });
  });

  it("reports 0% with no issues instead of dividing by zero", () => {
    expect(computeMilestoneProgress({ ...open, dueOn: null }, [], NOW).percent).toBe(0);
  });

  it("has no due information without a due date", () => {
    const progress = computeMilestoneProgress({ ...open, dueOn: null }, ["open"], NOW);
    expect(progress.daysRemaining).toBeNull();
    expect(progress.overdue).toBe(false);
    expect(describeDue(progress)).toBe("No due date");
  });

  it("is not overdue on the due day itself", () => {
    const progress = computeMilestoneProgress({ ...open, dueOn: "2026-06-15T00:00:00Z" }, [], NOW);
    expect(progress.daysRemaining).toBe(0);
    expect(progress.overdue).toBe(false);
    expect(describeDue(progress)).toBe("Due today");
  });

  it("counts days remaining and days late", () => {
    const upcoming = computeMilestoneProgress({ ...open, dueOn: "2026-06-18T00:00:00Z" }, [], NOW);
    expect(upcoming.daysRemaining).toBe(3);
    expect(describeDue(upcoming)).toBe("Due in 3 days");

    const late = computeMilestoneProgress({ ...open, dueOn: "2026-06-14T00:00:00Z" }, [], NOW);
    expect(late.daysRemaining).toBe(-1);
    expect(late.overdue).toBe(true);
    expect(describeDue(late)).toBe("1 day overdue");
  });

  it("never flags a closed milestone as overdue", () => {
    const progress = computeMilestoneProgress(
      { state: "closed", dueOn: "2026-01-01T00:00:00Z" },
      ["closed"],
      NOW,
    );
    expect(progress.overdue).toBe(false);
    expect(describeDue(progress)).toMatch(/^Was due \d+ days ago$/);
  });

  it("ignores an unparsable due date", () => {
    expect(
      computeMilestoneProgress({ ...open, dueOn: "not a date" }, [], NOW).daysRemaining,
    ).toBeNull();
  });
});
