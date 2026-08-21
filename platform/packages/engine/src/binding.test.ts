import { describe, expect, test } from "bun:test";
import {
  createClientSync,
  SyncOrderError,
  type ClientSyncOptions,
  type DeltaPage,
  type SyncSession,
  type SyncTransport,
} from "./binding";
import type { PlatformCache } from "./idbCache";
import type { PlatformConfig } from "./types";

const CONFIG: PlatformConfig = {
  dbName: "binding-test",
  dbVersion: 1,
  syncRegistry: {},
  registry: {
    account: { persistence: { kind: "meta", key: "account" } },
    threads: {
      persistence: { kind: "collection", key: "threads" },
      hydration: { phase: "deferred" },
      localFirst: true,
    },
  },
};

// A store faking the middleware internals: it records every runtime-binding
// call in order, so tests can assert the boot sequence rather than infer it.
function fakeStore(initial: Record<string, any> = {}) {
  const calls: string[] = [];
  const state: Record<string, any> = {
    account: null,
    threads: {},
    ...initial,
    _setIDBWrite: () => calls.push("setIDBWrite"),
    _setOutbox: () => calls.push("setOutbox"),
    _setStorageHealth: () => {},
    _setDispatch: () => calls.push("setDispatch"),
    _clearDispatch: () => calls.push("clearDispatch"),
    _drainOutbox: () => calls.push("drainOutbox"),
  };
  const applied: Array<Record<string, any>> = [];
  return {
    calls,
    applied,
    state,
    getState: () => state,
    setState: (partial: Record<string, any>) => {
      applied.push(partial);
      calls.push(`setState:${Object.keys(partial).sort().join(",")}`);
      Object.assign(state, partial);
    },
  };
}

function fakeCache(cached: Record<string, any> | null = null) {
  const calls: string[] = [];
  const cache: PlatformCache = {
    writePatchesToIDB: () => {},
    loadCache: async () => {
      calls.push("loadCache");
      return cached;
    },
    setHydrating: (v: boolean) => calls.push(`setHydrating:${v}`),
    loadDetail: async () => null,
    writeDetail: () => {},
    flushDetail: () => {},
    enqueueDispatch: async () => {},
    removeDispatch: async () => {},
    loadOutbox: async () => [],
    purgeLocalCache: async () => {},
  };
  return { cache, calls };
}

type TransportCall = { query: unknown; args: Record<string, unknown> };

// A transport whose subscriptions are hand-fed pages and whose one-shot
// queries resolve from a scripted list.
function fakeTransport(pages: DeltaPage[] = []) {
  const subs: Array<{ query: unknown; args: Record<string, unknown>; push: (p: DeltaPage) => void; open: boolean }> = [];
  const queries: TransportCall[] = [];
  const remaining = [...pages];
  const transport: SyncTransport = {
    subscribe: (query, args, onPage) => {
      const sub = { query, args, push: onPage, open: true };
      subs.push(sub);
      return () => {
        sub.open = false;
      };
    },
    query: async (query, args) => {
      queries.push({ query, args });
      return remaining.shift() ?? { rows: [], hasMore: false };
    },
  };
  return { transport, subs, queries };
}

function makeSync(
  store: ReturnType<typeof fakeStore>,
  cache: PlatformCache,
  extra: Partial<ClientSyncOptions> = {},
) {
  const rows: Array<[string, unknown[]]> = [];
  const events: string[] = [];
  const sync = createClientSync({
    config: CONFIG,
    store,
    cache,
    applyRows: (key, incoming) => {
      rows.push([key, incoming]);
      store.calls.push(`applyRows:${key}`);
    },
    onHydrated: () => {
      events.push("hydrated");
      store.calls.push("onHydrated");
    },
    setOnline: (online) => events.push(`online:${online}`),
    ...extra,
  });
  return { sync, rows, events };
}

function session(transport: SyncTransport, over: Partial<SyncSession> = {}): SyncSession {
  return {
    transport,
    dispatch: async () => null,
    subscriptions: [
      { storeKey: "children", query: "listChildren" },
      { storeKey: "threads", query: "listThreads", scoped: true },
    ],
    baseArgs: { token: "tok" },
    ...over,
  };
}

describe("createClientSync ordering", () => {
  test("connect before hydrate throws SyncOrderError", () => {
    const store = fakeStore();
    const { sync } = makeSync(store, fakeCache().cache);
    const { transport } = fakeTransport();
    expect(() => sync.connect(session(transport))).toThrow(SyncOrderError);
    expect(store.calls).not.toContain("setDispatch");
  });

  test("connect while hydrate is in flight throws", async () => {
    const store = fakeStore();
    const { sync } = makeSync(store, fakeCache({ account: { name: "a" } }).cache);
    const pending = sync.hydrate();
    expect(sync.phase()).toBe("hydrating");
    expect(() => sync.connect(session(fakeTransport().transport))).toThrow(SyncOrderError);
    await pending;
    expect(sync.phase()).toBe("hydrated");
  });

  test("boot sequence: outbox wired, critical then deferred applied, write-through reopened, dispatch bound, then subscribed", async () => {
    const store = fakeStore();
    const { cache, calls: cacheCalls } = fakeCache({
      account: { name: "a" },
      threads: { t1: { _id: "t1" } },
    });
    const { sync } = makeSync(store, cache);
    await sync.hydrate();
    const { transport, subs } = fakeTransport();
    sync.connect(session(transport));

    // account is a critical key, threads is deferred: two setState batches.
    expect(store.calls).toEqual([
      "setIDBWrite",
      "setOutbox",
      "setState:account",
      "setState:threads",
      "onHydrated",
      "setDispatch",
    ]);
    // Write-through reopens only after the deferred apply.
    expect(cacheCalls).toEqual(["setHydrating:true", "loadCache", "setHydrating:false"]);
    // No scope yet: only the unscoped subscription opened.
    expect(subs.map((s) => s.query)).toEqual(["listChildren"]);
    expect(sync.phase()).toBe("connected");
  });

  test("hydrate is idempotent and connect twice throws", async () => {
    const store = fakeStore();
    const { cache, calls } = fakeCache(null);
    const { sync } = makeSync(store, cache);
    const a = sync.hydrate();
    const b = sync.hydrate();
    expect(a).toBe(b);
    await a;
    expect(calls.filter((c) => c === "loadCache")).toHaveLength(1);
    const { transport } = fakeTransport();
    sync.connect(session(transport));
    expect(() => sync.connect(session(transport))).toThrow(SyncOrderError);
    sync.disconnect();
    sync.connect(session(transport));
    expect(sync.phase()).toBe("connected");
  });

  test("a failed cache replay still settles hydrate and unlocks connect", async () => {
    const store = fakeStore();
    const { cache } = fakeCache();
    cache.loadCache = async () => {
      throw new Error("idb gone");
    };
    const errors: unknown[] = [];
    const { sync, events } = makeSync(store, cache, {
      onError: (_ctx, error) => errors.push(error),
    });
    await sync.hydrate();
    expect(events).toContain("hydrated");
    expect(errors).toHaveLength(1);
    sync.connect(session(fakeTransport().transport));
    expect(sync.phase()).toBe("connected");
  });
});

describe("delta subscriptions", () => {
  test("pages loop while hasMore, advancing since each time", async () => {
    const store = fakeStore();
    const { sync, rows } = makeSync(store, fakeCache().cache);
    await sync.hydrate();
    const { transport, subs, queries } = fakeTransport([
      { rows: [{ _id: "r2" }], hasMore: true, nextSince: 9 },
      { rows: [{ _id: "r3" }], hasMore: false },
    ]);
    sync.connect(session(transport));

    subs[0].push({ rows: [{ _id: "r1" }], hasMore: true, nextSince: 5 });
    await new Promise((r) => setTimeout(r, 0));

    expect(rows.map(([key, page]) => [key, (page as any[]).map((r: any) => r._id)])).toEqual([
      ["children", ["r1"]],
      ["children", ["r2"]],
      ["children", ["r3"]],
    ]);
    expect(queries.map((q) => q.args)).toEqual([
      { token: "tok", since: 5 },
      { token: "tok", since: 9 },
    ]);
  });

  test("a watermark that does not advance stops the paging loop", async () => {
    const store = fakeStore();
    const { sync, rows } = makeSync(store, fakeCache().cache);
    await sync.hydrate();
    const { transport, subs, queries } = fakeTransport([
      { rows: [{ _id: "r2" }], hasMore: true, nextSince: 5 },
    ]);
    sync.connect(session(transport));
    subs[0].push({ rows: [{ _id: "r1" }], hasMore: true, nextSince: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(2);
    expect(queries).toHaveLength(1);
  });

  test("scoped subscriptions open on setScope and re-subscribe on scope change", async () => {
    const store = fakeStore();
    const { sync } = makeSync(store, fakeCache().cache);
    await sync.hydrate();
    const { transport, subs } = fakeTransport();
    sync.connect(session(transport));
    expect(subs.filter((s) => s.open).map((s) => s.query)).toEqual(["listChildren"]);

    sync.setScope({ childId: "c1" });
    let open = subs.filter((s) => s.open);
    expect(open.map((s) => s.query).sort()).toEqual(["listChildren", "listThreads"]);
    expect(open.find((s) => s.query === "listThreads")?.args).toEqual({
      token: "tok",
      childId: "c1",
    });

    sync.setScope({ childId: "c2" });
    open = subs.filter((s) => s.open);
    expect(open.find((s) => s.query === "listThreads")?.args).toEqual({
      token: "tok",
      childId: "c2",
    });

    sync.setScope(null);
    expect(subs.filter((s) => s.open).map((s) => s.query)).toEqual(["listChildren"]);
  });

  test("scope set before connect applies at connect", async () => {
    const store = fakeStore();
    const { sync } = makeSync(store, fakeCache().cache);
    sync.setScope({ childId: "c1" });
    await sync.hydrate();
    const { transport, subs } = fakeTransport();
    sync.connect(session(transport));
    expect(subs.map((s) => s.query).sort()).toEqual(["listChildren", "listThreads"]);
  });

  test("rows from a page resolving after disconnect are dropped", async () => {
    const store = fakeStore();
    const { sync, rows } = makeSync(store, fakeCache().cache);
    await sync.hydrate();
    let release: (p: DeltaPage) => void = () => {};
    const { transport, subs } = fakeTransport();
    transport.query = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    sync.connect(session(transport));
    subs[0].push({ rows: [{ _id: "r1" }], hasMore: true, nextSince: 5 });
    sync.disconnect();
    release({ rows: [{ _id: "late" }], hasMore: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(1); // only r1, from before the disconnect
  });

  test("an auth-classified paging failure routes to onAuthExpired", async () => {
    const store = fakeStore();
    const authErrors: unknown[] = [];
    const { sync } = makeSync(store, fakeCache().cache, {
      isAuthError: (e) => e instanceof Error && e.message === "expired",
      onAuthExpired: (e) => authErrors.push(e),
    });
    await sync.hydrate();
    const { transport, subs } = fakeTransport();
    transport.query = async () => {
      throw new Error("expired");
    };
    sync.connect(session(transport));
    subs[0].push({ rows: [], hasMore: true, nextSince: 5 });
    await new Promise((r) => setTimeout(r, 0));
    expect(authErrors).toHaveLength(1);
  });
});

describe("refresh and disconnect", () => {
  test("refresh publishes online state and drains the outbox only while online", async () => {
    const store = fakeStore();
    let online = true;
    const { sync, events } = makeSync(store, fakeCache().cache, { isOnline: () => online });
    await sync.hydrate();
    sync.refresh();
    expect(events).toContain("online:true");
    expect(store.calls.filter((c) => c === "drainOutbox")).toHaveLength(1);
    online = false;
    sync.refresh();
    expect(events).toContain("online:false");
    expect(store.calls.filter((c) => c === "drainOutbox")).toHaveLength(1);
  });

  test("disconnect closes subscriptions and unbinds dispatch", async () => {
    const store = fakeStore();
    const { sync } = makeSync(store, fakeCache().cache);
    await sync.hydrate();
    const { transport, subs } = fakeTransport();
    sync.connect(session(transport));
    sync.setScope({ childId: "c1" });
    sync.disconnect();
    expect(subs.every((s) => !s.open)).toBe(true);
    expect(store.calls).toContain("clearDispatch");
    expect(sync.phase()).toBe("hydrated");
    // Disconnecting again is a no-op, not an error.
    sync.disconnect();
  });
});
