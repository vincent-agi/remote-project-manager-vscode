import { identityTranslate, type Translate } from "./i18n.js";

/** The fields of a milestone the progress bar reads. */
export interface MilestoneProgressInput {
  readonly state: "open" | "closed";
  /** ISO 8601 due date/time, or `null`. */
  readonly dueOn: string | null;
}

/** What the progress bar shows for one milestone. */
export interface MilestoneProgress {
  readonly open: number;
  readonly closed: number;
  readonly total: number;
  /** Whole percent of closed issues, 0 when the milestone has none. */
  readonly percent: number;
  /** True when the due date has passed and the milestone is still open. */
  readonly overdue: boolean;
  /**
   * Whole days until the due date (positive), or since it passed
   * (negative); `null` without a due date. Counted in UTC calendar days so
   * the result does not depend on the viewer's time zone.
   */
  readonly daysRemaining: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS);
}

/**
 * Computes a milestone's progress from its linked issues' states. A due
 * date is a whole day: a milestone due today is not yet overdue, and one
 * that is closed is never overdue however late it finished.
 */
export function computeMilestoneProgress(
  milestone: MilestoneProgressInput,
  linkedIssueStates: readonly ("open" | "closed")[],
  now: Date,
): MilestoneProgress {
  const closed = linkedIssueStates.filter((state) => state === "closed").length;
  const total = linkedIssueStates.length;
  const due = milestone.dueOn === null ? Number.NaN : Date.parse(milestone.dueOn);
  const daysRemaining = Number.isNaN(due) ? null : utcDay(due) - utcDay(now.getTime());
  return {
    open: total - closed,
    closed,
    total,
    percent: total === 0 ? 0 : Math.round((closed / total) * 100),
    overdue: milestone.state === "open" && daysRemaining !== null && daysRemaining < 0,
    daysRemaining,
  };
}

/** Human-readable due-date status, e.g. "Due in 3 days", "2 days overdue". */
export function describeDue(progress: MilestoneProgress, t: Translate = identityTranslate): string {
  const days = progress.daysRemaining;
  if (days === null) {
    return t("No due date");
  }
  if (days === 0) {
    return t("Due today");
  }
  if (days > 0) {
    return days === 1 ? t("Due in 1 day") : t("Due in {0} days", days);
  }
  const late = -days;
  if (progress.overdue) {
    return late === 1 ? t("1 day overdue") : t("{0} days overdue", late);
  }
  return late === 1 ? t("Was due 1 day ago") : t("Was due {0} days ago", late);
}
