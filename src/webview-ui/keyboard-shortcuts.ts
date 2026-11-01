import { identityTranslate, type Translate } from "./i18n.js";

export type ShortcutAction = "next" | "previous" | "edit" | "search" | "refresh" | "help";

/** The subset of a `KeyboardEvent` the shortcut map reads. */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** Shortcuts shown by the `?` help, in display order. */
export function shortcutHelp(
  t: Translate = identityTranslate,
): { keys: string; description: string }[] {
  return [
    { keys: "j", description: t("Next issue") },
    { keys: "k", description: t("Previous issue") },
    { keys: "e", description: t("Edit the selected issue") },
    { keys: "/", description: t("Search issues") },
    { keys: "r", description: t("Refresh") },
    { keys: "?", description: t("Show this help") },
  ];
}

/**
 * Maps a key press to an action. Single-key shortcuts must never fire
 * while typing (`targetIsEditable`) or together with a modifier, which
 * would hijack the browser's and VS Code's own chords.
 */
export function shortcutFor(event: KeyLike, targetIsEditable: boolean): ShortcutAction | null {
  if (targetIsEditable || event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  switch (event.key) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "e":
      return "edit";
    case "/":
      return "search";
    case "r":
      return "refresh";
    case "?":
      return "help";
    default:
      return null;
  }
}

/**
 * The id to select after moving one step in `direction` from `currentId`.
 * Starts at the first (next) or last (previous) entry when nothing is
 * selected; stays put at either end rather than wrapping.
 */
export function moveSelection(
  ids: readonly string[],
  currentId: string | null,
  direction: "next" | "previous",
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const index = currentId === null ? -1 : ids.indexOf(currentId);
  if (index === -1) {
    return direction === "next" ? ids[0] : ids[ids.length - 1];
  }
  const target =
    direction === "next" ? Math.min(index + 1, ids.length - 1) : Math.max(index - 1, 0);
  return ids[target];
}
