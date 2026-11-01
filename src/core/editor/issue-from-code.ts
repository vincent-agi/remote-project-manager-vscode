import { giteaBaseUrl } from "../git/compare-url";
import type { ProviderKind } from "../models/issue.model";

/** Where a piece of code lives, for building a permalink. */
export interface CodeLocation {
  readonly providerKind: ProviderKind;
  readonly repository: string;
  readonly gitlabHost?: string;
  readonly giteaHost?: string;
  /** Commit SHA the permalink pins to. */
  readonly sha: string;
  /** Path relative to the repository root, using `/`. */
  readonly path: string;
  /** One-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

/** A permalink to the given lines at a fixed commit. */
export function buildPermalink(location: CodeLocation): string {
  const encodedPath = location.path.split("/").map(encodeURIComponent).join("/");
  const single = location.startLine === location.endLine;
  if (location.providerKind === "github") {
    const anchor = single
      ? `#L${location.startLine}`
      : `#L${location.startLine}-L${location.endLine}`;
    return `https://github.com/${location.repository}/blob/${location.sha}/${encodedPath}${anchor}`;
  }
  if (location.providerKind === "gitea") {
    const anchor = single
      ? `#L${location.startLine}`
      : `#L${location.startLine}-L${location.endLine}`;
    return `${giteaBaseUrl(location.giteaHost)}/${location.repository}/src/commit/${location.sha}/${encodedPath}${anchor}`;
  }
  const host = location.gitlabHost || "gitlab.com";
  const anchor = single ? `#L${location.startLine}` : `#L${location.startLine}-${location.endLine}`;
  return `https://${host}/${location.repository}/-/blob/${location.sha}/${encodedPath}${anchor}`;
}

/** Longest snippet embedded in an issue body, in lines. */
const MAX_SNIPPET_LINES = 40;

/** Input for {@link buildIssueDraft}. */
export interface IssueDraftInput {
  readonly title: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly languageId: string;
  readonly snippet: string;
  /** Permalink, when the repository and commit could be resolved. */
  readonly permalink?: string;
}

/** Title and Markdown body of an issue created from code. */
export interface IssueDraft {
  readonly title: string;
  readonly body: string;
}

/**
 * Markdown body for an issue created from code: a `path:line` reference
 * (linked when a permalink is known) and the snippet in a fenced block
 * whose fence is longer than any backtick run inside the snippet.
 * Overlong snippets are cut with an explicit marker.
 */
export function buildIssueDraft(input: IssueDraftInput): IssueDraft {
  const range =
    input.startLine === input.endLine
      ? `${input.startLine}`
      : `${input.startLine}-${input.endLine}`;
  const reference = `${input.path}:${range}`;
  const lines = input.snippet.replace(/\s+$/, "").split("\n");
  const truncated = lines.length > MAX_SNIPPET_LINES;
  const shown = (truncated ? lines.slice(0, MAX_SNIPPET_LINES) : lines).join("\n");
  const longestRun = Math.max(0, ...(shown.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));

  const body = [
    input.permalink ? `[\`${reference}\`](${input.permalink})` : `\`${reference}\``,
    "",
    `${fence}${input.languageId}`,
    shown,
    ...(truncated ? [`… (${lines.length - MAX_SNIPPET_LINES} more lines)`] : []),
    fence,
    "",
  ].join("\n");
  return { title: input.title.trim(), body };
}
