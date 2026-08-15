import { describe, expect, test } from "bun:test";
import { extractBrowserTabId, focusBrowserTab } from "./browserFocus";
import type { TerminalEndpoint } from "./terminal/endpoint";

// convex is only touched when no getEndpoint override is passed; every test
// here injects one, so a bare object stands in for the client.
const convex = {} as never;

const endpoint: TerminalEndpoint = { port: 4242, token: "tok", deviceId: "dev-1", tmux: true };

const okResponse = { ok: true } as Response;
const notFoundResponse = { ok: false, status: 404 } as Response;

describe("extractBrowserTabId", () => {
  test("reads the tab line the CLI prints after open", () => {
    const out = "→ https://example.com\n  tab 4A2CDC7E — next: cast browser snapshot\n";
    expect(extractBrowserTabId(out)).toBe("4A2CDC7E");
  });

  test("last mention wins when a wedged tab was replaced", () => {
    const out = [
      "  tab 11111111 was not responding — opening a new one",
      "  tab 2BE86883 — next: cast browser snapshot",
    ].join("\n");
    expect(extractBrowserTabId(out)).toBe("2BE86883");
  });

  test("ignores --tab flags in recovery hints", () => {
    expect(extractBrowserTabId("If it keeps failing: cast browser close --tab 4A2CDC7E")).toBeNull();
  });

  test("sees through ANSI color codes", () => {
    expect(extractBrowserTabId("\x1b[2m  tab 4A2CDC7E — next: cast browser snapshot\x1b[0m")).toBe("4A2CDC7E");
  });

  test("requires exactly the 8-char short id", () => {
    expect(extractBrowserTabId("tab 4A2C")).toBeNull();
    expect(extractBrowserTabId("")).toBeNull();
    expect(extractBrowserTabId("opened a tab for you")).toBeNull();
  });
});

describe("focusBrowserTab — the fallback decision", () => {
  test("daemon confirms focus → true (no URL fallback)", async () => {
    let calledUrl = "";
    const focused = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: (async (url: string) => {
        calledUrl = String(url);
        return okResponse;
      }) as typeof fetch,
    });
    expect(focused).toBe(true);
    expect(calledUrl).toBe("http://127.0.0.1:4242/browser/focus?tab=4A2CDC7E");
  });

  test("no local endpoint (other machine / daemon down) → false", async () => {
    const focused = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => null,
      fetchImpl: (async () => okResponse) as typeof fetch,
    });
    expect(focused).toBe(false);
  });

  test("tab closed or browser stopped (404) → false", async () => {
    const focused = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: (async () => notFoundResponse) as typeof fetch,
    });
    expect(focused).toBe(false);
  });

  test("old daemon without the route (network error) → false", async () => {
    const focused = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    expect(focused).toBe(false);
  });

  test("discovery slower than the click budget → false now, discovery keeps running", async () => {
    const focused = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: () => new Promise<TerminalEndpoint>((r) => setTimeout(() => r(endpoint), 5_000)),
      fetchImpl: (async () => okResponse) as typeof fetch,
      discoveryBudgetMs: 50,
    });
    expect(focused).toBe(false);
  });
});
