import type { IssueLike } from "./issue-view-model.js";

export type BoardColumnId = "todo" | "in-progress" | "done";

export const BOARD_COLUMNS: readonly { id: BoardColumnId; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "in-progress", title: "In progress" },
  { id: "done", title: "Done" },
];

const IN_PROGRESS_LABEL = "in-progress";

function isInProgress(labels: readonly string[]): boolean {
  return labels.some((label) => label.toLowerCase().trim() === IN_PROGRESS_LABEL);
}

/** The column an issue sits in: closed is Done, otherwise the `in-progress` label decides. */
export function columnOf(issue: Pick<IssueLike, "state" | "labels">): BoardColumnId {
  if (issue.state === "closed") {
    return "done";
  }
  return isInProgress(issue.labels) ? "in-progress" : "todo";
}

/** One board column with its issues. */
export interface BoardColumn<T> {
  readonly id: BoardColumnId;
  readonly title: string;
  readonly issues: T[];
}

/** Distributes issues over the three columns, keeping their relative order. */
export function buildBoard<T extends Pick<IssueLike, "state" | "labels">>(
  issues: readonly T[],
): BoardColumn<T>[] {
  return BOARD_COLUMNS.map((column) => ({
    ...column,
    issues: issues.filter((issue) => columnOf(issue) === column.id),
  }));
}

/** The update a move needs; fields left out are not touched. */
export interface BoardMovePatch {
  readonly state?: "open" | "closed";
  readonly labels?: string[];
}

/**
 * The patch that moves `issue` to `target`, or `null` when it is already
 * there. Labels other than `in-progress` are always preserved. Reopening
 * from Done sets the state back to open; closing leaves labels alone so no
 * information is lost.
 */
export function planBoardMove(
  issue: Pick<IssueLike, "state" | "labels">,
  target: BoardColumnId,
): BoardMovePatch | null {
  if (columnOf(issue) === target) {
    return null;
  }
  const withoutInProgress = issue.labels.filter(
    (label) => label.toLowerCase().trim() !== IN_PROGRESS_LABEL,
  );
  switch (target) {
    case "done":
      return { state: "closed" };
    case "in-progress":
      return {
        ...(issue.state === "closed" ? { state: "open" as const } : {}),
        labels: [...withoutInProgress, IN_PROGRESS_LABEL],
      };
    case "todo":
      return {
        ...(issue.state === "closed" ? { state: "open" as const } : {}),
        labels: withoutInProgress,
      };
  }
}
