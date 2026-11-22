// ct-74162: the fetchToken wrapper retries a refresh that failed in transit and
// leaves a real refusal alone. The library-level path (pristine Convex Auth
// throws, the ct-91563 patch returns the old token) is covered here directly;
// lib/__tests__/authRefreshOffline.test.ts renders the whole auth root.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { installRefreshRetry, isRefreshInTransit, retryRefreshInTransit } from "./authRefreshRetry";

const fakeWindow = new EventTarget();
let onLine = true;
const saved = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { get onLine() { return onLine; } }, configurable: true, writable: true });
afterAll(() => {
  for (const key of ["window", "navigator"] as const) {
    if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
    else delete (globalThis as any)[key];
  }
});
beforeEach(() => { onLine = true; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("retryRefreshInTransit (ct-74162)", () => {
  test("a refresh that throws in transit (pristine library) is retried, at most once a second, and never rejects", async () => {
    const calls: number[] = [];
    const wrapped = retryRefreshInTransit(async ({ forceRefreshToken }) => {
      if (!forceRefreshToken) return "old";
      calls.push(Date.now());
      if (calls.length < 3) throw new TypeError("Failed to fetch");
      return "fresh";
    }, new AbortController().signal);
    expect(await wrapped({ forceRefreshToken: false })).toBe("old");
    expect(await wrapped({ forceRefreshToken: true })).toBe("fresh");
    expect(calls.length).toBe(3);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(990);
  }, 10000);

  test("the patched library's give-up (the same token back) is retried, not reported as a sign-out", async () => {
    let n = 0;
    const wrapped = retryRefreshInTransit(async ({ forceRefreshToken }) => (forceRefreshToken && ++n >= 2 ? "fresh" : "old"), new AbortController().signal);
    await wrapped({ forceRefreshToken: false });
    expect(await wrapped({ forceRefreshToken: true })).toBe("fresh");
    expect(n).toBe(2);
  }, 5000);

  test("offline, the retry waits for the online event", async () => {
    onLine = false;
    let n = 0;
    const wrapped = retryRefreshInTransit(async () => {
      if (++n === 1) throw new TypeError("Failed to fetch");
      return "fresh";
    }, new AbortController().signal);
    const result = wrapped({ forceRefreshToken: true });
    await sleep(2500);
    expect(n).toBe(1);
    onLine = true;
    fakeWindow.dispatchEvent(new Event("online"));
    expect(await result).toBe("fresh");
    expect(n).toBe(2);
  }, 10000);

  test("a real refusal passes straight through: null signs out, an error from the function rejects", async () => {
    const refused = retryRefreshInTransit(async () => null, new AbortController().signal);
    expect(await refused({ forceRefreshToken: true })).toBeNull();
    const failing = retryRefreshInTransit(async () => { throw new Error("Invalid refresh token"); }, new AbortController().signal);
    await expect(failing({ forceRefreshToken: true })).rejects.toThrow("Invalid refresh token");
  });

  test("a newer setAuth or clearAuth ends the old config's retry loop", async () => {
    let n = 0;
    const client = {
      setAuth: (fetchToken: any) => { void fetchToken({ forceRefreshToken: true }).then((t: unknown) => results.push(t)); },
      clearAuth: () => {},
    };
    const results: unknown[] = [];
    installRefreshRetry(client);
    client.setAuth(async () => { n++; throw new TypeError("Failed to fetch"); });
    await sleep(50);
    client.clearAuth();
    await sleep(1500);
    expect(n).toBe(1);
    expect(results).toEqual([null]);
  }, 5000);

  test("classifies transit failures", () => {
    expect(isRefreshInTransit(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRefreshInTransit(Object.assign(new Error("x"), { codecastInTransit: true }))).toBe(true);
    expect(isRefreshInTransit(new Error('{"code":"ExpiredInQueue"}'))).toBe(true);
    expect(isRefreshInTransit(new Error("<html><title>503 Service Unavailable</title></html>"))).toBe(true);
    expect(isRefreshInTransit(new Error("Invalid refresh token"))).toBe(false);
  });
});
