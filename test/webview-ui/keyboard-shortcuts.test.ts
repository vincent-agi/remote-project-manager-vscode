import { describe, expect, it } from "vitest";
import { moveSelection, shortcutFor } from "../../src/webview-ui/keyboard-shortcuts";

const key = (
  k: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("shortcutFor", () => {
  it("maps the documented keys", () => {
    expect(shortcutFor(key("j"), false)).toBe("next");
    expect(shortcutFor(key("k"), false)).toBe("previous");
    expect(shortcutFor(key("e"), false)).toBe("edit");
    expect(shortcutFor(key("/"), false)).toBe("search");
    expect(shortcutFor(key("r"), false)).toBe("refresh");
    expect(shortcutFor(key("?"), false)).toBe("help");
  });

  it("ignores keys typed into an editable field", () => {
    expect(shortcutFor(key("j"), true)).toBeNull();
    expect(shortcutFor(key("/"), true)).toBeNull();
  });

  it("ignores chords with a modifier (e.g. Ctrl+R reload)", () => {
    expect(shortcutFor(key("r", { ctrlKey: true }), false)).toBeNull();
    expect(shortcutFor(key("r", { metaKey: true }), false)).toBeNull();
    expect(shortcutFor(key("e", { altKey: true }), false)).toBeNull();
  });

  it("ignores unmapped keys", () => {
    expect(shortcutFor(key("x"), false)).toBeNull();
  });
});

describe("moveSelection", () => {
  const ids = ["a", "b", "c"];

  it("moves forward and backward", () => {
    expect(moveSelection(ids, "a", "next")).toBe("b");
    expect(moveSelection(ids, "c", "previous")).toBe("b");
  });

  it("stays at the ends instead of wrapping", () => {
    expect(moveSelection(ids, "c", "next")).toBe("c");
    expect(moveSelection(ids, "a", "previous")).toBe("a");
  });

  it("starts at the first/last entry when nothing (or something hidden) is selected", () => {
    expect(moveSelection(ids, null, "next")).toBe("a");
    expect(moveSelection(ids, null, "previous")).toBe("c");
    expect(moveSelection(ids, "gone", "next")).toBe("a");
  });

  it("returns null for an empty list", () => {
    expect(moveSelection([], null, "next")).toBeNull();
  });
});
