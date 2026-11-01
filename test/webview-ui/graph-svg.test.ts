import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../src/webview-ui/graph-layout";
import { LANE_WIDTH, renderGraphRowSvg, ROW_HEIGHT } from "../../src/webview-ui/graph-svg";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("renderGraphRowSvg", () => {
  it("draws a node and the line to its parent", () => {
    const layout = layoutGraph([c("b", "a"), c("a")]);
    const svg = renderGraphRowSvg(layout.rows[0], layout.laneCount);
    expect(svg).toContain("<circle");
    expect(svg).toContain(`x1="${LANE_WIDTH / 2}" y1="${ROW_HEIGHT / 2}"`);
    expect(svg).toContain(`width="${LANE_WIDTH}"`);
  });

  it("draws incoming and through lines", () => {
    const layout = layoutGraph([c("a", "x"), c("b", "x"), c("x")]);
    const svg = renderGraphRowSvg(layout.rows[1], layout.laneCount);
    // lane 0 passes through b's row (vertical line), and b sits in lane 1
    expect(svg).toContain(
      `x1="${LANE_WIDTH / 2}" y1="0" x2="${LANE_WIDTH / 2}" y2="${ROW_HEIGHT}"`,
    );
    expect(svg).toContain(`cx="${LANE_WIDTH * 1.5}"`);
  });

  it("cycles lane colour classes", () => {
    const row = { hash: "h", lane: 9, incoming: [], outgoing: [], through: [] };
    expect(renderGraphRowSvg(row, 10)).toContain("lane-1");
  });

  it("uses no inline style attributes (webview CSP)", () => {
    const layout = layoutGraph([c("b", "a"), c("a")]);
    expect(renderGraphRowSvg(layout.rows[0], 1)).not.toMatch(/\sstyle=/);
  });
});
