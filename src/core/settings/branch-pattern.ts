import { generateBranchName, looksLikeValidGitRef } from "../automation/branch-name";
import { identityTranslate, type Translate } from "../i18n/translate";
import type { IIssue } from "../models/issue.model";

/** The placeholders {@link generateBranchName} understands. */
const KNOWN_PLACEHOLDERS: readonly string[] = ["type", "issue_id", "slug"];

/** A problem found in a branch name pattern, as a code the UI turns into text. */
export type BranchPatternWarning =
  | { readonly kind: "unknown-placeholder"; readonly name: string }
  | { readonly kind: "missing-issue-id" }
  | { readonly kind: "invalid-ref"; readonly example: string };

/** Result of previewing a pattern against a sample issue. */
export interface BranchPatternPreview {
  readonly example: string;
  readonly warnings: readonly BranchPatternWarning[];
}

/** The fields of an issue the preview reads. */
export interface SampleIssue {
  readonly title: string;
  readonly number: number;
  readonly labels: readonly string[];
}

/**
 * Previews `pattern` for `sample` and lists what is wrong with it:
 * placeholders that will not be replaced, a missing `${issue_id}` (the
 * extension finds an issue again from the branch name, so without it the
 * status bar and PR assistants cannot link the branch back), and a result
 * that is not a valid git ref. An empty pattern means "use the default".
 */
export function previewBranchPattern(pattern: string, sample: SampleIssue): BranchPatternPreview {
  const effective = pattern.trim() === "" ? undefined : pattern;
  const issue = {
    number: sample.number,
    title: sample.title,
    labels: sample.labels,
  } as IIssue;
  const example = generateBranchName(issue, effective);
  const warnings: BranchPatternWarning[] = [];

  if (effective !== undefined) {
    const seen = new Set<string>();
    for (const match of effective.matchAll(/\$\{([^}]*)\}/g)) {
      const name = match[1];
      if (!KNOWN_PLACEHOLDERS.includes(name) && !seen.has(name)) {
        seen.add(name);
        warnings.push({ kind: "unknown-placeholder", name });
      }
    }
    if (!effective.includes("${issue_id}")) {
      warnings.push({ kind: "missing-issue-id" });
    }
  }
  if (!looksLikeValidGitRef(example)) {
    warnings.push({ kind: "invalid-ref", example });
  }
  return { example, warnings };
}

/** Human-readable text for a warning. */
export function describeBranchPatternWarning(
  warning: BranchPatternWarning,
  t: Translate = identityTranslate,
): string {
  switch (warning.kind) {
    case "unknown-placeholder":
      return t("Unknown placeholder ${{0}}: it will be left as is.", warning.name);
    case "missing-issue-id":
      return t(
        "Without ${issue_id}, the status bar and the PR assistants cannot link a branch back to its issue.",
      );
    case "invalid-ref":
      return t("'{0}' is not a valid git branch name.", warning.example);
  }
}
