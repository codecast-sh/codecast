import { describe, expect, it } from "bun:test";
import {
  shouldReconcile,
  crawlAllPages,
  RECONCILE_THROTTLE_MS,
  MAX_RECONCILE_PAGES,
} from "../useSyncDocs";

// Regression for ct-32881: the docs sync used to auto-load EVERY remaining page
// on every mount/refresh (uncapped loadMore loop), re-walking the whole doc set
// into the store and hammering the saturated backend. The new behaviour holds
// one LIVE page and only crawls the rest via a THROTTLED, PAGE-BUDGETED one-shot
// reconcile. These tests pin both guarantees on the pure decision functions so
// they hold without mounting React.

describe("shouldReconcile (throttle gate)", () => {
  it("blocks a fresh crawl until the throttle window elapses", () => {
    // Just reconciled at t=0; a re-render at t=1000ms must NOT re-crawl.
    expect(shouldReconcile(0, 1000, RECONCILE_THROTTLE_MS)).toBe(false);
    // Still inside the window near the boundary.
    expect(shouldReconcile(0, RECONCILE_THROTTLE_MS - 1, RECONCILE_THROTTLE_MS)).toBe(false);
  });

  it("allows a crawl once the window has fully elapsed", () => {
    expect(shouldReconcile(0, RECONCILE_THROTTLE_MS, RECONCILE_THROTTLE_MS)).toBe(true);
    expect(shouldReconcile(0, RECONCILE_THROTTLE_MS + 1, RECONCILE_THROTTLE_MS)).toBe(true);
  });

  it("treats a never-run workspace (lastRun=0) at app start as eligible", () => {
    // First mount: lastRun defaults to 0, plenty of wall-clock time has passed.
    expect(shouldReconcile(0, Date.now(), RECONCILE_THROTTLE_MS)).toBe(true);
  });

  it("does NOT re-crawl across a burst of reactive re-renders inside one window", () => {
    const lastRun = 1_000_000;
    // Simulate many re-renders 50ms apart, all within the window.
    let crawls = 0;
    for (let i = 0; i < 50; i++) {
      const now = lastRun + i * 50;
      if (shouldReconcile(lastRun, now, RECONCILE_THROTTLE_MS)) crawls++;
    }
    expect(crawls).toBe(0);
  });
});

describe("crawlAllPages (bounded one-shot crawl)", () => {
  const makePages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      page: [{ _id: `d${i}`, project_path: `/p${i}` }],
      isDone: i === n - 1,
      continueCursor: i === n - 1 ? null : `c${i + 1}`,
    }));

  it("walks to isDone and accumulates every page", async () => {
    const pages = makePages(5);
    let calls = 0;
    const all = await crawlAllPages(async () => pages[calls++]);
    expect(all).not.toBeNull();
    expect(all!.length).toBe(5);
    expect(calls).toBe(5);
  });

  it("stops at the page budget instead of walking forever", async () => {
    // A server that NEVER reports isDone and always hands back a fresh cursor
    // would, under the old uncapped loop, fetch indefinitely.
    let calls = 0;
    const all = await crawlAllPages(
      async () => {
        calls++;
        return { page: [{ _id: `d${calls}` }], isDone: false, continueCursor: `c${calls}` };
      },
      { maxPages: 3 }
    );
    expect(calls).toBe(3); // capped, not infinite
    expect(all!.length).toBe(3);
  });

  it("never exceeds MAX_RECONCILE_PAGES by default", async () => {
    let calls = 0;
    await crawlAllPages(async () => {
      calls++;
      return { page: [], isDone: false, continueCursor: `c${calls}` };
    });
    expect(calls).toBe(MAX_RECONCILE_PAGES);
  });

  it("aborts (returns null) when a page fetch throws — no partial snapshot", async () => {
    let calls = 0;
    const all = await crawlAllPages(async () => {
      calls++;
      if (calls === 2) throw new Error("backend hiccup");
      return { page: [{ _id: `d${calls}` }], isDone: false, continueCursor: `c${calls}` };
    });
    expect(all).toBeNull();
  });

  it("aborts (returns null) when cancelled mid-crawl", async () => {
    let calls = 0;
    let cancelled = false;
    const all = await crawlAllPages(
      async () => {
        calls++;
        if (calls === 2) cancelled = true; // unmount/workspace switch mid-crawl
        return { page: [{ _id: `d${calls}` }], isDone: false, continueCursor: `c${calls}` };
      },
      { isCancelled: () => cancelled }
    );
    expect(all).toBeNull();
  });

  it("stops on a single done page (the common small-workspace case)", async () => {
    let calls = 0;
    const all = await crawlAllPages(async () => {
      calls++;
      return { page: [{ _id: "only" }], isDone: true, continueCursor: null };
    });
    expect(calls).toBe(1);
    expect(all!.length).toBe(1);
  });
});
