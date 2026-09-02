import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { cancelReconcileCrawl, crawlThrottledAt, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { inboxCrawlWsKey } from "./useSyncInboxSessions";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOW = 1_750_000_000_000;
const THROTTLE = 30 * 60 * 1000; // SESSIONS_RECONCILE_THROTTLE_MS

// Regression coverage for the boot-eager hidden-set crawls. A dismiss/kill never
// moves updated_at, so the "dismissed" / "stashed" crawls are the only channel
// that heals a client which was asleep when the row was hidden elsewhere. While
// they honored the DURABLE watermark, a client reloading on a stale cache showed
// resurrected killed sessions for up to the full 30-minute throttle — and reload,
// the user's instinctive fix, was exactly the gesture that couldn't help.
describe("crawlThrottledAt", () => {
  it("bootEager ignores a recent PERSISTED watermark on the first run of a page session", () => {
    // Fresh module state (sessionDoneAt = 0) + a backfill that finished a minute
    // ago in a PRIOR page session. Boot-eager must crawl anyway.
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, true)).toBe(false);
  });

  it("bootEager still honors the IN-SESSION mark (effect re-fires must not re-crawl)", () => {
    // The effect behind these crawls re-runs on wsKey settle / every reconcileNonce
    // tick; once the boot crawl completes, st.doneAt gates the rest of the session.
    expect(crawlThrottledAt(NOW, THROTTLE, NOW - 60_000, 0, true)).toBe(true);
  });

  it("without bootEager a recent persisted watermark still skips (durable throttle intact)", () => {
    // The sessions / tasks / docs crawls are expensive and must keep serving from
    // the IDB cache on relaunch inside the window.
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, false)).toBe(true);
  });

  it("runs when neither watermark is inside the window", () => {
    expect(crawlThrottledAt(NOW, THROTTLE, 0, 0, false)).toBe(false);
    expect(crawlThrottledAt(NOW, THROTTLE, 0, 0, true)).toBe(false);
    // An expired persisted mark is no different from none.
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - THROTTLE - 1, false)).toBe(false);
  });
});


// The predicate can be right while the option is unplumbed, so exercise the real
// crawl: boot-eager must page despite a fresh persisted watermark, then throttle.
describe("runReconcileCrawl — boot-eager wiring", () => {
  beforeEach(() => {
    useInboxStore.setState({ syncMeta: {}, syncProgress: {} });
  });

  it("crawls once past a recent persisted watermark, then throttles for the rest of the session", async () => {
    useInboxStore.getState().recordSyncMeta(syncMetaKey("bEager", "wsBoot"), { backfilledAt: Date.now() });

    let calls = 0;
    const crawl = () => runReconcileCrawl({
      namespace: "bEager",
      wsKey: "wsBoot",
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 10,
      bootEager: true,
      fetchPage: async () => { calls++; return { rows: [{ _id: "d1" }], isDone: true, continueCursor: null }; },
      onPage: () => {},
      onComplete: () => {},
    });

    crawl();
    await delay(40);
    expect(calls).toBe(1);
    // Watermark is still WRITTEN on completion — other consumers read backfilledAt.
    expect(useInboxStore.getState().syncMeta[syncMetaKey("bEager", "wsBoot")]?.backfilledAt).toBeGreaterThan(0);

    // Re-fire (reconcileNonce tick / wsKey settle) — the in-session mark gates it.
    crawl();
    await delay(40);
    expect(calls).toBe(1);
  });

});

// A reload mid-crawl used to restart the walk from page zero — a client that
// reloads more often than a full crawl takes never finished and re-paid the
// whole table walk every launch. The flush checkpoint + resume below is what
// breaks that loop; the complete=false degradation is what keeps a resumed
// (partial-`all`) run from ever driving a prune.
describe("runReconcileCrawl — mid-crawl resume", () => {
  beforeEach(() => {
    useInboxStore.setState({ syncMeta: {}, syncProgress: {} });
  });

  const pagedFetcher = (pages: Record<string, { rows: any[]; next: string | null }>, log: (string | null)[]) =>
    async (cursor: string | null) => {
      log.push(cursor);
      const p = pages[cursor ?? "start"];
      return { rows: p.rows, isDone: p.next === null, continueCursor: p.next };
    };

  it("resumes from a fresh checkpoint, reports complete=false, and clears the checkpoint", async () => {
    const ns = "resumeNs";
    const key = syncMetaKey(ns, "ws1");
    // A prior interrupted run checkpointed at cursor "c2".
    useInboxStore.getState().recordSyncMeta(key, { resumeCursor: "c2", resumeAt: Date.now() });

    const fetched: (string | null)[] = [];
    let completeFlag: boolean | null = null;
    const all: any[] = [];
    runReconcileCrawl({
      namespace: ns,
      wsKey: "ws1",
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: pagedFetcher({
        start: { rows: [{ _id: "a" }], next: "c2" },
        c2: { rows: [{ _id: "b" }], next: "c3" },
        c3: { rows: [{ _id: "c" }], next: null },
      }, fetched),
      onPage: (rows) => all.push(...rows),
      onComplete: (rowsAll, complete) => { completeFlag = complete; },
    });
    await delay(60);

    // First fetch used the checkpoint, not page zero.
    expect(fetched[0]).toBe("c2");
    expect(all.map((r) => r._id)).toEqual(["b", "c"]);
    // Partial `all` ⇒ consumers must not prune on it.
    expect(completeFlag).toBe(false);
    // Checkpoint cleared + durable watermark written on completion.
    const meta = useInboxStore.getState().syncMeta[key];
    expect(meta?.resumeCursor).toBeUndefined();
    expect(meta?.backfilledAt).toBeGreaterThan(0);
  });

  it("ignores a stale checkpoint and reports complete=true from a full walk", async () => {
    const ns = "resumeStaleNs";
    const key = syncMetaKey(ns, "ws1");
    useInboxStore.getState().recordSyncMeta(key, { resumeCursor: "c2", resumeAt: Date.now() - 31 * 60 * 1000 });

    const fetched: (string | null)[] = [];
    let completeFlag: boolean | null = null;
    runReconcileCrawl({
      namespace: ns,
      wsKey: "ws1",
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: pagedFetcher({
        start: { rows: [{ _id: "a" }], next: "c2" },
        c2: { rows: [{ _id: "b" }], next: null },
      }, fetched),
      onPage: () => {},
      onComplete: (rowsAll, complete) => { completeFlag = complete; },
    });
    await delay(60);

    expect(fetched[0]).toBe(null);
    expect(completeFlag).toBe(true);
  });

  it("persists a checkpoint while crawling so an interruption can resume", async () => {
    const ns = "resumeCkptNs";
    const key = syncMetaKey(ns, "wsCk");
    let sawCheckpoint: string | undefined;
    runReconcileCrawl({
      namespace: ns,
      wsKey: "wsCk",
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 10,
      fetchPage: async (cursor) => {
        // Big page (>= FLUSH_ROWS) so every page flushes + checkpoints.
        const rows = Array.from({ length: 200 }, (_, i) => ({ _id: `${cursor ?? "p0"}-${i}` }));
        if (cursor === null) return { rows, isDone: false, continueCursor: "cNext" };
        // Second page: capture what the first flush persisted, then finish.
        sawCheckpoint = useInboxStore.getState().syncMeta[key]?.resumeCursor ?? undefined;
        return { rows, isDone: true, continueCursor: null };
      },
      onPage: () => {},
      onComplete: () => {},
    });
    await delay(80);
    // The flush after page 1 checkpointed the cursor that page was fetched with
    // (refetch overlap on resume is safe — overlays are additive).
    expect(sawCheckpoint).toBeDefined();
    // And completion cleared it.
    expect(useInboxStore.getState().syncMeta[key]?.resumeCursor).toBeUndefined();
  });
});

describe("inbox principal crawl keys", () => {
  it("does not share a completion mark between accounts, and skips before identity resolves", async () => {
    const namespace = `inbox-principal-${Math.random()}`;
    let calls = 0;
    const crawl = (wsKey: string) => runReconcileCrawl({
      namespace,
      wsKey,
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 1,
      fetchPage: async () => {
        calls++;
        return { rows: [], isDone: true, continueCursor: null };
      },
      onPage: () => {},
      onComplete: () => {},
    });

    crawl(inboxCrawlWsKey("account-a"));
    await delay(40);
    crawl(inboxCrawlWsKey("account-b"));
    await delay(40);
    crawl(inboxCrawlWsKey(undefined));
    await delay(20);

    expect(calls).toBe(2);
    expect(inboxCrawlWsKey(undefined)).toBe("skip");
  });

  it("cancels an in-flight account crawl on identity loss without blocking the next account", async () => {
    const namespace = `inbox-cancel-${Math.random()}`;
    let releaseA: (() => void) | null = null;
    let startedA: (() => void) | null = null;
    const aPages: any[] = [];
    const aCompletions: any[] = [];
    const bPages: any[] = [];

    runReconcileCrawl({
      namespace,
      wsKey: inboxCrawlWsKey("account-a"),
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 1,
      fetchPage: () => new Promise((resolve) => {
        startedA = () => resolve({ rows: [{ _id: "a" }], isDone: true, continueCursor: null });
        releaseA = startedA;
      }),
      onPage: (rows) => aPages.push(rows),
      onComplete: (rows) => aCompletions.push(rows),
    });
    await delay(10);
    expect(startedA).not.toBeNull();

    // This is the hook's identity-unknown transition: it must supersede A even
    // though no replacement crawl is yet eligible to start.
    runReconcileCrawl({
      namespace,
      wsKey: inboxCrawlWsKey(undefined),
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 1,
      fetchPage: async () => ({ rows: [], isDone: true, continueCursor: null }),
      onPage: () => {},
      onComplete: () => {},
    });

    runReconcileCrawl({
      namespace,
      wsKey: inboxCrawlWsKey("account-b"),
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 1,
      fetchPage: async () => ({ rows: [{ _id: "b" }], isDone: true, continueCursor: null }),
      onPage: (rows) => bPages.push(rows),
      onComplete: () => {},
    });
    releaseA?.();
    await delay(40);

    expect(aPages).toEqual([]);
    expect(aCompletions).toEqual([]);
    expect(bPages).toEqual([[{ _id: "b" }]]);
  });

  it("fences an awaited A completion after a principal switch, whether verification resolves or rejects", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const namespace = `inbox-complete-fence-${outcome}-${Math.random()}`;
      let release: (() => void) | null = null;
      let reject: ((error: Error) => void) | null = null;
      let verificationStarted = false;
      const applied: string[] = [];

      runReconcileCrawl({
        namespace,
        wsKey: inboxCrawlWsKey("account-a"),
        throttleMs: THROTTLE,
        pageDelayMs: 0,
        maxPages: 1,
        fetchPage: async () => ({ rows: [{ _id: "a" }], isDone: true, continueCursor: null }),
        onPage: () => {},
        onComplete: async (_rows, _complete, isCurrent) => {
          verificationStarted = true;
          try {
            await new Promise<void>((resolve, rejectPromise) => {
              release = resolve;
              reject = rejectPromise;
            });
          } catch {}
          if (isCurrent()) applied.push("a-clear");
        },
      });
      await delay(10);
      expect(verificationStarted).toBe(true);
      cancelReconcileCrawl(namespace);
      runReconcileCrawl({
        namespace,
        wsKey: inboxCrawlWsKey("account-b"),
        throttleMs: THROTTLE,
        pageDelayMs: 0,
        maxPages: 1,
        fetchPage: async () => ({ rows: [{ _id: "b" }], isDone: true, continueCursor: null }),
        onPage: () => applied.push("b-page"),
        onComplete: () => {},
      });
      if (outcome === "resolve") release?.();
      else reject?.(new Error("offline"));
      await delay(30);

      expect(applied).toEqual(["b-page"]);
    }
  });

});
