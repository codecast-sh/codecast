import { describe, test, expect, afterEach } from "bun:test";
import { cliFetch, cliFetchRead, cliSearchRequest } from "./cliHttp.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function timeoutError(): Error {
  return Object.assign(new Error("aborted"), { name: "TimeoutError" });
}

describe("cliFetch", () => {
  test("returns the response on first success without retrying", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await cliFetch("https://x/cli/read", { method: "POST" }, { retries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("does NOT retry by default (retries=0) on timeout", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw timeoutError();
    }) as unknown as typeof fetch;

    await expect(cliFetch("https://x/cli/work/create", { method: "POST" })).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });

  test("retries on timeout up to the limit, then succeeds", async () => {
    let calls = 0;
    const retried: number[] = [];
    globalThis.fetch = (async () => {
      calls++;
      if (calls < 3) throw timeoutError();
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await cliFetch(
      "https://x/cli/feed",
      { method: "POST" },
      { retries: 2, onRetry: (i) => retried.push(i.attempt) },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(retried).toEqual([0, 1]);
  });

  test("retries on 5xx then returns the last response when exhausted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    const res = await cliFetch("https://x/cli/search", { method: "POST" }, { retries: 1 });
    expect(res.status).toBe(503);
    expect(calls).toBe(2); // initial + 1 retry, then gives up and returns it
  });

  test("does not retry 4xx (client error is not transient)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("nope", { status: 401 });
    }) as unknown as typeof fetch;

    const res = await cliFetch("https://x/cli/work/list", { method: "POST" }, { retries: 3 });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("cliFetchRead retries once by default on a transient timeout", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw timeoutError();
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await cliFetchRead("https://x/cli/feed", { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("throws a legible timeout error after exhausting retries", async () => {
    globalThis.fetch = (async () => {
      throw timeoutError();
    }) as unknown as typeof fetch;

    await expect(
      cliFetch("https://x/cli/tree", { method: "POST" }, { retries: 1, timeoutMs: 1234 }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });
});

describe("cliSearchRequest", () => {
  // Mock keyed off the request body (not call counts) so cliFetchRead's
  // internal 5xx retry doesn't skew the assertions.
  const mockSearch = (handler: (body: any) => Response) => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return handler(body);
    }) as unknown as typeof fetch;
    return bodies;
  };

  test("returns the primary result untouched on success", async () => {
    const bodies = mockSearch(() =>
      Response.json({ total_matches: 3, conversations: [{ id: "a" }] }));
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "q" });
    expect(result.total_matches).toBe(3);
    expect(result.content_search_error).toBeUndefined();
    expect(bodies.every((b) => !b.titles_only)).toBe(true);
  });

  test("falls back to titles_only when the backend dies on the content search", async () => {
    mockSearch((body) => body.titles_only
      ? Response.json({ total_matches: 0, conversations: [{ id: "a", title_match: true }], titles_only: true })
      : Response.json({ error: "Internal error", details: "request timed out" }, { status: 500 }));
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "green" });
    expect(result.titles_only).toBe(true);
    expect(result.conversations).toHaveLength(1);
    expect(result.content_search_error).toBe("request timed out");
  });

  test("falls back to titles_only on a transport failure", async () => {
    mockSearch((body) => {
      if (body.titles_only) return Response.json({ conversations: [], titles_only: true });
      throw timeoutError();
    });
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "green" });
    expect(result.titles_only).toBe(true);
    expect(result.content_search_error).toMatch(/timed out/);
  });

  test("returns the original error when the fallback also fails", async () => {
    mockSearch(() => Response.json({ error: "Internal error", details: "down" }, { status: 500 }));
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "green" });
    expect(result.error).toBe("Internal error");
    expect(result.titles_only).toBeUndefined();
  });

  test("rethrows a transport failure when the fallback also throws", async () => {
    mockSearch(() => { throw timeoutError(); });
    await expect(cliSearchRequest("https://x", { api_token: "t", query: "green" }))
      .rejects.toThrow(/timed out/);
  });

  test("does not fall back on validation/auth errors", async () => {
    const bodies = mockSearch(() =>
      Response.json({ error: "Unauthorized" }, { status: 401 }));
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "q" });
    expect(result.error).toBe("Unauthorized");
    expect(bodies).toHaveLength(1);
  });

  test("does not fall back again when the caller already asked for titles_only", async () => {
    const bodies = mockSearch(() =>
      Response.json({ error: "Internal error" }, { status: 500 }));
    const result = await cliSearchRequest("https://x", { api_token: "t", query: "q", titles_only: true });
    expect(result.error).toBe("Internal error");
    expect(bodies.every((b) => b.titles_only)).toBe(true);
  });
});
