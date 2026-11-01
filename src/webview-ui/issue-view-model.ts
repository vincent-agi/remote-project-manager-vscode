import { identityTranslate, type Translate } from "./i18n.js";

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
  readonly createdAt: string;
  readonly updatedAt: string;
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

/** Display name of a built-in filter; saved filters keep the name the user gave them. */
export function describePreset(name: string, t: Translate = identityTranslate): string {
  switch (name) {
    case "My open issues":
      return t("My open issues");
    case "Open issues":
      return t("Open issues");
    case "No milestone":
      return t("No milestone");
    default:
      return name;
  }
}

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

export type IssueSort =
  "default" | "updated" | "created" | "number-desc" | "number-asc" | "title" | "priority";
export type IssueGroup = "none" | "milestone" | "label" | "state" | "assignee" | "priority";

export const ISSUE_SORTS: readonly IssueSort[] = [
  "default",
  "updated",
  "created",
  "number-desc",
  "number-asc",
  "title",
  "priority",
];

export const ISSUE_GROUPS: readonly IssueGroup[] = [
  "none",
  "milestone",
  "label",
  "state",
  "assignee",
  "priority",
];

export function describeSort(sort: IssueSort, t: Translate = identityTranslate): string {
  switch (sort) {
    case "default":
      return t("Default order");
    case "updated":
      return t("Recently updated");
    case "created":
      return t("Recently created");
    case "number-desc":
      return t("Number (newest first)");
    case "number-asc":
      return t("Number (oldest first)");
    case "title":
      return t("Title (A–Z)");
    case "priority":
      return t("Priority");
  }
}

export function describeGroup(group: IssueGroup, t: Translate = identityTranslate): string {
  switch (group) {
    case "none":
      return t("No grouping");
    case "milestone":
      return t("Group by milestone");
    case "label":
      return t("Group by label");
    case "state":
      return t("Group by state");
    case "assignee":
      return t("Group by assignee");
    case "priority":
      return t("Group by priority");
  }
}

/** Display name of a priority title produced by {@link priorityOf}. */
export function describePriority(title: string, t: Translate = identityTranslate): string {
  switch (title) {
    case "Critical":
      return t("Critical");
    case "High":
      return t("High");
    case "Medium":
      return t("Medium");
    case "Low":
      return t("Low");
    default:
      return title;
  }
}

/** Rank of an issue with no recognizable priority label: after every ranked one. */
export const NO_PRIORITY_RANK = 99;

const PRIORITY_NAMES: Readonly<Record<string, { rank: number; title: string }>> = {
  critical: { rank: 0, title: "Critical" },
  urgent: { rank: 0, title: "Critical" },
  blocker: { rank: 0, title: "Critical" },
  high: { rank: 1, title: "High" },
  medium: { rank: 2, title: "Medium" },
  normal: { rank: 2, title: "Medium" },
  low: { rank: 3, title: "Low" },
};

const PRIORITY_P_LEVELS = ["Critical", "High", "Medium", "Low"] as const;

/**
 * Reads an issue's priority from its labels: `priority: high`,
 * `priority/low`, `priority-critical`, `p0`..`p3`, or a bare `urgent`.
 * The most urgent label wins when several are present.
 */
export function priorityOf(labels: readonly string[]): { rank: number; title: string } | null {
  let best: { rank: number; title: string } | null = null;
  for (const label of labels) {
    const lower = label.toLowerCase().trim();
    const named = /^(?:priority\s*[:/-]?\s*)?([a-z]+)$/.exec(lower)?.[1];
    const level = /^p([0-3])$/.exec(lower)?.[1];
    const found =
      level !== undefined
        ? { rank: Number(level), title: PRIORITY_P_LEVELS[Number(level)] }
        : named !== undefined &&
            (lower.startsWith("priority") || named === "urgent" || named === "blocker")
          ? PRIORITY_NAMES[named]
          : undefined;
    if (found && (!best || found.rank < best.rank)) {
      best = found;
    }
  }
  return best;
}

function byDateDesc(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

/** Returns a sorted copy; `"default"` keeps the order the provider returned. */
export function sortIssues<T extends IssueLike>(issues: readonly T[], sort: IssueSort): T[] {
  const copy = [...issues];
  switch (sort) {
    case "default":
      return copy;
    case "updated":
      return copy.sort((a, b) => byDateDesc(a.updatedAt, b.updatedAt) || b.number - a.number);
    case "created":
      return copy.sort((a, b) => byDateDesc(a.createdAt, b.createdAt) || b.number - a.number);
    case "number-desc":
      return copy.sort((a, b) => b.number - a.number);
    case "number-asc":
      return copy.sort((a, b) => a.number - b.number);
    case "title":
      return copy.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.number - b.number,
      );
    case "priority":
      return copy.sort(
        (a, b) =>
          (priorityOf(a.labels)?.rank ?? NO_PRIORITY_RANK) -
            (priorityOf(b.labels)?.rank ?? NO_PRIORITY_RANK) || a.number - b.number,
      );
  }
}

/** A titled run of issues in the grouped list. */
export interface IssueGroupSection<T> {
  readonly key: string;
  readonly title: string;
  readonly issues: T[];
}

/**
 * Splits already-sorted issues into sections, keeping each section's
 * internal order. Sections are ordered alphabetically (priority by rank,
 * state open-first); the "none" section — no milestone, label, assignee
 * or priority — always comes last. `milestoneTitles` maps milestone id to
 * its title.
 */
export function groupIssues<T extends IssueLike>(
  issues: readonly T[],
  group: IssueGroup,
  milestoneTitles: ReadonlyMap<string, string>,
  t: Translate = identityTranslate,
): IssueGroupSection<T>[] {
  if (group === "none") {
    return [{ key: "", title: "", issues: [...issues] }];
  }
  const NONE = "\uffff";
  const sections = new Map<string, IssueGroupSection<T>>();
  const sortKey = new Map<string, string>();
  for (const issue of issues) {
    let key: string;
    let title: string;
    let order: string;
    switch (group) {
      case "milestone":
        key = issue.milestoneId ?? NONE;
        title = issue.milestoneId
          ? (milestoneTitles.get(issue.milestoneId) ?? t("Unknown milestone"))
          : t("No milestone");
        order = issue.milestoneId ? title.toLowerCase() : NONE;
        break;
      case "label":
        key = issue.labels[0] ?? NONE;
        title = issue.labels[0] ?? t("No label");
        order = issue.labels[0]?.toLowerCase() ?? NONE;
        break;
      case "state":
        key = issue.state;
        title = issue.state === "open" ? t("Open") : t("Closed");
        order = issue.state === "open" ? "0" : "1";
        break;
      case "assignee":
        key = issue.assignees[0] ?? NONE;
        title = issue.assignees[0] ?? t("Unassigned");
        order = issue.assignees[0]?.toLowerCase() ?? NONE;
        break;
      case "priority": {
        const priority = priorityOf(issue.labels);
        key = priority?.title ?? NONE;
        title = priority ? describePriority(priority.title, t) : t("No priority");
        order = priority ? String(priority.rank) : NONE;
        break;
      }
    }
    let section = sections.get(key);
    if (!section) {
      section = { key, title, issues: [] };
      sections.set(key, section);
      sortKey.set(key, order);
    }
    section.issues.push(issue);
  }
  return [...sections.values()].sort((a, b) =>
    (sortKey.get(a.key) ?? NONE).localeCompare(sortKey.get(b.key) ?? NONE),
  );
}

/** Reads sort and grouping from the opaque stored prefs, falling back to defaults. */
export function readListPrefs(prefs: Readonly<Record<string, unknown>>): {
  sort: IssueSort;
  group: IssueGroup;
} {
  const sort = ISSUE_SORTS.find((entry) => entry === prefs.issueSort) ?? "default";
  const group = ISSUE_GROUPS.find((entry) => entry === prefs.issueGroup) ?? "none";
  return { sort, group };
}
