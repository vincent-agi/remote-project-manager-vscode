/** Last-seen comment count per issue id, as stored in the UI preferences. */
export type SeenComments = Readonly<Record<string, number>>;

/** Reads the seen-comments map out of the opaque stored prefs, dropping malformed entries. */
export function readSeenComments(prefs: Readonly<Record<string, unknown>>): SeenComments {
  const raw = prefs.seenComments;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [id, count] of Object.entries(raw)) {
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      result[id] = count;
    }
  }
  return result;
}

/**
 * Comments added since the issue was last opened. An issue never opened
 * before has nothing to compare against, so it reports 0 rather than
 * flooding the list with a badge for every pre-existing comment.
 */
export function unseenComments(seen: SeenComments, issueId: string, commentsCount: number): number {
  const last = seen[issueId];
  return last === undefined ? 0 : Math.max(0, commentsCount - last);
}

/** Records that the issue was opened with `commentsCount` comments. Returns the same object when nothing changed. */
export function markSeen(seen: SeenComments, issueId: string, commentsCount: number): SeenComments {
  return seen[issueId] === commentsCount ? seen : { ...seen, [issueId]: commentsCount };
}
