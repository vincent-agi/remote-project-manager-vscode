import { describe, expect, it } from "vitest";
import {
  chooseRepository,
  parseGitRemoteUrl,
  repositoryKey,
  resolveRepositoryCandidates,
  type RepositoryCandidate,
} from "../../../src/core/workspace/repository-resolver";

const candidate = (repository: string, folderPath = `/ws/${repository}`): RepositoryCandidate => ({
  folderPath,
  folderName: repository,
  provider: "github",
  repository,
});

describe("chooseRepository", () => {
  const settings = {
    provider: "gitlab",
    repository: "stale/setting",
    fallbackFolderPath: "/ws",
  } as const;

  it("prefers the detected remote over a stale repository setting", () => {
    expect(chooseRepository([candidate("acme/widgets")], settings)).toEqual({
      kind: "resolved",
      providerKind: "github",
      repository: "acme/widgets",
      folderPath: "/ws/acme/widgets",
    });
  });

  it("returns every candidate when several folders resolve", () => {
    const result = chooseRepository([candidate("a/a"), candidate("b/b")], settings);
    expect(result.kind).toBe("candidates");
  });

  it("falls back to the setting when nothing is detected", () => {
    expect(chooseRepository([], settings)).toEqual({
      kind: "resolved",
      providerKind: "gitlab",
      repository: "stale/setting",
      folderPath: "/ws",
    });
  });

  it("returns none when nothing is detected and the setting is empty", () => {
    expect(chooseRepository([], { ...settings, repository: "" })).toEqual({ kind: "none" });
  });
});

describe("repositoryKey", () => {
  it("differs when the repository changes and matches when it does not", () => {
    const a = chooseRepository([candidate("a/a")], { provider: "github", repository: "" });
    const a2 = chooseRepository([candidate("a/a")], { provider: "github", repository: "" });
    const b = chooseRepository([candidate("b/b")], { provider: "github", repository: "" });
    expect(repositoryKey(a)).toBe(repositoryKey(a2));
    expect(repositoryKey(a)).not.toBe(repositoryKey(b));
  });
});

describe("parseGitRemoteUrl", () => {
  it("parses a GitHub SSH (scp-like) URL", () => {
    expect(parseGitRemoteUrl("git@github.com:acme/widgets.git")).toEqual({
      provider: "github",
      repository: "acme/widgets",
    });
  });

  it("parses a GitHub HTTPS URL with .git suffix", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/widgets.git")).toEqual({
      provider: "github",
      repository: "acme/widgets",
    });
  });

  it("parses a GitHub HTTPS URL without .git suffix", () => {
    expect(parseGitRemoteUrl("https://github.com/acme/widgets")).toEqual({
      provider: "github",
      repository: "acme/widgets",
    });
  });

  it("parses a GitHub HTTPS URL with embedded credentials", () => {
    expect(parseGitRemoteUrl("https://user:token@github.com/acme/widgets.git")).toEqual({
      provider: "github",
      repository: "acme/widgets",
    });
  });

  it("parses a GitLab SSH URL", () => {
    expect(parseGitRemoteUrl("git@gitlab.com:acme/widgets.git")).toEqual({
      provider: "gitlab",
      repository: "acme/widgets",
    });
  });

  it("parses a GitLab HTTPS URL", () => {
    expect(parseGitRemoteUrl("https://gitlab.com/acme/widgets.git")).toEqual({
      provider: "gitlab",
      repository: "acme/widgets",
    });
  });

  it("parses an explicit ssh:// GitHub URL", () => {
    expect(parseGitRemoteUrl("ssh://git@github.com/acme/widgets.git")).toEqual({
      provider: "github",
      repository: "acme/widgets",
    });
  });

  it("returns null for an unsupported host", () => {
    expect(parseGitRemoteUrl("https://bitbucket.org/acme/widgets.git")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseGitRemoteUrl("not a url")).toBeNull();
  });

  it("returns null when the path has fewer than owner+repo segments", () => {
    expect(parseGitRemoteUrl("https://github.com/acme")).toBeNull();
  });

  it("does not recognize a self-hosted GitLab host without gitlabHost configured", () => {
    expect(parseGitRemoteUrl("git@gitlab.example.com:acme/widgets.git")).toBeNull();
  });

  it("recognizes a self-hosted GitLab host (SSH) when gitlabHost matches", () => {
    expect(
      parseGitRemoteUrl("git@gitlab.example.com:acme/widgets.git", "gitlab.example.com"),
    ).toEqual({
      provider: "gitlab",
      repository: "acme/widgets",
    });
  });

  it("recognizes a self-hosted GitLab host (HTTPS) when gitlabHost matches", () => {
    expect(
      parseGitRemoteUrl("https://gitlab.example.com/acme/widgets.git", "gitlab.example.com"),
    ).toEqual({
      provider: "gitlab",
      repository: "acme/widgets",
    });
  });

  it("still returns null for a host that doesn't match the configured gitlabHost", () => {
    expect(
      parseGitRemoteUrl("https://bitbucket.org/acme/widgets.git", "gitlab.example.com"),
    ).toBeNull();
  });
});

describe("resolveRepositoryCandidates", () => {
  it("maps folders with a parseable remote into candidates", () => {
    const candidates = resolveRepositoryCandidates([
      { folderPath: "/ws/api", folderName: "api", remoteUrl: "git@github.com:acme/api.git" },
      { folderPath: "/ws/web", folderName: "web", remoteUrl: "git@gitlab.com:acme/web.git" },
    ]);

    expect(candidates).toEqual([
      { folderPath: "/ws/api", folderName: "api", provider: "github", repository: "acme/api" },
      { folderPath: "/ws/web", folderName: "web", provider: "gitlab", repository: "acme/web" },
    ]);
  });

  it("skips folders with no remote or an unparseable remote", () => {
    const candidates = resolveRepositoryCandidates([
      { folderPath: "/ws/api", folderName: "api", remoteUrl: "git@github.com:acme/api.git" },
      { folderPath: "/ws/no-remote", folderName: "no-remote", remoteUrl: null },
      {
        folderPath: "/ws/other",
        folderName: "other",
        remoteUrl: "https://bitbucket.org/acme/x.git",
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].folderName).toBe("api");
  });

  it("recognizes a self-hosted GitLab folder when gitlabHost is passed through", () => {
    const candidates = resolveRepositoryCandidates(
      [
        {
          folderPath: "/ws/internal",
          folderName: "internal",
          remoteUrl: "git@gitlab.example.com:acme/internal.git",
        },
      ],
      "gitlab.example.com",
    );

    expect(candidates).toEqual([
      {
        folderPath: "/ws/internal",
        folderName: "internal",
        provider: "gitlab",
        repository: "acme/internal",
      },
    ]);
  });
});
