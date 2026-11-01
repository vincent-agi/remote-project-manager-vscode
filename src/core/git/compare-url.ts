import type { ProviderKind } from "../models/issue.model";

/** Options for the prefilled PR/MR page. */
export interface CompareUrlInput {
  readonly providerKind: ProviderKind;
  readonly repository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly gitlabHost?: string;
  /** Open as a draft PR / "Draft:" merge request. */
  readonly draft?: boolean;
  /** GitHub only: GitLab's form identifies reviewers by numeric id, not by name. */
  readonly reviewers?: readonly string[];
  /** GitHub only, for the same reason as `reviewers`. */
  readonly labels?: readonly string[];
}

const GITLAB_DRAFT_PREFIX = "Draft: ";

/**
 * Builds a prefilled GitHub compare or GitLab merge-request URL. Drafts
 * use GitHub's `draft=1` parameter and GitLab's `Draft:` title prefix.
 */
export function buildCompareUrl(input: CompareUrlInput): string {
  const { providerKind, repository, baseBranch, headBranch, title, body } = input;
  if (providerKind === "github") {
    const params = new URLSearchParams({ quick_pull: "1", title, body });
    if (input.draft) {
      params.set("draft", "1");
    }
    if (input.reviewers && input.reviewers.length > 0) {
      params.set("reviewers", input.reviewers.join(","));
    }
    if (input.labels && input.labels.length > 0) {
      params.set("labels", input.labels.join(","));
    }
    return `https://github.com/${repository}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?${params.toString()}`;
  }
  const host = input.gitlabHost || "gitlab.com";
  const params = new URLSearchParams({
    "merge_request[source_branch]": headBranch,
    "merge_request[target_branch]": baseBranch,
    "merge_request[title]":
      input.draft && !title.startsWith(GITLAB_DRAFT_PREFIX)
        ? `${GITLAB_DRAFT_PREFIX}${title}`
        : title,
    "merge_request[description]": body,
  });
  return `https://${host}/${repository}/-/merge_requests/new?${params.toString()}`;
}
