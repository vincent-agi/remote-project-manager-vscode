/** HTTP verbs the provider uses. */
export type GiteaMethod = "GET" | "POST" | "PATCH" | "PUT";

export interface GiteaRequestOptions {
  readonly query?: Readonly<Record<string, string | number>>;
  readonly body?: unknown;
}

/**
 * The one capability the provider needs from the network: a JSON request
 * against the Gitea REST API. Kept this narrow so tests supply a fake and
 * the provider never touches `fetch` or tokens.
 */
export interface GiteaClient {
  request<T>(method: GiteaMethod, path: string, options?: GiteaRequestOptions): Promise<T>;
}

/** An HTTP failure from Gitea; `status` lets `isAuthError` recognize a 401. */
export class GiteaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GiteaHttpError";
  }
}

/** Calls the API like `fetch(url, init)`; injectable for tests. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A {@link GiteaClient} over `fetch`. `baseUrl` is the instance root
 * (`https://git.example.com`); `/api/v1` is appended here. Responses with
 * no content (204) resolve to `undefined`.
 */
export function createGiteaClient(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): GiteaClient {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v1`;
  return {
    async request<T>(
      method: GiteaMethod,
      path: string,
      options: GiteaRequestOptions = {},
    ): Promise<T> {
      const query = new URLSearchParams(
        Object.entries(options.query ?? {}).map(([key, value]): [string, string] => [
          key,
          String(value),
        ]),
      ).toString();
      const response = await fetchImpl(`${root}${path}${query ? `?${query}` : ""}`, {
        method,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new GiteaHttpError(
          response.status,
          `Gitea API ${response.status} on ${method} ${path}${detail ? `: ${detail}` : ""}`,
        );
      }
      return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    },
  };
}
