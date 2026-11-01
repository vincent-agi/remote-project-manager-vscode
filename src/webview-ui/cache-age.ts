import { identityTranslate, type Translate } from "./i18n.js";

const MINUTE_MS = 60 * 1000;

/**
 * Text for the "cached data" banner, or `null` while the data is fresh
 * (under a minute old, or of unknown age) and no banner is warranted.
 */
export function describeCacheAge(
  fetchedAt: number | undefined,
  now: number,
  t: Translate = identityTranslate,
): string | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const minutes = Math.floor((now - fetchedAt) / MINUTE_MS);
  if (minutes < 1) {
    return null;
  }
  if (minutes < 60) {
    return t("Showing cached data from {0} min ago.", minutes);
  }
  const hours = Math.floor(minutes / 60);
  return t("Showing cached data from {0} h ago.", hours);
}
