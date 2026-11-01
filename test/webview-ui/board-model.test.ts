import { describe, expect, it } from "vitest";
import { buildBoard, columnOf, planBoardMove } from "../../src/webview-ui/board-model";

const open = (labels: string[] = []) => ({ state: "open" as const, labels });
const closed = (labels: string[] = []) => ({ state: "closed" as const, labels });

describe("columnOf", () => {
  it("places issues by state and in-progress label", () => {
    expect(columnOf(open())).toBe("todo");
    expect(columnOf(open(["In-Progress"]))).toBe("in-progress");
    expect(columnOf(closed())).toBe("done");
    expect(columnOf(closed(["in-progress"]))).toBe("done");
  });
});

describe("buildBoard", () => {
  it("fills the three columns in order, preserving relative order", () => {
    const issues = [
      { n: 1, ...open() },
      { n: 2, ...closed() },
      { n: 3, ...open(["in-progress"]) },
      { n: 4, ...open() },
    ];
    const board = buildBoard(issues);
    expect(board.map((column) => column.title)).toEqual(["To do", "In progress", "Done"]);
    expect(board.map((column) => column.issues.map((issue) => issue.n))).toEqual([
      [1, 4],
      [3],
      [2],
    ]);
  });
});

describe("planBoardMove", () => {
  it("is a no-op when the issue is already in the target column", () => {
    expect(planBoardMove(open(), "todo")).toBeNull();
    expect(planBoardMove(open(["in-progress"]), "in-progress")).toBeNull();
    expect(planBoardMove(closed(), "done")).toBeNull();
  });

  it("adds in-progress while keeping other labels", () => {
    expect(planBoardMove(open(["bug"]), "in-progress")).toEqual({
      labels: ["bug", "in-progress"],
    });
  });

  it("removes in-progress when moving back to To do (any case)", () => {
    expect(planBoardMove(open(["bug", "In-Progress"]), "todo")).toEqual({ labels: ["bug"] });
  });

  it("closes without touching labels", () => {
    expect(planBoardMove(open(["in-progress"]), "done")).toEqual({ state: "closed" });
  });

  it("reopens from Done", () => {
    expect(planBoardMove(closed(["bug"]), "todo")).toEqual({ state: "open", labels: ["bug"] });
    expect(planBoardMove(closed(["bug"]), "in-progress")).toEqual({
      state: "open",
      labels: ["bug", "in-progress"],
    });
  });
});
