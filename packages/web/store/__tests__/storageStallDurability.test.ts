import { describe, expect, it } from "bun:test";
import { action, mutativeMiddleware } from "../mutativeMiddleware";

// ct-74868: a durable outbox write that Chromium aborts with
// "TimeoutError: Transaction timed out due to inactivity" (eg-2936, 110s in)
// is never written again, so the action is not in the journal and a reload
// before the server answers loses it. And the watchdog line leads with the
// action name and elapsed ms, so one storage condition files a new error
// group per action (eg-1531 and nine siblings).

const WATCHDOG_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function timeoutError() {
  const e = new Error("Transaction timed out due to inactivity.");
  e.name = "TimeoutError";
  return e;
}

function makeStore(opts: {
  disk: Map<string, any>;
  enqueue?: (entry: any) => Promise<void>;
  dispatch?: (action: string, args: unknown[]) => Promise<unknown>;
}) {
  let state: any;
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      poke: action(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
      prod: action(function (this: any, id: string) {
        this.items[id] = { _id: id, prodded: true };
      }),
    }),
    { retryDelays: [], storageWatchdogMs: WATCHDOG_MS, storageWatchdogMaxLagMs: 10_000, storageWatchdogRecheckMs: 20 },
  )((next: any) => { state = next; }, () => state, {});
  state = wrapped;
  wrapped._setOutbox(
    opts.enqueue ?? (async (entry: any) => { opts.disk.set(entry.id, entry); }),
    async (id: string) => { opts.disk.delete(id); },
    async () => [...opts.disk.values()],
  );
  wrapped._setStorageHealth(() => {});
  if (opts.dispatch) wrapped._setDispatch(opts.dispatch as any);
  return wrapped;
}

function quietConsole() {
  const errors: string[] = [];
  const original = { error: console.error, warn: console.warn };
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  console.warn = () => {};
  return { errors, restore: () => Object.assign(console, original) };
}

describe("durable outbox under a stalled or timed-out IndexedDB (ct-74868)", () => {
  it("a write aborted with TimeoutError is journaled again, and replays once after a reload", async () => {
    const { restore } = quietConsole();
    try {
      const disk = new Map<string, any>();
      let attempts = 0;
      const store = makeStore({
        disk,
        enqueue: async (entry) => {
          attempts++;
          if (attempts === 1) throw timeoutError();
          disk.set(entry.id, entry);
        },
        // The server has not answered yet (slow link, offline): the journal
        // is the only copy of this action.
        dispatch: () => new Promise(() => {}),
      });
      store.poke("a");
      await waitFor(() => attempts >= 1);
      await sleep(WATCHDOG_MS * 4);
      expect([...disk.values()].map((e) => e.action)).toEqual(["poke"]);

      const delivered: string[] = [];
      makeStore({
        disk,
        dispatch: async (name) => { delivered.push(name); return null; },
      });
      await waitFor(() => delivered.length > 0);
      await sleep(20);
      expect(delivered).toEqual(["poke"]);
    } finally {
      restore();
    }
  });

  it("the watchdog line reads the same for every action and every stall length", async () => {
    const { errors, restore } = quietConsole();
    try {
      const store = makeStore({ disk: new Map(), enqueue: () => new Promise(() => {}) });
      store.poke("a");
      await sleep(15);
      store.prod("b");
      await waitFor(() => errors.filter((l) => l.includes("uncommitted")).length >= 2);
      const lead = errors
        .filter((l) => l.includes("uncommitted"))
        .map((l) => l.split(" — ")[0]);
      expect(lead[0]).toBe(lead[1]);
      expect(lead[0]).not.toMatch(/poke|prod|\d+ms/);
    } finally {
      restore();
    }
  });
});
