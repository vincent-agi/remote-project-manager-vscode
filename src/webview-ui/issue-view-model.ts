/** The fields of an issue the list view reads. */
export interface IssueLike {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestoneId: string | null;
}

/** Value of {@link IssueFilter.milestone} that selects issues with no milestone. */
export const NO_MILESTONE = "__none__";

export type IssueStateFilter = "all" | "open" | "closed";

/** Everything the issue list can be narrowed by. */
export interface IssueFilter {
  readonly query: string;
  readonly label: string | null;
  /** A username, or `"@me"` for the current user. */
  readonly assignee: string | null;
  readonly state: IssueStateFilter;
  /** A milestone id, {@link NO_MILESTONE}, or `null` for any. */
  readonly milestone: string | null;
}

export const EMPTY_FILTER: IssueFilter = {
  query: "",
  label: null,
  assignee: null,
  state: "all",
  milestone: null,
};

/** A filter the user named and saved, or a built-in preset. */
export interface SavedFilter {
  readonly name: string;
  readonly filter: IssueFilter;
}

export const PRESET_FILTERS: readonly SavedFilter[] = [
  { name: "My open issues", filter: { ...EMPTY_FILTER, assignee: "@me", state: "open" } },
  { name: "Open issues", filter: { ...EMPTY_FILTER, state: "open" } },
  { name: "No milestone", filter: { ...EMPTY_FILTER, milestone: NO_MILESTONE } },
];

function includesIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Full-text match over title, body, labels and `#number`. Every
 * whitespace-separated word must match somewhere (AND semantics), so
 * "login bug" finds an issue titled "Login fails" labelled "bug".
 */
export function matchesQuery(issue: IssueLike, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(
    (word) =>
      includesIgnoreCase(issue.title, word) ||
      includesIgnoreCase(issue.body, word) ||
      issue.labels.some((label) => includesIgnoreCase(label, word)) ||
      `#${issue.number}` === word ||
      String(issue.number) === word,
  );
}

/** Applies `filter` to `issues`, preserving order. */
export function filterIssues<T extends IssueLike>(
  issues: readonly T[],
  filter: IssueFilter,
  currentUsername: string | null,
): T[] {
  return issues.filter((issue) => {
    if (filter.milestone === NO_MILESTONE ? issue.milestoneId !== null : false) {
      return false;
    }
    if (
      filter.milestone !== null &&
      filter.milestone !== NO_MILESTONE &&
      issue.milestoneId !== filter.milestone
    ) {
      return false;
    }
    if (filter.query.trim() && !matchesQuery(issue, filter.query)) {
      return false;
    }
    if (filter.label && !issue.labels.includes(filter.label)) {
      return false;
    }
    if (filter.assignee) {
      const wanted = filter.assignee === "@me" ? currentUsername : filter.assignee;
      if (!wanted || !issue.assignees.includes(wanted)) {
        return false;
      }
    }
    return filter.state === "all" || issue.state === filter.state;
  });
}

function isIssueFilter(value: unknown): value is IssueFilter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.query === "string" &&
    (candidate.label === null || typeof candidate.label === "string") &&
    (candidate.assignee === null || typeof candidate.assignee === "string") &&
    (candidate.state === "all" || candidate.state === "open" || candidate.state === "closed") &&
    (candidate.milestone === null || typeof candidate.milestone === "string")
  );
}

/**
 * Reads the saved filters out of the opaque stored preferences, dropping
 * anything malformed (the store may hold data from another version).
 * Names are unique: the first of a duplicated name wins.
 */
export function readSavedFilters(prefs: Readonly<Record<string, unknown>>): SavedFilter[] {
  const raw = prefs.savedFilters;
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const result: SavedFilter[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { name, filter } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || !isIssueFilter(filter) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push({ name, filter });
  }
  return result;
}

/**
 * Adds `filter` under `name`, replacing a saved filter of the same name.
 * A name that matches a preset is rejected (`null`) so presets stay stable.
 */
export function upsertSavedFilter(
  saved: readonly SavedFilter[],
  name: string,
  filter: IssueFilter,
): SavedFilter[] | null {
  const trimmed = name.trim();
  if (!trimmed || PRESET_FILTERS.some((preset) => preset.name === trimmed)) {
    return null;
  }
  return [...saved.filter((entry) => entry.name !== trimmed), { name: trimmed, filter }];
}

export function removeSavedFilter(saved: readonly SavedFilter[], name: string): SavedFilter[] {
  return saved.filter((entry) => entry.name !== name);
}

/** True when two filters select exactly the same thing. */
export function sameFilter(a: IssueFilter, b: IssueFilter): boolean {
  return (
    a.query.trim() === b.query.trim() &&
    a.label === b.label &&
    a.assignee === b.assignee &&
    a.state === b.state &&
    a.milestone === b.milestone
  );
}
