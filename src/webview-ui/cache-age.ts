const MINUTE_MS = 60 * 1000;

/**
 * Text for the "cached data" banner, or `null` while the data is fresh
 * (under a minute old, or of unknown age) and no banner is warranted.
 */
export function describeCacheAge(fetchedAt: number | undefined, now: number): string | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const minutes = Math.floor((now - fetchedAt) / MINUTE_MS);
  if (minutes < 1) {
    return null;
  }
  if (minutes < 60) {
    return `Showing cached data from ${minutes} min ago.`;
  }
  const hours = Math.floor(minutes / 60);
  return `Showing cached data from ${hours} h ago.`;
}
