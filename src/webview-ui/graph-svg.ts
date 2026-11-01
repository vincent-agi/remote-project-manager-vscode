import type { GraphRow } from "./graph-layout.js";

export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 28;
const NODE_RADIUS = 4;
/** Lane colours cycle through this many CSS classes (`lane-0` … `lane-7`). */
export const LANE_COLOR_COUNT = 8;

function x(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function laneClass(lane: number): string {
  return `lane-${lane % LANE_COLOR_COUNT}`;
}

function line(fromX: number, fromY: number, toX: number, toY: number, lane: number): string {
  return `<line class="${laneClass(lane)}" x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}"/>`;
}

/**
 * The SVG for one graph row: lines crossing the row, lines arriving at
 * and leaving the node, and the node itself. Every number comes from the
 * layout, never from commit text, so the markup cannot be influenced by
 * repository content. Colours are classes (the webview CSP forbids
 * inline `style` attributes).
 */
export function renderGraphRowSvg(row: GraphRow, laneCount: number): string {
  const width = laneCount * LANE_WIDTH;
  const mid = ROW_HEIGHT / 2;
  const parts: string[] = [];
  for (const lane of row.through) {
    parts.push(line(x(lane), 0, x(lane), ROW_HEIGHT, lane));
  }
  for (const lane of row.incoming) {
    parts.push(line(x(lane), 0, x(row.lane), mid, lane));
  }
  for (const lane of row.outgoing) {
    parts.push(line(x(row.lane), mid, x(lane), ROW_HEIGHT, lane));
  }
  parts.push(
    `<circle class="node ${laneClass(row.lane)}" cx="${x(row.lane)}" cy="${mid}" r="${NODE_RADIUS}"/>`,
  );
  return `<svg class="graph-svg" width="${width}" height="${ROW_HEIGHT}" viewBox="0 0 ${width} ${ROW_HEIGHT}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}
