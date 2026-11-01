import { describe, expect, it } from "vitest";
import { formatMessage, identityTranslate } from "../../../src/core/i18n/translate";

describe("formatMessage", () => {
  it("substitutes numbered placeholders, including repeats and numbers", () => {
    expect(formatMessage("{0} of {1} ({0})", ["a", 3])).toBe("a of 3 (a)");
  });

  it("leaves placeholders without an argument untouched", () => {
    expect(formatMessage("hello {1}", ["x"])).toBe("hello {1}");
  });

  it("does not re-interpret placeholder-like text inside arguments", () => {
    expect(formatMessage("{0} {1}", ["{1}", "b"])).toBe("{1} b");
  });
});

describe("identityTranslate", () => {
  it("returns the English message formatted", () => {
    expect(identityTranslate("Issue #{0}", 12)).toBe("Issue #12");
  });
});
