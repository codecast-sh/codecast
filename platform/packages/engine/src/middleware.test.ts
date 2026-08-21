import { describe, expect, it } from "bun:test";
import {
  action,
  asyncAction,
  DispatchNotWiredError,
  groupPatchesByTable,
  isPermanentDispatchError,
  makeIsMustDeliverEntry,
  makeOutboxFailureDisposition,
  mutativeMiddleware,
  MAX_OUTBOX_BOOT_ATTEMPTS,
  receiptAsyncAction,
  sync,
  defaultIsServerId,
} from "./middleware";
import { deriveRegistryMaps } from "./registry";
import type { OutboxEntry, PlatformConfig } from "./types";

const SERVER_ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);

const CONFIG: PlatformConfig = {
  dbName: "test",
  dbVersion: 1,
  registry: {
    items: {
      persistence: { kind: "collection", key: "items" },
      localFirst: true,
      dispatchTable: { table: "item_rows", kind: "collection" },
    },
    // A projection of another table: only a few fields are real server state.
    cards: {
      persistence: { kind: "collection", key: "cards" },
      localFirst: true,
      dispatchTable: { table: "item_rows", kind: "collection", fields: ["title"] },
    },
    prefs: {
      persistence: { kind: "meta", key: "prefs" },
      dispatchTable: { table: "client_prefs", kind: "singleton" },
    },
    activeId: {
      persistence: { kind: "meta", key: "activeId" },
      dispatchFieldTable: "client_prefs",
    },
    pending: { persistence: { kind: "meta", key: "pending" } },
  },
  syncRegistry: {},
  mustDeliverActions: new Set(["sendNote"]),
  outboxCoalesceKeys: {
    setLayout: (args) => (typeof args[0] === "string" ? `setLayout:${args[0]}` : null),
  },
  hideAckFields: new Set(["hidden_at"]),
};

const MAPS = deriveRegistryMaps(CONFIG.registry);
const GROUP_CTX = {
  tableMap: MAPS.dispatchTableMap,
  fieldToTable: MAPS.dispatchFieldTableMap,
  isServerId: defaultIsServerId,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

function makeHarness(opts?: { config?: PlatformConfig; retryDelays?: number[] }) {
  const outbox = new Map<string, OutboxEntry>();
  const dispatched: Array<{
    action: string;
    args: any;
    patches: any;
    result: any;
    commandId?: string;
  }> = [];
  const enqueueGate: Array<() => void> = [];
  let holdEnqueue = false;
  let state: any;
  const set = (next: any) => { state = next; };
  const get = () => state;
  const api = { setState: (partial: any) => { state = { ...state, ...partial }; } };

  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      cards: {} as Record<string, any>,
      prefs: {} as Record<string, any>,
      activeId: null as string | null,
      pending: {} as Record<string, any>,
      rolledBack: [] as string[],
      poke: action(function (this: any, id: string, title = "t") {
        this.items[id] = { _id: id, title };
      }),
      rename: action(function (this: any, id: string, title: string) {
        this.items[id].title = title;
      }),
      hide: action(function (this: any, id: string, at: number) {
        this.items[id].hidden_at = at;
        this.items[id].is_hidden = true;
      }),
      drop: action(function (this: any, id: string) {
        delete this.items[id];
      }),
      setLayout: action(function (this: any, key: string, value: string) {
        this.prefs[key] = value;
      }),
      sendNote: asyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id, title: "note" };
      }),
      pokeAsync: asyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
      }),
      createThing: receiptAsyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id };
        return { stubId: id };
      }),
      localOnly: sync(function (this: any, id: string) {
        this.items[id] = { _id: id, local: true };
      }),
      _handleReceiptRejection: sync(function (this: any, _action: string, localResult: any) {
        this.rolledBack.push(localResult?.stubId);
        delete this.items[localResult?.stubId];
        return ["items"];
      }),
    }),
    opts?.config ?? CONFIG,
    { retryDelays: opts?.retryDelays ?? [], storageWatchdogMs: 50_000 },
  )(set, get, api);
  state = wrapped;

  wrapped._setOutbox(
    async (entry: OutboxEntry) => {
      if (holdEnqueue) await new Promise<void>((resolve) => enqueueGate.push(resolve));
      outbox.set(entry.id, entry);
    },
    async (id: string) => { outbox.delete(id); },
    async () => [...outbox.values()].sort((a, b) => a.ts - b.ts),
  );

  return {
    wrapped,
    outbox,
    dispatched,
    get state() { return state; },
    holdEnqueue: (v: boolean) => { holdEnqueue = v; },
    releaseEnqueues: () => { while (enqueueGate.length) enqueueGate.shift()!(); },
    wireDispatch(
      fn: (action: string, args: any, patches: any, result: any, commandId?: string) => Promise<any>,
    ) {
      wrapped._setDispatch(
        async (a: string, args: any, patches: any, result: any, commandId?: string) => {
          dispatched.push({ action: a, args, patches, result, commandId });
          return fn(a, args, patches, result, commandId);
        },
      );
    },
  };
}

describe("groupPatchesByTable", () => {
  it("maps a collection field write onto its server table", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["items", SERVER_ID, "title"], value: "hi" } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped).toEqual({ item_rows: { [SERVER_ID]: { title: "hi" } } });
  });

  it("rebuilds a nested path under its field", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["items", SERVER_ID, "meta", "flags", "starred"], value: true } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped.item_rows[SERVER_ID].meta).toEqual({ flags: { starred: true } });
  });

  it("turns a cleared field into an explicit null tombstone", () => {
    const grouped = groupPatchesByTable(
      [{ op: "remove", path: ["items", SERVER_ID, "title"] } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped.item_rows[SERVER_ID].title).toBeNull();
  });

  it("skips stub ids the server cannot act on", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["items", "stub-1", "title"], value: "hi" } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped).toEqual({ item_rows: {} });
  });

  it("drops fields outside a projection's allowlist", () => {
    const grouped = groupPatchesByTable(
      [
        { op: "replace", path: ["cards", SERVER_ID, "title"], value: "keep" } as any,
        { op: "replace", path: ["cards", SERVER_ID, "derived_badge"], value: "drop" } as any,
      ],
      {},
      GROUP_CTX,
    );
    expect(grouped.item_rows[SERVER_ID]).toEqual({ title: "keep" });
  });

  it("writes a singleton table under its single key", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["prefs", "theme"], value: "dark" } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped).toEqual({ client_prefs: { _: { theme: "dark" } } });
  });

  it("sends the whole current value for a field-mapped store key", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["activeId"], value: "t2" } as any],
      { activeId: "t2" },
      GROUP_CTX,
    );
    expect(grouped).toEqual({ client_prefs: { _: { activeId: "t2" } } });
  });

  it("ignores store keys with no dispatch mapping", () => {
    const grouped = groupPatchesByTable(
      [{ op: "replace", path: ["scratch", "x"], value: 1 } as any],
      {},
      GROUP_CTX,
    );
    expect(grouped).toEqual({});
  });
});

describe("auto-generated pending protection", () => {
  it("plants include, field and exclude entries from an action's patches", () => {
    const h = makeHarness();
    h.wrapped.poke(SERVER_ID);
    expect(h.state.pending[`items:${SERVER_ID}`]).toMatchObject({ type: "include" });

    h.wrapped.rename(SERVER_ID, "renamed");
    expect(h.state.pending[`items:${SERVER_ID}:title`]).toMatchObject({ type: "field", value: "renamed" });

    h.wrapped.drop(SERVER_ID);
    expect(h.state.pending[`items:${SERVER_ID}`]).toMatchObject({ type: "exclude" });
  });

  it("stamps the exact acknowledgement value onto sibling fields of a hide", () => {
    const h = makeHarness();
    h.wrapped.poke(SERVER_ID);
    h.wrapped.hide(SERVER_ID, 1234);
    expect(h.state.pending[`items:${SERVER_ID}:is_hidden`].hideAck).toBe(1234);
  });

  it("leaves sync() writes unprotected and undispatched", async () => {
    const h = makeHarness();
    h.wireDispatch(async () => ({}));
    h.wrapped.localOnly(SERVER_ID);
    await sleep(5);
    expect(h.state.pending[`items:${SERVER_ID}`]).toBeUndefined();
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("outbox", () => {
  it("dispatches without waiting for the durable enqueue to commit", async () => {
    const h = makeHarness();
    h.wireDispatch(async () => ({}));
    h.holdEnqueue(true);

    h.wrapped.poke(SERVER_ID);

    await waitFor(() => h.dispatched.length === 1);
    // The row is still uncommitted — delivery never gates on storage.
    expect(h.outbox.size).toBe(0);
    h.releaseEnqueues();
    await waitFor(() => h.outbox.size === 0);
  });

  it("retires a row whose acknowledgement beat its own commit", async () => {
    const h = makeHarness();
    h.wireDispatch(async () => ({}));
    h.holdEnqueue(true);

    h.wrapped.poke(SERVER_ID);
    await waitFor(() => h.dispatched.length === 1);
    // Acknowledged first, committed second: the delete waits for the commit.
    h.releaseEnqueues();
    await waitFor(() => h.outbox.size === 0);
  });

  it("keeps at most one row per coalesce key", async () => {
    const h = makeHarness();
    h.wrapped.setLayout("main", "a");
    h.wrapped.setLayout("main", "b");
    h.wrapped.setLayout("side", "c");

    await waitFor(() => [...h.outbox.values()].length === 2);
    const keys = [...h.outbox.values()].map((e) => e.coalesceKey).sort();
    expect(keys).toEqual(["setLayout:main", "setLayout:side"]);
    expect([...h.outbox.values()].find((e) => e.coalesceKey === "setLayout:main")!.args)
      .toEqual(["main", "b"]);
  });

  it("coalesces rows left by earlier page loads at drain time", async () => {
    const h = makeHarness();
    const now = Date.now();
    h.outbox.set("old", {
      id: "old", action: "setLayout", args: ["main", "a"], patches: {}, result: null,
      ts: now - 2, coalesceKey: "setLayout:main",
    });
    h.outbox.set("new", {
      id: "new", action: "setLayout", args: ["main", "b"], patches: {}, result: null,
      ts: now - 1, coalesceKey: "setLayout:main",
    });

    h.wireDispatch(async () => ({}));
    await waitFor(() => h.outbox.size === 0);
    expect(h.dispatched.map((d) => d.args)).toEqual([["main", "b"]]);
  });

  it("counts a boot attempt per failed replay and gives up at the cap", async () => {
    const h = makeHarness();
    h.outbox.set("e1", {
      id: "e1", action: "poke", args: [SERVER_ID], patches: {}, result: null,
      ts: Date.now(), attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 2,
    });
    h.wireDispatch(async () => { throw new Error("network down"); });

    await waitFor(() => (h.outbox.get("e1")?.attempts ?? 0) === MAX_OUTBOX_BOOT_ATTEMPTS - 1);
    // One more boot: the entry hits the cap and is dropped.
    h.wrapped._setDispatch(null);
    h.wireDispatch(async () => { throw new Error("network down"); });
    await waitFor(() => h.outbox.size === 0);
  });

  it("never counts an attempt on an opportunistic re-drive", async () => {
    const h = makeHarness();
    h.outbox.set("e1", {
      id: "e1", action: "poke", args: [SERVER_ID], patches: {}, result: null, ts: Date.now(), attempts: 2,
    });
    h.wrapped._setDispatch(async () => { throw new Error("network down"); });
    await sleep(20);
    h.wrapped._drainOutbox();
    await sleep(20);
    // The boot drain counted exactly one; the opportunistic pass counted none.
    expect(h.outbox.get("e1")!.attempts).toBe(3);
  });

  it("never drops a must-deliver write, however many boots fail", async () => {
    const h = makeHarness();
    h.outbox.set("e1", {
      id: "e1", action: "sendNote", args: [SERVER_ID], patches: {}, result: null,
      ts: Date.now(), attempts: MAX_OUTBOX_BOOT_ATTEMPTS + 3,
    });
    h.wireDispatch(async () => { throw new Error("network down"); });

    await waitFor(() => (h.outbox.get("e1")?.attempts ?? 0) === MAX_OUTBOX_BOOT_ATTEMPTS + 4);
    expect(h.outbox.has("e1")).toBe(true);
  });

  it("removes a row the server permanently refused", async () => {
    const h = makeHarness();
    h.outbox.set("e1", {
      id: "e1", action: "poke", args: [SERVER_ID], patches: {}, result: null, ts: Date.now(),
    });
    h.wireDispatch(async () => { throw new Error("Uncaught Error: nope"); });

    await waitFor(() => h.outbox.size === 0);
  });

  it("parks an unwired write and rejects its caller as parked", async () => {
    const h = makeHarness();
    let error: unknown;
    await h.wrapped.pokeAsync(SERVER_ID).catch((e: unknown) => { error = e; });
    expect(error).toBeInstanceOf(DispatchNotWiredError);
    expect((error as DispatchNotWiredError).parked).toBe(true);
    expect(h.outbox.size).toBe(1);
  });

  it("keeps a receipt command pending until its parked row drains", async () => {
    const h = makeHarness();
    const pending = h.wrapped.createThing("stub-1");
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });

    await waitFor(() => h.outbox.size === 1);
    expect(settled).toBe(false);

    const entry = [...h.outbox.values()][0];
    h.wireDispatch(async (_a, _args, _patches, result: any) => ({
      commandId: result.commandId,
      status: "acknowledged",
      result: { _id: SERVER_ID },
    }));

    await expect(pending).resolves.toEqual({ _id: SERVER_ID });
    expect(entry.result.commandId).toBeDefined();
    await waitFor(() => h.outbox.size === 0);
  });

  it("hands the command id to the dispatch function as its own argument", async () => {
    const h = makeHarness();
    h.wireDispatch(async (_a, _args, _patches, result: any) => ({
      commandId: result.commandId,
      status: "acknowledged",
      result: { _id: SERVER_ID },
    }));

    await h.wrapped.createThing("stub-1");

    const sent = h.dispatched[0]!;
    expect(sent.commandId).toBe(sent.result.commandId);
    expect(sent.commandId).toBeTruthy();
  });

  it("sends no command id for an action that carries no receipt", async () => {
    const h = makeHarness();
    h.wireDispatch(async () => ({}));

    await h.wrapped.pokeAsync(SERVER_ID);

    expect(h.dispatched[0]!.commandId).toBeUndefined();
  });

  it("replays a parked receipt row under its original command id", async () => {
    const h = makeHarness();
    const commandId = "outbox-1";
    h.outbox.set(commandId, {
      id: commandId,
      action: "createThing",
      args: ["stub-1"],
      patches: {},
      result: { receiptActionVersion: 1, commandId, localResult: { stubId: "stub-1" } },
      ts: Date.now(),
    });
    h.wireDispatch(async (_a, _args, _patches, result: any) => ({
      commandId: result.commandId,
      status: "acknowledged",
      result: { _id: SERVER_ID },
    }));

    await waitFor(() => h.dispatched.length === 1);
    expect(h.dispatched[0]!.commandId).toBe(commandId);
  });

  it("rolls the optimistic row back when the server rejects the command", async () => {
    const h = makeHarness();
    h.wireDispatch(async (_a, _args, _patches, result: any) => ({
      commandId: result.commandId,
      status: "rejected",
      rejection: { code: "forbidden", message: "no" },
    }));

    await expect(h.wrapped.createThing("stub-1")).rejects.toThrow("no");
    expect(h.state.rolledBack).toEqual(["stub-1"]);
    expect(h.state.items["stub-1"]).toBeUndefined();
    await waitFor(() => h.outbox.size === 0);
  });

  it("reports the durable queue as drained only once it is verified empty", async () => {
    const h = makeHarness();
    expect(h.wrapped._hasBootOutboxDrained()).toBe(false);
    h.wireDispatch(async () => ({}));
    await waitFor(() => h.wrapped._hasBootOutboxDrained() === true);
  });
});

describe("dispatch error classification", () => {
  it("treats a thrown backend function or bad args as permanent", () => {
    expect(isPermanentDispatchError(new Error("Uncaught Error: boom"))).toBe(true);
    expect(isPermanentDispatchError(new Error("ArgumentValidationError: bad"))).toBe(true);
    expect(isPermanentDispatchError(new Error("Could not find public function"))).toBe(true);
  });

  it("treats overload and timeouts as retryable", () => {
    expect(isPermanentDispatchError(new Error("Your request timed out"))).toBe(false);
    expect(isPermanentDispatchError(new Error("Try again later"))).toBe(false);
  });
});

describe("outbox failure disposition", () => {
  const isMustDeliver = makeIsMustDeliverEntry(new Set(["sendNote"]));
  const disposition = makeOutboxFailureDisposition(isMustDeliver);
  const entry = (over: Partial<OutboxEntry>): OutboxEntry => ({
    id: "e", action: "poke", args: [], patches: {}, result: null, ts: 1, ...over,
  });

  it("counts the attempt and keeps the row below the cap", () => {
    const d = disposition(entry({ attempts: 1 }));
    expect(d).toEqual({ keep: true, entry: expect.objectContaining({ attempts: 2 }) } as any);
  });

  it("gives up at the cap", () => {
    expect(disposition(entry({ attempts: MAX_OUTBOX_BOOT_ATTEMPTS - 1 })).keep).toBe(false);
  });

  it("keeps must-deliver and receipt-backed rows forever", () => {
    expect(disposition(entry({ action: "sendNote", attempts: 99 })).keep).toBe(true);
    expect(disposition(entry({
      attempts: 99,
      result: { receiptActionVersion: 1, commandId: "c1" },
    })).keep).toBe(true);
  });
});

describe("view guard", () => {
  const guardedConfig: PlatformConfig = {
    ...CONFIG,
    viewGuard: {
      fields: ["currentId"],
      // Only a declared write may move the view; clearing is always allowed.
      audit: (changes) => changes.filter((c) => c.to != null && !declared).map((c) => c.field),
    },
  };
  let declared = false;

  function guardedHarness() {
    let state: any;
    const set = (next: any) => { state = next; };
    const get = () => state;
    const api = { setState: (partial: any) => { state = { ...state, ...partial }; } };
    const wrapped = mutativeMiddleware(
      () => ({
        items: {} as Record<string, any>,
        pending: {} as Record<string, any>,
        currentId: null as string | null,
        select: action(function (this: any, id: string | null) { this.currentId = id; }),
      }),
      guardedConfig,
      { retryDelays: [] },
    )(set, get, api);
    state = wrapped;
    return { wrapped, get state() { return state; }, api };
  }

  it("reverts an undeclared view change and applies a declared one", () => {
    const h = guardedHarness();
    declared = false;
    h.wrapped.select(SERVER_ID);
    expect(h.state.currentId).toBeNull();

    declared = true;
    h.wrapped.select(SERVER_ID);
    expect(h.state.currentId).toBe(SERVER_ID);

    // Clearing needs no declaration — it cannot teleport anyone.
    declared = false;
    h.wrapped.select(null);
    expect(h.state.currentId).toBeNull();
  });

  it("polices raw setState the same way", () => {
    const h = guardedHarness();
    declared = false;
    h.api.setState({ currentId: OTHER_ID, items: {} });
    expect(h.state.currentId).toBeNull();
  });
});
