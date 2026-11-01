/** Provider construction, token handling and the connection helpers shared by every feature. */
import * as vscode from "vscode";
import { Octokit } from "@octokit/rest";
import { Gitlab } from "@gitbeaker/rest";
import { ensureToken, type ICredentialStore } from "./core/auth/ensure-token";
import { isAuthError } from "./core/auth/is-auth-error";
import type { ProviderKind } from "./core/models/issue.model";
import type {
  IAuthenticatedUser,
  IProjectProvider,
} from "./core/providers/project-provider.interface";
import { GithubProvider, type GithubClient } from "./providers/github/github.provider";
import { GitlabProvider, type GitlabClient } from "./providers/gitlab/gitlab.provider";
import { createGiteaClient } from "./providers/gitea/gitea.client";
import { GiteaProvider } from "./providers/gitea/gitea.provider";
import { giteaBaseUrl } from "./core/git/compare-url";
import { CachingProjectProvider } from "./providers/caching-project-provider";
import { resolveRepository } from "./repository";
import { state } from "./state";

export function secretKeyFor(provider: ProviderKind): string {
  return `remoteProjectManager.token.${provider}`;
}

export function makeCredentialStore(secrets: vscode.SecretStorage): ICredentialStore {
  return {
    async getToken(provider) {
      return secrets.get(secretKeyFor(provider));
    },
    async setToken(provider, token) {
      await secrets.store(secretKeyFor(provider), token);
    },
  };
}

function providerDisplayName(provider: ProviderKind): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "gitea":
      return "Gitea";
  }
}

async function promptForToken(provider: ProviderKind): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: vscode.l10n.t("{0} Personal Access Token", providerDisplayName(provider)),
    prompt: vscode.l10n.t(
      "Enter a {0} personal access token with repo/issue read-write scope.",
      provider,
    ),
    password: true,
    ignoreFocusOut: true,
  });
}

/**
 * Gets a GitHub access token via VS Code's built-in GitHub authentication
 * provider. This never touches our SecretStorage: the session is owned
 * and persisted by VS Code itself. See ADR-0003.
 */
async function getGithubToken(): Promise<string> {
  const session = await vscode.authentication.getSession("github", ["repo"], {
    createIfNone: true,
  });
  return session.accessToken;
}

async function resolveToken(
  providerKind: ProviderKind,
  credentialStore: ICredentialStore,
): Promise<string> {
  if (providerKind === "github") {
    return getGithubToken();
  }
  return ensureToken(credentialStore, providerKind, promptForToken);
}

/**
 * Builds the provider for the configured platform. Octokit's and
 * gitbeaker's real client types are wider than the narrow ports the
 * providers depend on (see ADR-0001); the casts here are the single
 * place that bridges the two, kept out of the testable provider classes.
 */
function buildProvider(
  providerKind: ProviderKind,
  repository: string,
  token: string,
  gitlabHost?: string,
  giteaHost?: string,
): IProjectProvider {
  const [owner, repo] = repository.split("/");
  if (providerKind === "github") {
    const octokit = new Octokit({ auth: token });
    return new GithubProvider(octokit.rest as unknown as GithubClient, owner, repo);
  }
  if (providerKind === "gitea") {
    const baseUrl = giteaBaseUrl(giteaHost);
    return new GiteaProvider(
      createGiteaClient(baseUrl, token),
      owner,
      repo,
      `${baseUrl}/${repository}`,
    );
  }
  const gitlab = new Gitlab(gitlabHost ? { token, host: `https://${gitlabHost}` } : { token });
  return new GitlabProvider(gitlab as unknown as GitlabClient, repository);
}

/** Builds a provider and verifies the token by fetching the current user. */
export async function connectProvider(
  providerKind: ProviderKind,
  repository: string,
  token: string,
  cacheTtlSeconds: number,
  gitlabHost: string | undefined,
  giteaHost?: string,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const provider = new CachingProjectProvider(
    buildProvider(providerKind, repository, token, gitlabHost, giteaHost),
    cacheTtlSeconds * 1000,
  );
  const currentUser = await provider.getCurrentUser();
  return { provider, currentUser };
}

/**
 * Resolves a token and connects. For GitLab, a stale/revoked stored
 * token surfaces as a 401 on this first call; rather than showing a
 * generic error, clear it and re-prompt once via {@link ensureToken}'s
 * normal "no token stored" path. GitHub's session is managed by VS Code
 * itself, so it isn't retried here.
 */
async function resolveAndConnect(
  providerKind: ProviderKind,
  repository: string,
  credentialStore: ICredentialStore,
  cacheTtlSeconds: number,
  gitlabHost: string | undefined,
  giteaHost: string | undefined,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const token = await resolveToken(providerKind, credentialStore);
  try {
    return await connectProvider(
      providerKind,
      repository,
      token,
      cacheTtlSeconds,
      gitlabHost,
      giteaHost,
    );
  } catch (error) {
    // GitHub's session is managed by VS Code itself; for the token-based
    // platforms a rejected token is cleared and asked for once more.
    if (providerKind === "github" || !isAuthError(error)) {
      throw error;
    }
    await credentialStore.setToken(providerKind, "");
    const freshToken = await resolveToken(providerKind, credentialStore);
    return connectProvider(
      providerKind,
      repository,
      freshToken,
      cacheTtlSeconds,
      gitlabHost,
      giteaHost,
    );
  }
}

/**
 * Resolves a token and connects, reading connection settings
 * (`cacheTtlSeconds`, `gitlabHost`) from configuration itself so callers
 * don't each re-read them. Shared by {@link buildController},
 * {@link MyIssuesTreeDataProvider}, and the AI-context/git-automation
 * commands (#57, #58, #61), which all need a connected provider whether
 * or not the panel is currently open.
 */
export async function connectRepository(
  context: vscode.ExtensionContext,
  providerKind: ProviderKind,
  repository: string,
): Promise<{ provider: IProjectProvider; currentUser: IAuthenticatedUser }> {
  const credentialStore = makeCredentialStore(context.secrets);
  const config = vscode.workspace.getConfiguration("remoteProjectManager");
  const cacheTtlSeconds = config.get<number>("cacheTtlSeconds", 180);
  const gitlabHost = config.get<string>("gitlabHost", "") || undefined;
  const giteaHost = config.get<string>("giteaHost", "") || undefined;
  return resolveAndConnect(
    providerKind,
    repository,
    credentialStore,
    cacheTtlSeconds,
    gitlabHost,
    giteaHost,
  );
}

/**
 * Gets a connected provider and workspace folder for AI-context/git
 * commands (#57, #58, #61), reusing the open panel's connection when
 * there is one, or connecting fresh otherwise — these commands are
 * useful even without the panel open. Returns `null` when no repository
 * can be resolved unambiguously (mirrors {@link resolveRepository}'s
 * "none"/"candidates" cases, which these single-shot commands don't have
 * a picker UI for).
 */
export async function getActiveConnection(
  context: vscode.ExtensionContext,
): Promise<{ provider: IProjectProvider; cwd: string } | null> {
  if (state.activeProvider && state.activeFolderPath) {
    return { provider: state.activeProvider, cwd: state.activeFolderPath };
  }
  const resolution = await resolveRepository();
  if (resolution.kind !== "resolved" || !resolution.folderPath) {
    return null;
  }
  try {
    const { provider } = await connectRepository(
      context,
      resolution.providerKind,
      resolution.repository,
    );
    return { provider, cwd: resolution.folderPath };
  } catch {
    return null;
  }
}
