const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

/** A Conventional Commits type token. */
export type CommitType = (typeof CONVENTIONAL_TYPES)[number];

/** All supported Conventional Commits type tokens, in a fixed display order. */
export const COMMIT_TYPES: readonly CommitType[] = CONVENTIONAL_TYPES;

/** How the current issue should be referenced in a composed commit message. */
export type IssueReferenceKind = "fixes" | "refs" | "none";

/** Inputs used to compose a standardized commit message. */
export interface CommitMessageInput {
  readonly type: string;
  readonly scope?: string;
  /** Either a raw emoji (e.g. "✨") or its `:code:` form (e.g. ":sparkles:"). */
  readonly gitmoji: string;
  readonly description: string;
  readonly issueNumber?: number;
  readonly issueReferenceKind?: IssueReferenceKind;
}

/**
 * Composes a commit message matching
 * `<type>(<scope>): <gitmoji> <description> (#<issue_id>)`. `scope` and
 * the issue reference are both optional: dropping either collapses the
 * corresponding `(...)` group entirely rather than leaving it empty.
 *
 * The issue reference, when present, is emitted as a trailing `Fixes #N`
 * / `Refs #N` line in the body rather than inline in the subject, per
 * GitHub's closing-keyword convention — except `"none"`, or when
 * `issueNumber` is absent, which omits it entirely.
 */
export function buildCommitMessage(input: CommitMessageInput): string {
  const scopePart = input.scope ? `(${input.scope})` : "";
  const subject = `${input.type}${scopePart}: ${input.gitmoji} ${input.description}`.trim();

  const kind = input.issueReferenceKind ?? "none";
  if (kind === "none" || input.issueNumber === undefined) {
    return subject;
  }
  const keyword = kind === "fixes" ? "Fixes" : "Refs";
  return `${subject}\n\n${keyword} #${input.issueNumber}`;
}

/** Result of validating a commit message's subject line against the convention. */
export interface CommitValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Matches one full emoji grapheme cluster: a base
 * `\p{Extended_Pictographic}` codepoint, an optional skin-tone modifier,
 * an optional `U+FE0F` variation selector, and optionally more of the
 * same joined by `U+200D` (ZWJ) — e.g. `:technologist:`'s 🧑‍💻. Several
 * bundled Gitmoji glyphs (`:lock:`, `:recycle:`, `:package:`, ...) are
 * multi-codepoint sequences like this; matching only a single codepoint
 * would reject them even though they're exactly what the Gitmoji picker
 * produces.
 */
export const GITMOJI_PATTERN_SOURCE =
  "\\p{Extended_Pictographic}\\p{Emoji_Modifier}?\\uFE0F?(?:\\u200D\\p{Extended_Pictographic}\\p{Emoji_Modifier}?\\uFE0F?)*";

/** Source of the subject-line pattern, shared with the generated `commit-msg` hook. */
export const COMMIT_SUBJECT_PATTERN_SOURCE = `^[a-z]+(\\([\\w./-]+\\))?: (:[a-z0-9_+-]+:|${GITMOJI_PATTERN_SOURCE}) .+$`;

/** Matches `<type>(<scope>): <gitmoji> <description>`, with `(<scope>)` optional. */
const COMMIT_SUBJECT_PATTERN = new RegExp(COMMIT_SUBJECT_PATTERN_SOURCE, "u");

/**
 * Validates a commit message's subject line (its first line) against the
 * `<type>(<scope>): <gitmoji> <description>` convention. Only the type
 * token's *shape* is checked here (lowercase word) — reused, unrelated
 * validation of it being a recognized Conventional Commits type is left
 * to callers that care (e.g. the interactive composer, which only offers
 * {@link COMMIT_TYPES} in the first place).
 */
export function validateCommitMessage(message: string): CommitValidationResult {
  const subject = (message.split("\n")[0] ?? "").trim();
  if (!subject) {
    return { valid: false, reason: "Commit message is empty." };
  }
  if (!COMMIT_SUBJECT_PATTERN.test(subject)) {
    return {
      valid: false,
      reason: "Doesn't match '<type>(<scope>): <gitmoji> <description>'.",
    };
  }
  return { valid: true };
}
