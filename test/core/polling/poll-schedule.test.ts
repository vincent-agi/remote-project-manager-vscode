import { describe, expect, it } from "vitest";
import {
  describeAssignedBadge,
  isPollDue,
  MIN_POLL_SECONDS,
  normalizePollInterval,
} from "../../../src/core/polling/poll-schedule";

describe("normalizePollInterval", () => {
  it("turns polling off for zero, negative and invalid values", () => {
    for (const raw of [0, -5, Number.NaN, Infinity, "300", null, undefined]) {
      expect(normalizePollInterval(raw)).toBe(0);
    }
  });

  it("clamps small positive values to the minimum", () => {
    expect(normalizePollInterval(5)).toBe(MIN_POLL_SECONDS);
    expect(normalizePollInterval(300.9)).toBe(300);
  });
});

describe("isPollDue", () => {
  const base = { intervalSeconds: 60, windowFocused: true, lastRunAt: 0, now: 60_000 };

  it("is due once a full interval has passed", () => {
    expect(isPollDue(base)).toBe(true);
    expect(isPollDue({ ...base, now: 59_999 })).toBe(false);
  });

  it("is never due when off or when the window is not focused", () => {
    expect(isPollDue({ ...base, intervalSeconds: 0 })).toBe(false);
    expect(isPollDue({ ...base, windowFocused: false })).toBe(false);
  });
});

describe("describeAssignedBadge", () => {
  it("pluralizes the tooltip", () => {
    expect(describeAssignedBadge(1).tooltip).toBe("1 open issue assigned to you");
    expect(describeAssignedBadge(4)).toEqual({
      value: 4,
      tooltip: "4 open issues assigned to you",
    });
  });
});
