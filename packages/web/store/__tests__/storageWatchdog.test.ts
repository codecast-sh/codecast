import { afterEach, describe, expect, it } from "bun:test";
import { action, mutativeMiddleware } from "../mutativeMiddleware";

// The storage watchdog feeds the "Local storage is not keeping up" banner.
// The first cut was twitchy in exactly the ways users notice as a banner that
// pops up and vanishes: a throttled/frozen tab or a system sleep fired the
// timer late and tripped it on resume (measuring the pause, not IndexedDB),
// and a tripped write could never clear itself — the healthy signal required
// a LATER write to commit fast, so the banner lingered until an unrelated
// action. These tests pin the corrected contract:
//   - trip only from a live, running page (late/hidden fires re-arm a recheck)
//   - a commit at any speed clears the banner once nothing is overdue
//   - a fast commit does NOT clear while another write is still stuck
//   - a rejected enqueue reports unhealthy (the old path was silent)

const WATCHDOG_MS = 40;
const MAX_LAG_MS = 150;
const RECHECK_MS = 20;

type Health = { healthy: boolean; elapsedMs: number };

function makeHarness() {
  const health: Health[] = [];
  // Controllable enqueue: each call parks a resolver the test settles by hand.
  const parked: Array<{ entry: any; resolve: () => void; reject: (e: unknown) => void }> = [];
  let state: any;
  const set = (next: any) => { state = next; };
  const get = () => state;
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      poke: action(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
    }),
    {
      retryDelays: [],
      storageWatchdogMs: WATCHDOG_MS,
      storageWatchdogMaxLagMs: MAX_LAG_MS,
      storageWatchdogRecheckMs: RECHECK_MS,
    },
  )(set, get, {});
  state = wrapped;
  wrapped._setOutbox(
    (entry: any) => new Promise<void>((resolve, reject) => { parked.push({ entry, resolve, reject }); }),
    () => {},
    async () => [],
  );
  wrapped._setStorageHealth((healthy: boolean, elapsedMs: number) => {
    health.push({ healthy, elapsedMs });
  });
  return { wrapped, health, parked };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Event-driven wait: suite load makes fixed sleeps flaky (an overshot timer
// legitimately re-arms a recheck instead of tripping on schedule).
async function waitFor(cond: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

// Simulated event-loop pause (frozen tab, system sleep): the armed watchdog
// fires immediately afterwards with overshoot well past MAX_LAG_MS.
function blockEventLoop(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy-wait */ }
}

const originalDocument = (globalThis as any).document;

afterEach(() => {
  (globalThis as any).document = originalDocument;
});

describe("storage watchdog", () => {
  it("trips when a durable enqueue stays uncommitted past the deadline", async () => {
    const { wrapped, health } = makeHarness();
    wrapped.poke("a");
    await waitFor(() => health.length > 0);
    expect(health).toEqual([{ healthy: false, elapsedMs: expect.any(Number) }]);
  });

  it("clears itself when the stuck write finally commits", async () => {
    const { wrapped, health, parked } = makeHarness();
    wrapped.poke("a");
    await waitFor(() => health.length > 0);
    expect(health.at(-1)?.healthy).toBe(false);
    parked[0]!.resolve();
    await waitFor(() => health.at(-1)?.healthy === true);
  });

  it("logs the late commit so a stall reads as a stall, not a permanent wedge", async () => {
    const { wrapped, health, parked } = makeHarness();
    const warned: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => {
      const line = String(args[0]);
      if (line.includes("storage recovered")) warned.push(line);
    };
    console.error = () => {};
    try {
      wrapped.poke("a");
      await waitFor(() => health.length > 0);
      expect(warned).toEqual([]);
      parked[0]!.resolve();
      await waitFor(() => health.at(-1)?.healthy === true);
      expect(warned).toEqual([expect.stringMatching(/committed after \d+ms — storage recovered/)]);
      // A write that never tripped commits silently — the recovery line pairs
      // only with a preceding error line.
      wrapped.poke("b");
      parked[1]!.resolve();
      await sleep(10);
      expect(warned).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  it("does not clear on a fast commit while another write is still stuck", async () => {
    const { wrapped, health, parked } = makeHarness();
    wrapped.poke("stuck");
    await waitFor(() => health.length > 0);
    expect(health.at(-1)?.healthy).toBe(false);
    wrapped.poke("fast");
    parked[1]!.resolve();
    await sleep(10);
    expect(health.at(-1)?.healthy).toBe(false);
    parked[0]!.resolve();
    await waitFor(() => health.at(-1)?.healthy === true);
  });

  it("does not trip from a hidden tab, but trips after it becomes visible", async () => {
    const { wrapped, health, parked } = makeHarness();
    (globalThis as any).document = { visibilityState: "hidden" };
    wrapped.poke("a");
    // Every fire while hidden re-arms a recheck, regardless of timing.
    await sleep(WATCHDOG_MS + RECHECK_MS * 4);
    expect(health).toEqual([]);
    (globalThis as any).document = { visibilityState: "visible" };
    await waitFor(() => health.length > 0);
    expect(health.at(-1)?.healthy).toBe(false);
    parked[0]!.resolve();
    await waitFor(() => health.at(-1)?.healthy === true);
  });

  it("treats a grossly late timer as an event-loop pause, not unhealthy storage", async () => {
    const { wrapped, health, parked } = makeHarness();
    wrapped.poke("a");
    blockEventLoop(WATCHDOG_MS + MAX_LAG_MS * 2);
    // Commit lands right after the pause, as it does on resume. The pending
    // enqueue settles in a microtask — before the re-armed recheck can run —
    // so no unhealthy signal must ever fire.
    parked[0]!.resolve();
    await waitFor(() => health.length > 0);
    expect(health.filter((h) => !h.healthy)).toEqual([]);
    expect(health.at(-1)?.healthy).toBe(true);
  });

  it("keeps the recheck armed after a pause, so a truly stuck write still trips", async () => {
    const { wrapped, health } = makeHarness();
    wrapped.poke("a");
    blockEventLoop(WATCHDOG_MS + MAX_LAG_MS * 2);
    await waitFor(() => health.length > 0);
    expect(health.at(-1)?.healthy).toBe(false);
  });

  it("reports unhealthy when the durable enqueue rejects", async () => {
    const { wrapped, health, parked } = makeHarness();
    wrapped.poke("a");
    await waitFor(() => parked.length > 0);
    parked[0]!.reject(new Error("quota exceeded"));
    await waitFor(() => health.length > 0);
    expect(health).toEqual([{ healthy: false, elapsedMs: expect.any(Number) }]);
  });
});
