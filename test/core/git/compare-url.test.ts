import { describe, expect, it } from "vitest";
import { buildCompareUrl } from "../../../src/core/git/compare-url";

const base = {
  repository: "o/r",
  baseBranch: "main",
  headBranch: "fix/1-x",
  title: "t",
  body: "b",
};

describe("buildCompareUrl", () => {
  it("builds a GitHub compare URL", () => {
    const url = new URL(buildCompareUrl({ ...base, providerKind: "github" }));
    expect(url.pathname).toBe("/o/r/compare/main...fix%2F1-x");
    expect(url.searchParams.get("quick_pull")).toBe("1");
    expect(url.searchParams.has("draft")).toBe(false);
  });

  it("adds draft, reviewers and labels on GitHub", () => {
    const url = new URL(
      buildCompareUrl({
        ...base,
        providerKind: "github",
        draft: true,
        reviewers: ["a", "b"],
        labels: ["bug", "ui"],
      }),
    );
    expect(url.searchParams.get("draft")).toBe("1");
    expect(url.searchParams.get("reviewers")).toBe("a,b");
    expect(url.searchParams.get("labels")).toBe("bug,ui");
  });

  it("prefixes the title with Draft: on GitLab, once", () => {
    const params = (title: string): URLSearchParams =>
      new URL(
        buildCompareUrl({
          ...base,
          providerKind: "gitlab",
          title,
          draft: true,
          gitlabHost: "g.io",
        }),
      ).searchParams;
    expect(params("t").get("merge_request[title]")).toBe("Draft: t");
    expect(params("Draft: t").get("merge_request[title]")).toBe("Draft: t");
  });

  it("uses the configured GitLab host and ignores reviewers/labels", () => {
    const raw = buildCompareUrl({
      ...base,
      providerKind: "gitlab",
      gitlabHost: "git.example.com",
      reviewers: ["a"],
      labels: ["x"],
    });
    expect(raw.startsWith("https://git.example.com/o/r/-/merge_requests/new?")).toBe(true);
    expect(raw).not.toContain("reviewers");
  });
});
