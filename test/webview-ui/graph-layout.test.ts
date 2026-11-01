import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../src/webview-ui/graph-layout";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });
const lanesOf = (commits: ReturnType<typeof c>[]): Record<string, number> =>
  Object.fromEntries(layoutGraph(commits).rows.map((row) => [row.hash, row.lane]));

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const layout = layoutGraph([c("c3", "c2"), c("c2", "c1"), c("c1")]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows[0].incoming).toEqual([]);
    expect(layout.rows[1].incoming).toEqual([0]);
    expect(layout.rows[2].outgoing).toEqual([]);
  });

  it("puts a side branch in a second lane and joins it at the fork point", () => {
    // main: m3 - m2 - m1 ; feature: f2 - f1 forking from m1 (topo order, children first)
    const layout = layoutGraph([
      c("m3", "m2"),
      c("f2", "f1"),
      c("m2", "m1"),
      c("f1", "m1"),
      c("m1"),
    ]);
    const lane = Object.fromEntries(layout.rows.map((row) => [row.hash, row.lane]));
    expect(lane.m3).toBe(0);
    expect(lane.f2).toBe(1);
    expect(lane.f1).toBe(1);
    expect(lane.m1).toBe(0);
    // The fork edge is drawn from f1 (outgoing) into m1's lane; m1 itself receives lane 0.
    const f1 = layout.rows.find((row) => row.hash === "f1")!;
    expect(f1.outgoing).toEqual([0]);
    expect(layout.rows.find((row) => row.hash === "m1")!.incoming).toEqual([0]);
    expect(layout.laneCount).toBe(2);
  });

  it("draws a merge commit with edges to both parents", () => {
    // merge M has parents A (first) and B
    const layout = layoutGraph([c("M", "A", "B"), c("A", "R"), c("B", "R"), c("R")]);
    const merge = layout.rows[0];
    expect(merge.lane).toBe(0);
    expect(merge.outgoing).toEqual([0, 1]);
    expect(lanesOf([c("M", "A", "B"), c("A", "R"), c("B", "R"), c("R")])).toEqual({
      M: 0,
      A: 0,
      B: 1,
      R: 0,
    });
  });

  it("reports lanes passing straight through a row", () => {
    const layout = layoutGraph([c("a", "x"), c("b", "x"), c("c", "x"), c("x")]);
    // b sits in lane 1 while lane 0 (waiting for x) passes through it.
    const b = layout.rows.find((row) => row.hash === "b")!;
    expect(b.lane).toBe(1);
    expect(b.through).toContain(0);
  });

  it("ignores parents that are not in the list (filtered/truncated history)", () => {
    const layout = layoutGraph([c("b", "a"), c("z", "missing")]);
    expect(layout.rows[1].outgoing).toEqual([]);
    expect(layout.rows[0].outgoing).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(layoutGraph([])).toEqual({ rows: [], laneCount: 1 });
  });

  it("reuses freed lanes", () => {
    // After a branch ends, the next tip reuses its column instead of widening the graph.
    const layout = layoutGraph([
      c("t1", "base"),
      c("t2", "base"),
      c("base", "old"),
      c("t3", "old"),
      c("old"),
    ]);
    expect(layout.laneCount).toBeLessThanOrEqual(3);
  });
});
