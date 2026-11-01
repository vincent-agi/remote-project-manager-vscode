import { describe, expect, it } from "vitest";
import { markSeen, readSeenComments, unseenComments } from "../../src/webview-ui/comment-state";

describe("readSeenComments", () => {
  it("reads valid entries and drops malformed ones", () => {
    expect(readSeenComments({ seenComments: { a: 2, b: -1, c: 1.5, d: "3", e: 0 } })).toEqual({
      a: 2,
      e: 0,
    });
  });

  it("returns an empty map for missing or wrongly shaped data", () => {
    expect(readSeenComments({})).toEqual({});
    expect(readSeenComments({ seenComments: [1, 2] })).toEqual({});
    expect(readSeenComments({ seenComments: null })).toEqual({});
  });
});

describe("unseenComments", () => {
  it("counts comments added since the last visit", () => {
    expect(unseenComments({ a: 2 }, "a", 5)).toBe(3);
  });

  it("reports nothing for a never-opened issue", () => {
    expect(unseenComments({}, "a", 9)).toBe(0);
  });

  it("never goes negative when comments were deleted", () => {
    expect(unseenComments({ a: 5 }, "a", 3)).toBe(0);
  });
});

describe("markSeen", () => {
  it("records the count without mutating the input", () => {
    const seen = { a: 1 };
    const next = markSeen(seen, "b", 4);
    expect(next).toEqual({ a: 1, b: 4 });
    expect(seen).toEqual({ a: 1 });
  });

  it("returns the same object when nothing changed", () => {
    const seen = { a: 1 };
    expect(markSeen(seen, "a", 1)).toBe(seen);
  });
});
