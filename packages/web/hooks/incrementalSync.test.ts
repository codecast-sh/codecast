import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { isPersistedStoreKey } from "../store/idbCache";
import { runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Regression coverage for incremental local-first task sync (ct-34943):
// the desktop must NOT re-crawl the whole task table on every launch, and must
// resume delta sync from a persisted high-water mark instead of re-snapshotting.
describe("incremental sync watermark (syncMeta)", () => {
  beforeEach(() => {
    useInboxStore.setState({ syncMeta: {}, syncProgress: {} });
  });

  it("is a persisted store key (write side wired)", () => {
    // A watermark that doesn't persist is useless — it must survive reload.
    expect(isPersistedStoreKey("syncMeta")).toBe(true);
  });

  it("advances the cursor forward-only; backfilledAt is set wholesale", () => {
    const s = useInboxStore.getState();
    s.recordSyncMeta("tasks:wsA", { cursor: 100, backfilledAt: 5 });
    expect(useInboxStore.getState().syncMeta["tasks:wsA"]).toEqual({ cursor: 100, backfilledAt: 5 });

    // A late / out-of-order delta with a LOWER cursor must not rewind the mark
    // (which would re-fetch already-synced rows forever).
    s.recordSyncMeta("tasks:wsA", { cursor: 50 });
    expect(useInboxStore.getState().syncMeta["tasks:wsA"].cursor).toBe(100);

    // A higher cursor advances it.
    s.recordSyncMeta("tasks:wsA", { cursor: 200 });
    expect(useInboxStore.getState().syncMeta["tasks:wsA"].cursor).toBe(200);
  });
});

describe("runReconcileCrawl — durable throttle + watermark", () => {
  beforeEach(() => {
    useInboxStore.setState({ syncMeta: {}, syncProgress: {} });
  });

  it("SKIPS the crawl when a recent backfill is persisted (no full re-walk on relaunch)", async () => {
    // Simulate a backfill that completed moments ago, as a fresh page load would
    // restore from IDB. The crawl must serve from cache, not re-page the table.
    useInboxStore.getState().recordSyncMeta(syncMetaKey("tThrottle", "wsRecent"), { backfilledAt: Date.now(), cursor: 42 });

    let calls = 0;
    runReconcileCrawl({
      namespace: "tThrottle",
      wsKey: "wsRecent",
      throttleMs: 60_000,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: async () => { calls++; return { rows: [], isDone: true, continueCursor: null }; },
      onPage: () => {},
      onComplete: () => {},
    });
    await delay(25);
    expect(calls).toBe(0);
  });

  it("runs a full backfill when there is no watermark, then persists cursor + backfilledAt", async () => {
    let calls = 0;
    runReconcileCrawl({
      namespace: "tBackfill",
      wsKey: "wsCold",
      throttleMs: 60_000,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: async () => {
        calls++;
        return { rows: [{ _id: "t1", updated_at: 777 }, { _id: "t2", updated_at: 999 }], isDone: true, continueCursor: null };
      },
      onPage: () => {},
      onComplete: () => {},
    });
    await delay(50);
    expect(calls).toBe(1);
    const meta = useInboxStore.getState().syncMeta[syncMetaKey("tBackfill", "wsCold")];
    expect(meta?.backfilledAt).toBeGreaterThan(0);
    // cursor = highest updated_at seen → the NEXT crawl resumes incrementally from here.
    expect(meta?.cursor).toBe(999);
  });
});

// Regression coverage for the dismiss reconcile (ct-35620). The dismiss CLEAR
// pass PRUNES (un-dismisses) locally-dismissed sessions the server no longer
// reports — so it must run ONLY on a provably-complete crawl. reconcileCrawl
// reports completeness via onComplete's 2nd arg; a crawl truncated at maxPages
// reports false so the tail (un-fetched dismissed rows) can never be wrongly
// un-dismissed. (Root cause: listDismissedSessionsLite folded Date.now() into
// its paginated index range → InvalidCursor on page 2 → the crawl only ever saw
// its first page; the server now takes a stable client-supplied `since`.)
describe("runReconcileCrawl — completeness flag (dismiss CLEAR guard)", () => {
  beforeEach(() => {
    useInboxStore.setState({ syncMeta: {}, syncProgress: {} });
  });

  it("reports complete=true when the crawl reaches the true end (isDone)", async () => {
    let seen: boolean | undefined;
    runReconcileCrawl({
      namespace: "cDone",
      wsKey: "wsA",
      throttleMs: 60_000,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: async () => ({ rows: [{ _id: "d1" }], isDone: true, continueCursor: null }),
      onPage: () => {},
      onComplete: (_all, complete) => { seen = complete; },
    });
    await delay(40);
    expect(seen).toBe(true);
  });

  it("reports complete=false when the crawl stops at maxPages with more rows pending", async () => {
    // Every page advances the cursor and never returns isDone → the crawl is
    // forced to stop at maxPages. A naive `onComplete => CLEAR` would treat this
    // partial set as authoritative and un-dismiss every row it never fetched.
    let pages = 0;
    let seen: boolean | undefined;
    let completeRows = -1;
    runReconcileCrawl({
      namespace: "cTrunc",
      wsKey: "wsB",
      throttleMs: 60_000,
      pageDelayMs: 0,
      maxPages: 3,
      fetchPage: async () => {
        pages++;
        return { rows: [{ _id: `d${pages}` }], isDone: false, continueCursor: `cursor-${pages}` };
      },
      onPage: () => {},
      onComplete: (all, complete) => { seen = complete; completeRows = all.length; },
    });
    await delay(60);
    expect(pages).toBe(3);            // stopped exactly at maxPages
    expect(seen).toBe(false);         // crawl is NOT complete → CLEAR must be skipped
    expect(completeRows).toBe(3);     // onComplete still fires (SET-only path is safe)
  });
});
