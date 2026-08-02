import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { bootEagerArmed, cancelReconcileCrawl, crawlThrottledAt, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { hiddenCrawlReady, inboxCrawlWsKey } from "./useSyncInboxSessions";

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

// The eager crawl's CLEAR pass un-hides rows the server's hidden set omits, so
// running it before the durable outbox replays can resurrect a kill the user made
// offline: the parked dispatch hasn't reached the server, and the pending field
// lock that would have protected the row is released as stale after 5 minutes.
// The durable throttle used to mask this by skipping the boot crawl entirely.
describe("bootEagerArmed", () => {
  it("holds the bypass while the outbox still has an unreplayed boot backlog", () => {
    expect(bootEagerArmed(false)).toBe(false);
  });

  it("arms as soon as the boot drain reports every parked entry attempted", () => {
    expect(bootEagerArmed(true)).toBe(true);
  });

  it("never arms a crawl against an unreplayed durable outbox", () => {
    expect(bootEagerArmed(false)).toBe(false);
  });

  it("composes with the throttle once armed", () => {
    // The hook holds the crawl entirely while unarmed. Once armed, the persisted
    // watermark is ignored and the crawl runs.
    const armed = bootEagerArmed(false);
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, armed)).toBe(true);
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, bootEagerArmed(true))).toBe(false);
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

  it("rechecks durable outbox readiness after a previously armed principal wakes", () => {
    const key = inboxCrawlWsKey("account-a");
    expect(hiddenCrawlReady(key, key, true)).toBe(true);
    // A later failed/offline enqueue reopens the durable outbox; a wake must
    // not use the old principal latch to launch a hidden-set CLEAR crawl.
    expect(hiddenCrawlReady(key, key, false)).toBe(false);
  });

  it("does not complete a hidden CLEAR after the durable outbox reopens", async () => {
    const namespace = `hidden-outbox-fence-${Math.random()}`;
    let durableOutboxDrained = true;
    let releaseFetch: (() => void) | null = null;
    let clearCalls = 0;
    runReconcileCrawl({
      namespace,
      wsKey: inboxCrawlWsKey("account-a"),
      throttleMs: THROTTLE,
      pageDelayMs: 0,
      maxPages: 1,
      isCurrent: () => durableOutboxDrained,
      fetchPage: () => new Promise((resolve) => {
        releaseFetch = () => resolve({ rows: [], isDone: true, continueCursor: null });
      }),
      onPage: () => {},
      onComplete: () => { clearCalls++; },
    });
    await delay(10);
    // A failed/offline enqueue makes the durable queue non-empty before this
    // crawl can run its CLEAR phase.
    durableOutboxDrained = false;
    releaseFetch?.();
    await delay(30);

    expect(clearCalls).toBe(0);
  });
});
