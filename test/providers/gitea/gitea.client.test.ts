import { describe, expect, it, vi } from "vitest";
import { createGiteaClient, GiteaHttpError } from "../../../src/providers/gitea/gitea.client";
import { isAuthError } from "../../../src/core/auth/is-auth-error";

function respond(status: number, body: unknown = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

describe("createGiteaClient", () => {
  it("calls /api/v1 on the instance with a token header and the query string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200, [1]));
    const client = createGiteaClient("https://git.example.com/", "secret", fetchImpl);

    const result = await client.request("GET", "/repos/o/r/issues", {
      query: { state: "all", page: 2 },
    });

    expect(result).toEqual([1]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://git.example.com/api/v1/repos/o/r/issues?state=all&page=2");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("token secret");
    expect(init.body).toBeUndefined();
  });

  it("sends a JSON body with a content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(201, { id: 1 }));
    await createGiteaClient("https://g.io", "t", fetchImpl).request("POST", "/x", {
      body: { a: 1 },
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("resolves to undefined on 204", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(204));
    expect(
      await createGiteaClient("https://g.io", "t", fetchImpl).request("PUT", "/x"),
    ).toBeUndefined();
  });

  it("throws an error carrying the status, recognized as an auth error on 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad token", { status: 401 }));
    const failure = await createGiteaClient("https://g.io", "t", fetchImpl)
      .request("GET", "/user")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GiteaHttpError);
    expect((failure as GiteaHttpError).status).toBe(401);
    expect((failure as Error).message).toContain("bad token");
    expect(isAuthError(failure)).toBe(true);
  });

  it("does not treat other failures as auth errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    const failure = await createGiteaClient("https://g.io", "t", fetchImpl)
      .request("GET", "/x")
      .catch((error: unknown) => error);
    expect(isAuthError(failure)).toBe(false);
  });
});
