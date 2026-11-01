import { describe, expect, it } from "vitest";
import { describeCacheAge } from "../../src/webview-ui/cache-age";

const NOW = 10_000_000;

describe("describeCacheAge", () => {
  it("returns null for unknown or fresh data", () => {
    expect(describeCacheAge(undefined, NOW)).toBeNull();
    expect(describeCacheAge(NOW - 30_000, NOW)).toBeNull();
    expect(describeCacheAge(NOW + 5_000, NOW)).toBeNull();
  });

  it("reports minutes, then hours", () => {
    expect(describeCacheAge(NOW - 3 * 60_000 - 5_000, NOW)).toBe(
      "Showing cached data from 3 min ago.",
    );
    expect(describeCacheAge(NOW - 59 * 60_000, NOW)).toBe("Showing cached data from 59 min ago.");
    expect(describeCacheAge(NOW - 125 * 60_000, NOW)).toBe("Showing cached data from 2 h ago.");
  });
});
