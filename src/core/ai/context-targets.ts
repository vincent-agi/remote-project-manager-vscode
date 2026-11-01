import { createHash } from "node:crypto";
import { resolveSafeRelativeSegments } from "../workspace/safe-relative-path";

/** The file `aiContextFile` falls back to. */
export const DEFAULT_AI_CONTEXT_FILE = ".github/copilot-instructions.md";

/** Instruction files common AI coding tools read, offered as examples in the settings. */
export const KNOWN_AI_CONTEXT_FILES: readonly string[] = [
  DEFAULT_AI_CONTEXT_FILE,
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
];

/** A target as a safe path split into segments, ready to join onto a workspace root. */
export interface AiContextTarget {
  /** The path as the user wrote it, normalized for display. */
  readonly displayPath: string;
  readonly segments: readonly string[];
}

export interface ResolvedAiContextTargets {
  readonly targets: AiContextTarget[];
  /** Entries that were empty or would escape the workspace folder. */
  readonly rejected: string[];
}

/**
 * Works out where the context is written. `files` (the multi-target
 * setting) wins when it has entries; otherwise the single legacy
 * `aiContextFile` is used, then the default. Entries are deduplicated
 * after normalization, and anything that would leave the workspace folder
 * (or name no file) is reported in `rejected` rather than written.
 */
export function resolveAiContextTargets(
  single: string,
  files: readonly string[],
): ResolvedAiContextTargets {
  const requested = files.map((file) => file.trim()).filter((file) => file !== "");
  const candidates = requested.length > 0 ? requested : [single.trim() || DEFAULT_AI_CONTEXT_FILE];

  const targets: AiContextTarget[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const segments = resolveSafeRelativeSegments(candidate);
    if (!segments || segments.length === 0) {
      rejected.push(candidate);
      continue;
    }
    const displayPath = segments.join("/");
    if (!seen.has(displayPath)) {
      seen.add(displayPath);
      targets.push({ displayPath, segments });
    }
  }
  return { targets, rejected };
}

/** A short stable fingerprint of a context block, to tell whether it changed. */
export function digestContext(block: string): string {
  return createHash("sha256").update(block).digest("hex");
}

/** What the extension remembers about its last export. */
export interface TrackedContext {
  readonly milestoneId: string;
  readonly digest: string;
}

/**
 * Whether the context files should be rewritten: auto-update is on, a
 * milestone was exported before, and its content has changed since.
 */
export function needsRegeneration(
  autoUpdate: boolean,
  tracked: TrackedContext | undefined,
  currentDigest: string,
): boolean {
  return autoUpdate && tracked !== undefined && tracked.digest !== currentDigest;
}
