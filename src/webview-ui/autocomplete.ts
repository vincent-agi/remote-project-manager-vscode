export type AutocompleteTrigger = "#" | "@" | "~";

/** An in-progress `#12`, `@user` or `~label` token at the caret. */
export interface TriggerMatch {
  readonly trigger: AutocompleteTrigger;
  /** Index of the trigger character. */
  readonly start: number;
  /** Text typed after the trigger, up to the caret. */
  readonly query: string;
}

export interface Suggestion {
  /** Shown in the list. */
  readonly label: string;
  /** Inserted in place of the token (including its trigger character). */
  readonly insertText: string;
}

export interface SuggestionSources {
  readonly issues: readonly { number: number; title: string }[];
  readonly users: readonly string[];
  readonly labels: readonly string[];
}

const MAX_SUGGESTIONS = 8;

/**
 * The trigger token the caret is currently inside, if any. A trigger only
 * counts at the start of the text or after whitespace (so `a#b`, e-mail
 * addresses and URL fragments are left alone), and the query may not
 * contain whitespace.
 */
export function findTrigger(text: string, caret: number): TriggerMatch | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)([#@~])([^\s]*)$/.exec(before);
  if (!match) {
    return null;
  }
  return {
    trigger: match[2] as AutocompleteTrigger,
    start: before.length - match[3].length - 1,
    query: match[3],
  };
}

function rank(candidate: string, query: string): number {
  const lower = candidate.toLowerCase();
  if (lower.startsWith(query)) {
    return 0;
  }
  return lower.includes(query) ? 1 : -1;
}

/** Suggestions for `match`, best (prefix) matches first, capped at a short list. */
export function suggest(match: TriggerMatch, sources: SuggestionSources): Suggestion[] {
  const query = match.query.toLowerCase();
  const scored: { suggestion: Suggestion; score: number; order: number }[] = [];
  const push = (haystack: string, suggestion: Suggestion, order: number): void => {
    const score = query === "" ? 0 : rank(haystack, query);
    if (score >= 0) {
      scored.push({ suggestion, score, order });
    }
  };

  switch (match.trigger) {
    case "#":
      sources.issues.forEach((issue, order) =>
        push(
          `${issue.number} ${issue.title}`,
          {
            label: `#${issue.number} ${issue.title}`,
            insertText: `#${issue.number}`,
          },
          order,
        ),
      );
      break;
    case "@":
      sources.users.forEach((user, order) =>
        push(user, { label: `@${user}`, insertText: `@${user}` }, order),
      );
      break;
    case "~":
      sources.labels.forEach((label, order) =>
        push(
          label,
          {
            label: `~${label}`,
            insertText: /\s/.test(label) ? `~"${label}"` : `~${label}`,
          },
          order,
        ),
      );
      break;
  }
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.suggestion);
}

/**
 * Replaces the token under the caret with `suggestion` plus a trailing
 * space, returning the new text and where the caret should land.
 */
export function applySuggestion(
  text: string,
  caret: number,
  match: TriggerMatch,
  suggestion: Suggestion,
): { text: string; caret: number } {
  const inserted = `${suggestion.insertText} `;
  return {
    text: text.slice(0, match.start) + inserted + text.slice(caret),
    caret: match.start + inserted.length,
  };
}
