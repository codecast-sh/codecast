import "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, it, expect } from "bun:test";
import { enqueueDispatch, loadOutbox, removeDispatch, _reopenForTests } from "../idbCache";
import { action, mutativeMiddleware } from "../mutativeMiddleware";

await _reopenForTests({ indexedDB, IDBKeyRange });

// ct-75824: Chrome aborts an IndexedDB write with "TimeoutError: Transaction
// timed out due to inactivity" when the page stalls (seen beside 85-126s
// /vault/file requests). That is transient: the same put succeeds a moment
// later. A durable outbox write must survive one such abort instead of
// rejecting, which the middleware reports as lasting failure ("durable enqueue
// ... failed after Nms — durability is degraded") and never retries. A write
// that keeps failing, or fails for any other reason, must still surface.

const entry = (id: string) => ({ id, action: "stageExpandLeaf", args: {}, patches: {}, result: null, ts: 1 }) as any;

// Every dispatchOutbox put goes through here: `failures` names the error each
// of the first puts throws (by DOMException name), later puts commit.
let restorePut: (() => void) | null = null;
function failOutboxPuts(failures: string[]) {
  const proto = IDBObjectStore.prototype as any;
  const realPut = proto.put;
  const calls = { count: 0, committedAt: 0 };
  let left = [...failures];
  proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name !== "dispatchOutbox") return realPut.apply(this, args);
    calls.count++;
    const name = left.shift();
    if (name) throw new DOMException(name === "TimeoutError" ? "Transaction timed out due to inactivity" : name, name);
    calls.committedAt = performance.now();
    return realPut.apply(this, args);
  };
  restorePut = () => { proto.put = realPut; };
  return calls;
}

afterEach(async () => {
  restorePut?.();
  restorePut = null;
  for (const e of await loadOutbox()) await removeDispatch(e.id);
});

// The engine wired to the real web outbox, the way persistence.ts wires it.
function makeStore() {
  const health: boolean[] = [];
  let state: any;
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      stageExpandLeaf: action(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
    }),
    { retryDelays: [], storageWatchdogMs: 50_000 },
  )((next: any) => { state = next; }, () => state, {});
  state = wrapped;
  wrapped._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
  wrapped._setStorageHealth((healthy: boolean) => { health.push(healthy); });
  return { wrapped, health };
}

function captureEnqueueErrors() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.includes("durable enqueue")) lines.push(line);
  };
  return { lines, restore: () => { console.error = original; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(5);
  }
}
const outboxIds = async () => (await loadOutbox()).map((e) => e.id);

describe("dispatch outbox under a transient IndexedDB timeout", () => {
  it("persists the entry when the first write times out and the next succeeds", async () => {
    failOutboxPuts(["TimeoutError"]);
    let error: unknown = null;
    try {
      await enqueueDispatch(entry("t1"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeNull();
    expect(await outboxIds()).toContain("t1");
  });

  it("reports nothing through the store when the timeout is transient", async () => {
    const calls = failOutboxPuts(["TimeoutError"]);
    const errors = captureEnqueueErrors();
    try {
      const { wrapped, health } = makeStore();
      wrapped.stageExpandLeaf("a");
      await waitFor(() => health.length > 0);
      expect(health).toEqual([true]);
      expect(errors.lines).toEqual([]);
      expect(calls.count).toBe(2);
      expect(await outboxIds()).toHaveLength(1);
    } finally {
      errors.restore();
    }
  });

  it("still fails, once and loudly, when every attempt times out", async () => {
    const calls = failOutboxPuts(["TimeoutError", "TimeoutError", "TimeoutError", "TimeoutError"]);
    const errors = captureEnqueueErrors();
    try {
      const { wrapped, health } = makeStore();
      wrapped.stageExpandLeaf("a");
      await waitFor(() => health.length > 0);
      // One first attempt plus OUTBOX_TIMEOUT_RETRIES (2) retries, then give up.
      expect(calls.count).toBe(3);
      expect(health).toEqual([false]);
      expect(errors.lines).toEqual([expect.stringMatching(/durable enqueue for "stageExpandLeaf" failed after \d+ms/)]);
      expect(await outboxIds()).toEqual([]);
    } finally {
      errors.restore();
    }
  });

  for (const name of ["QuotaExceededError", "DataCloneError", "ConstraintError"]) {
    it(`does not retry a ${name}`, async () => {
      const calls = failOutboxPuts([name, name, name]);
      const errors = captureEnqueueErrors();
      try {
        const { wrapped, health } = makeStore();
        wrapped.stageExpandLeaf("a");
        await waitFor(() => health.length > 0);
        await sleep(120); // past two retry delays: a retry would have run by now
        expect(calls.count).toBe(1);
        expect(health).toEqual([false]);
        expect(errors.lines).toHaveLength(1);
      } finally {
        errors.restore();
      }
    });
  }

  it("delivers before the retry finishes and leaves no row once acknowledged", async () => {
    const calls = failOutboxPuts(["TimeoutError", "TimeoutError"]);
    const { wrapped } = makeStore();
    let dispatchedAt = 0;
    wrapped._setDispatch(async () => {
      dispatchedAt = performance.now();
      return {};
    });
    wrapped.stageExpandLeaf("a");
    await waitFor(() => calls.committedAt > 0);
    expect(dispatchedAt).toBeGreaterThan(0);
    expect(dispatchedAt).toBeLessThan(calls.committedAt);
    // The ack retired the row; its late commit must not bring it back.
    await waitFor(async () => (await outboxIds()).length === 0);
    await sleep(20);
    expect(await outboxIds()).toEqual([]);
  });
});
