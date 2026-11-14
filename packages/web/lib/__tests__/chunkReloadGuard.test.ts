import { beforeEach, describe, expect, test } from "bun:test";
import { MAX_AUTO_RELOADS, RELOAD_COUNT_KEY, isChunkLoadError, tryReloadForStaleChunk } from "../chunkReloadGuard";

describe("isChunkLoadError", () => {
  test("a module served without a named export is a stale-module error", () => {
    // The exact message a dev tab showed on 2026-09-13 after Vite served
    // EntityIdPill.tsx mid-edit. React.lazy memoizes the rejection, so the
    // pane can only heal by reloading, which this classification triggers.
    expect(
      isChunkLoadError(
        "The requested module '/components/EntityIdPill.tsx?t=1789356290505' does not provide an export named 'EntityAwareCode'",
      ),
    ).toBe(true);
    expect(isChunkLoadError("The requested module './x' doesn't provide an export named 'y'")).toBe(true);
    expect(isChunkLoadError("Importing binding name 'y' is not found.")).toBe(true);
  });

  test("a stale hashed chunk after a deploy is a stale-module error", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module: https://x/assets/page-abc.js")).toBe(true);
    expect(isChunkLoadError("Loading CSS chunk 12 failed")).toBe(true);
  });

  test("a stale hashed CSS chunk after a deploy is a stale-module error", () => {
    // The exact production Sentry message (JAVASCRIPT-REACT-5N): a tab on the
    // previous index.html asking the CDN for a stylesheet hash that deploy
    // deleted. Classifying it here is what makes the tab reload onto the
    // current build instead of sitting broken and only reporting.
    expect(isChunkLoadError("Unable to preload CSS for /assets/decisions-DAwruZUT.css")).toBe(true);
    expect(isChunkLoadError("Unable to preload CSS for /assets/page-CUYwqdYW.css")).toBe(true);
  });

  test("ordinary code bugs never trigger an auto-reload", () => {
    expect(isChunkLoadError("Cannot read properties of undefined (reading 'map')")).toBe(false);
    expect(isChunkLoadError("x is not a function")).toBe(false);
    expect(isChunkLoadError("")).toBe(false);
    // Environment failures that are NOT staleness: reloading fixes neither, so
    // neither may spend the reload budget.
    expect(isChunkLoadError("QuotaExceededError Encountered full disk while opening backing store")).toBe(false);
    expect(isChunkLoadError("AbortError: UnknownError Connection is closing.")).toBe(false);
  });
});

describe("tryReloadForStaleChunk", () => {
  let reloads = 0;
  let store: Record<string, string> = {};

  beforeEach(() => {
    reloads = 0;
    store = {};
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    (globalThis as any).window = { location: { reload: () => { reloads++; } } };
  });

  test("reloads once per incident, then declines so a re-crash cannot loop", () => {
    expect(tryReloadForStaleChunk()).toBe(true);
    expect(reloads).toBe(1);
    expect(store[RELOAD_COUNT_KEY]).toBe(String(MAX_AUTO_RELOADS));

    // The reloaded tab crashing again finds the budget spent: no second
    // reload, so the error UI takes over instead of a reload loop.
    expect(tryReloadForStaleChunk()).toBe(false);
    expect(reloads).toBe(1);
  });

  test("declines when sessionStorage is unavailable — no counter, no reload", () => {
    (globalThis as any).sessionStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() {},
      removeItem() {},
    };
    expect(tryReloadForStaleChunk()).toBe(false);
    expect(reloads).toBe(0);
  });
});

// A service worker may answer the reload itself: its precached shell is the
// offline fallback, and the worker before 2026-11-12 answered every navigation
// from it. Either way the reload boots the same stale build, whose lazy chunk
// is still gone, and the one-reload budget is spent on nothing. That left
// codecast.sh on "Couldn't load App" for a tab a day behind (MarketingLayout
// 404). When the server is reachable and serves another build, the guard drops
// the worker first, so the reload reaches the network.
describe("tryReloadForStaleChunk with a service worker", () => {
  let events: string[] = [];
  let served: (() => Promise<unknown>) | null = null;

  const flush = async () => {
    for (let i = 0; i < 10 && !events.includes("reload"); i++) await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    events = [];
    const store: Record<string, string> = {};
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    };
    served = async () => ({ ok: true, json: async () => ({ sha: "new-build" }) });
    (globalThis as any).window = {
      __CODECAST_BUILD: { sha: "old-build" },
      location: { reload: () => { events.push("reload"); } },
      fetch: (url: string) => { events.push(`fetch ${url.split("?")[0]}`); return served!(); },
      navigator: {
        serviceWorker: {
          controller: {},
          getRegistration: async () => ({ unregister: async () => { events.push("unregister"); return true; } }),
        },
      },
    };
  });

  test("drops the worker before reloading when the server serves a newer build", async () => {
    expect(tryReloadForStaleChunk()).toBe(true);
    await flush();
    expect(events).toEqual(["fetch /version.json", "unregister", "reload"]);
  });

  test("keeps the worker offline: it holds the only shell there is", async () => {
    served = async () => { throw new TypeError("Failed to fetch"); };
    expect(tryReloadForStaleChunk()).toBe(true);
    await flush();
    expect(events).toEqual(["fetch /version.json", "reload"]);
  });

  test("keeps the worker when the server serves this same build", async () => {
    served = async () => ({ ok: true, json: async () => ({ sha: "old-build" }) });
    expect(tryReloadForStaleChunk()).toBe(true);
    await flush();
    expect(events).toEqual(["fetch /version.json", "reload"]);
  });

  test("still reloads when dropping the worker fails", async () => {
    (globalThis as any).window.navigator.serviceWorker.getRegistration = async () => { throw new Error("InvalidStateError"); };
    expect(tryReloadForStaleChunk()).toBe(true);
    await flush();
    expect(events).toEqual(["fetch /version.json", "reload"]);
  });

  test("a page no worker controls reloads at once, without asking the server", () => {
    (globalThis as any).window.navigator.serviceWorker.controller = null;
    expect(tryReloadForStaleChunk()).toBe(true);
    expect(events).toEqual(["reload"]);
  });
});
