import { describe, expect, it } from "vitest";
import { scanTodos } from "../../../src/core/editor/todo-scan";

describe("scanTodos", () => {
  it("finds a bare TODO in a line comment", () => {
    const [marker] = scanTodos(["  // TODO: handle the empty case"]);
    expect(marker).toMatchObject({
      line: 0,
      keyword: "TODO",
      issueNumber: null,
      text: "handle the empty case",
    });
    expect(marker.keywordEnd).toBe("  // TODO".length);
  });

  it("reads issue references in the supported forms", () => {
    const markers = scanTodos([
      "// TODO #12 later",
      "// FIXME(#34): broken",
      "# TODO: #56 migrate",
    ]);
    expect(markers.map((marker) => marker.issueNumber)).toEqual([12, 34, 56]);
    expect(markers[0].referenceStart).toBe("// TODO ".length);
    expect(markers[0].referenceEnd).toBe("// TODO #12".length);
  });

  it("supports block and hash comments and strips closers", () => {
    const markers = scanTodos(["/* TODO: tidy */", " * FIXME tidy too", "<!-- TODO: html -->"]);
    expect(markers.map((marker) => marker.text)).toEqual(["tidy", "tidy too", "html"]);
  });

  it("ignores TODO outside comments and non-markers", () => {
    expect(scanTodos(['const s = "TODO";', "todo list", "const TODOS = 1;"])).toEqual([]);
  });

  it("reports one marker per line with zero-based line numbers", () => {
    const markers = scanTodos(["ok", "// TODO a", "ok", "// FIXME b"]);
    expect(markers.map((marker) => marker.line)).toEqual([1, 3]);
  });
});
