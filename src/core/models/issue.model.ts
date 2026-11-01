/** Remote platform an issue or milestone belongs to. */
export type ProviderKind = "github" | "gitlab" | "gitea";

/** Lifecycle state of an issue, normalized across providers. */
export type IssueState = "open" | "closed";

const ISSUE_STATES: readonly IssueState[] = ["open", "closed"];

/**
 * Type guard for {@link IssueState}.
 *
 * @param value - Value to check, typically raw provider input.
 * @returns True if value is a valid {@link IssueState}.
 */
export function isIssueState(value: unknown): value is IssueState {
  return typeof value === "string" && (ISSUE_STATES as string[]).includes(value);
}

/**
 * A domain-level representation of an issue, independent of any specific
 * remote provider's wire format.
 */
export interface IIssue {
  /** Stable identifier as returned by the provider. */
  readonly id: string;
  /** Human-readable issue number (e.g. #42). */
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Id of the milestone this issue belongs to, if any. */
  readonly milestoneId: string | null;
  readonly url: string;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** ISO 8601 close timestamp, or null if still open. */
  readonly closedAt: string | null;
  readonly commentsCount: number;
}
