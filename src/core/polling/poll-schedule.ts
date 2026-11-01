/** Shortest allowed polling interval; anything lower would burn API rate limit. */
export const MIN_POLL_SECONDS = 30;

/**
 * Normalizes the `autoRefreshSeconds` setting: `0` (or anything invalid)
 * turns polling off, positive values are clamped to {@link MIN_POLL_SECONDS}.
 */
export function normalizePollInterval(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(MIN_POLL_SECONDS, Math.floor(raw));
}

/**
 * Whether a poll should run now: polling is on, the window has focus
 * (a background window has nobody to show fresh data to), and a full
 * interval has passed since the last run.
 */
export function isPollDue(input: {
  readonly intervalSeconds: number;
  readonly windowFocused: boolean;
  readonly lastRunAt: number;
  readonly now: number;
}): boolean {
  return (
    input.intervalSeconds > 0 &&
    input.windowFocused &&
    input.now - input.lastRunAt >= input.intervalSeconds * 1000
  );
}

/** Badge text/tooltip for the number of open issues assigned to the user. */
export function describeAssignedBadge(count: number): { value: number; tooltip: string } {
  return {
    value: count,
    tooltip: count === 1 ? "1 open issue assigned to you" : `${count} open issues assigned to you`,
  };
}
