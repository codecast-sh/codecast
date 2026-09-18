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
