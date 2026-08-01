import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../store/inboxStore";
import { bootEagerArmed, crawlThrottledAt, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";

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
const MAX_WAIT = 10_000; // BOOT_OUTBOX_DRAIN_MAX_WAIT_MS
describe("bootEagerArmed", () => {
  it("holds the bypass while the outbox still has an unreplayed boot backlog", () => {
    expect(bootEagerArmed(false, 0, MAX_WAIT)).toBe(false);
    expect(bootEagerArmed(false, MAX_WAIT - 1, MAX_WAIT)).toBe(false);
  });

  it("arms as soon as the boot drain reports every parked entry attempted", () => {
    expect(bootEagerArmed(true, 0, MAX_WAIT)).toBe(true);
  });

  it("arms at the deadline anyway — a wedged or unwired outbox must not disable healing", () => {
    // No dispatch binding (or a drain that keeps aborting) leaves the signal false
    // forever; the crawl is the only healer for killed sessions, so it still runs.
    expect(bootEagerArmed(false, MAX_WAIT, MAX_WAIT)).toBe(true);
    expect(bootEagerArmed(false, MAX_WAIT + 5_000, MAX_WAIT)).toBe(true);
  });

  it("composes with the throttle: un-armed falls back to the safe durable behavior", () => {
    // Not armed → the caller passes bootEager:false → a recent persisted watermark
    // skips the crawl, exactly as it did before boot-eager existed.
    const armed = bootEagerArmed(false, 0, MAX_WAIT);
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, armed)).toBe(true);
    // Armed → the persisted watermark is ignored and the crawl runs.
    expect(crawlThrottledAt(NOW, THROTTLE, 0, NOW - 60_000, bootEagerArmed(true, 0, MAX_WAIT))).toBe(false);
  });
});

// The predicate can be right while the option is unplumbed, so exercise the real
// crawl: boot-eager must page despite a fresh persisted watermark, then throttle.
describe("runReconcileCrawl — bootEager wiring", () => {
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
