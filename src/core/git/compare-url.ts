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
  /** Hostname (optionally with scheme/port) of a Gitea instance. */
  readonly giteaHost?: string;
  /** Open as a draft PR / "Draft:" merge request. */
  readonly draft?: boolean;
  /** GitHub only: GitLab's form identifies reviewers by numeric id, not by name. */
  readonly reviewers?: readonly string[];
  /** GitHub only, for the same reason as `reviewers`. */
  readonly labels?: readonly string[];
}

const GITLAB_DRAFT_PREFIX = "Draft: ";

/** `https://host` for a configured Gitea host; keeps an explicit scheme and port, drops a trailing slash. */
export function giteaBaseUrl(giteaHost: string | undefined): string {
  const host = (giteaHost ?? "").trim().replace(/\/+$/, "");
  if (!host) {
    return "https://gitea.com";
  }
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

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
  if (providerKind === "gitea") {
    // Gitea's compare page takes no title/body parameters; callers hand the body over separately.
    return `${giteaBaseUrl(input.giteaHost)}/${repository}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`;
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
