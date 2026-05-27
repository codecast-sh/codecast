import { describe, test, expect, afterEach } from "bun:test";
import { cliFetch, cliFetchRead } from "./cliHttp.js";

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
    }) as typeof fetch;

    const res = await cliFetch("https://x/cli/read", { method: "POST" }, { retries: 2 });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("does NOT retry by default (retries=0) on timeout", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw timeoutError();
    }) as typeof fetch;

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
    }) as typeof fetch;

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
    }) as typeof fetch;

    const res = await cliFetch("https://x/cli/search", { method: "POST" }, { retries: 1 });
    expect(res.status).toBe(503);
    expect(calls).toBe(2); // initial + 1 retry, then gives up and returns it
  });

  test("does not retry 4xx (client error is not transient)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("nope", { status: 401 });
    }) as typeof fetch;

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
    }) as typeof fetch;

    const res = await cliFetchRead("https://x/cli/feed", { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("throws a legible timeout error after exhausting retries", async () => {
    globalThis.fetch = (async () => {
      throw timeoutError();
    }) as typeof fetch;

    await expect(
      cliFetch("https://x/cli/tree", { method: "POST" }, { retries: 1, timeoutMs: 1234 }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });
});
