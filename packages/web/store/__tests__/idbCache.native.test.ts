import { beforeEach, describe, expect, it } from "bun:test";

// jsdom/node has no native expo-sqlite, so back the kv-store with an in-memory
// AsyncStorage-compatible shim that mirrors the methods idbCache.native uses.
// NOT via mock.module: the module acquires the store through a guarded
// require() (deliberate — see the OTA-skew comment in idbCache.native.ts), and
// bun's mock.module intercepts only the ESM import path, so the mock never
// attached — the require threw, the guard nulled Storage, and every test read
// empty. The module's catch-path instead picks up this global, set BEFORE the
// import below so the eval-time PERSISTENCE_AVAILABLE const sees it.
const kv = new Map<string, string>();
// Every setItem lands here; a test can hold the gate to simulate a slow disk.
const setItemCalls: string[] = [];
let setItemGate: Promise<void> = Promise.resolve();
(globalThis as any).__CODECAST_TEST_KV_STORAGE__ = {
  async getItem(key: string): Promise<string | null> {
    return kv.has(key) ? (kv.get(key) as string) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    setItemCalls.push(key);
    await setItemGate;
    kv.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    kv.delete(key);
  },
  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    return keys.map((k) => [k, kv.has(k) ? (kv.get(k) as string) : null]);
  },
};

const {
  writePatchesToIDB,
  loadCache,
  enqueueDispatch,
  loadOutbox,
  setHydrating,
  isPersistedStoreKey,
  PERSISTENCE_AVAILABLE,
  _resetPersistedShadow,
  flushPersistence,
} = await import("../idbCache.native");

describe("idbCache.native", () => {
  beforeEach(() => {
    kv.clear();
    // The persistence shadow lives at module scope; reset it so a prior test's
    // writes don't make this test's diff think nothing changed.
    _resetPersistedShadow();
    setHydrating(false);
  });

  it("reports persistence available on native", () => {
    expect(PERSISTENCE_AVAILABLE).toBe(true);
  });

  it("matches the web persisted-key whitelist", () => {
    expect(isPersistedStoreKey("sessions")).toBe(true);
    expect(isPersistedStoreKey("clientState")).toBe(true);
    expect(isPersistedStoreKey("messages")).toBe(false);
    expect(isPersistedStoreKey("nope")).toBe(false);
  });

  it("round-trips a collection as an {_id: row} map", async () => {
    const state = {
      sessions: {
        a: { _id: "a", title: "Alpha" },
        b: { _id: "b", title: "Beta" },
      },
    };
    writePatchesToIDB([{ op: "replace", path: ["sessions", "a"], value: {} } as any], state);
    // setItem is async/non-blocking; let the microtask flush.
    await flushPersistence();

    const cached = await loadCache();
    expect(cached).not.toBeNull();
    expect(cached!.sessions).toEqual({
      a: { _id: "a", title: "Alpha" },
      b: { _id: "b", title: "Beta" },
    });
  });

  it("round-trips a meta blob", async () => {
    const state = { clientState: { current_conversation_id: "conv1", tips: { seen: ["x"] } } };
    writePatchesToIDB([{ op: "replace", path: ["clientState", "tips"], value: {} } as any], state);
    await flushPersistence();

    const cached = await loadCache();
    expect(cached!.clientState).toEqual({ current_conversation_id: "conv1", tips: { seen: ["x"] } });
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadCache()).toBeNull();
  });

  it("drops conversation-as-task poison rows at hydration", async () => {
    // Legacy bug: a conversation stored under tasks by the table-blind
    // webGetTaskDetail. It must not hydrate into the store (it renders as a
    // phantom task that 404s when opened) and must not re-enter the shadow.
    const real = { _id: "mh7real", short_id: "ct-100", title: "Real task" };
    const poison = { _id: "jx7conv", short_id: "jx7conv", title: "Some session", message_count: 744 };
    kv.set("col:tasks", JSON.stringify([real, poison]));

    const cached = await loadCache();
    expect(cached!.tasks).toEqual({ mh7real: real });

    // The healed shadow means the next write rewrites the blob without the
    // poison row — disk heals too.
    writePatchesToIDB(
      [{ op: "replace", path: ["tasks", "mh7real"], value: {} } as any],
      { tasks: { mh7real: { ...real, title: "Renamed" } } },
    );
    await flushPersistence();
    const onDisk = JSON.parse(kv.get("col:tasks")!) as any[];
    expect(onDisk.map((r) => r._id)).toEqual(["mh7real"]);
  });

  it("skips the rewrite when a sync changed nothing", async () => {
    const a = { _id: "a", title: "Alpha" };
    const state = { sessions: { a } };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], state);
    await flushPersistence();
    expect(kv.has("col:sessions")).toBe(true);

    // Same row reference re-pushed (the live-query churn case). Clear storage and
    // observe the storage key directly — loadCache would re-seed the shadow, so
    // assert on the raw blob: if the diff correctly skips, the key is never set.
    kv.clear();
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], state);
    await flushPersistence();
    expect(kv.has("col:sessions")).toBe(false);
  });

  it("NEVER clears the cache from a store-shrink — a row missing without an exclude is kept", async () => {
    // Convex-shaped ids: the keep-on-shrink guarantee is for SERVER rows. A
    // non-Convex id is a client-minted stub, and those DO delete (next test).
    // Freshly stamped so hydration retention (tested below) keeps them.
    const a = { _id: "k97aaaaaaaaaaaaaaaaaaaaaaaaaaaa1", title: "Alpha", updated_at: Date.now() };
    const b = { _id: "k97bbbbbbbbbbbbbbbbbbbbbbbbbbbb2", title: "Beta", updated_at: Date.now() };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], { sessions: { [a._id]: a, [b._id]: b } });
    await flushPersistence();
    expect((await loadCache())!.sessions).toEqual({ [a._id]: a, [b._id]: b });

    // b vanished from the store with NO exclude (an incomplete store / a bug, not
    // a deletion) → it MUST survive on disk so the durable cache is never wiped.
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], { sessions: { [a._id]: a } });
    await flushPersistence();
    expect((await loadCache())!.sessions).toEqual({ [a._id]: a, [b._id]: b });
  });

  it("a client-minted stub DOES delete on removal — supersede must reach disk", async () => {
    // The chat-transcript twin bug: the altKey supersede removed the stub from
    // the store, this engine kept it on disk, and the next boot resurrected it
    // beside its server twin — every message you sent rendered twice.
    const server = { _id: "k97cccccccccccccccccccccccccccc3", client_id: "chatmsgstub-x1", content: "hi", updated_at: Date.now() };
    const stub = { _id: "chatmsgstub-x1", client_id: "chatmsgstub-x1", content: "hi" };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], { sessions: { [stub._id]: stub, [server._id]: server } });
    await flushPersistence();
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], { sessions: { [server._id]: server } });
    await flushPersistence();
    expect((await loadCache())!.sessions).toEqual({ [server._id]: server });
  });

  it("removes a row ONLY when it was explicitly excluded (kill/archive)", async () => {
    const a = { _id: "a", title: "Alpha" };
    const b = { _id: "b", title: "Beta" };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], { sessions: { a, b } });
    await flushPersistence();

    // b is intentionally removed: gone from the store AND carrying a pending
    // exclude → drop it from disk too.
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: {} } as any], {
      sessions: { a },
      pending: { "sessions:b": { type: "exclude" } },
    });
    await flushPersistence();
    expect((await loadCache())!.sessions).toEqual({ a });
  });

  it("no-ops writes while hydrating", async () => {
    setHydrating(true);
    writePatchesToIDB([{ op: "replace", path: ["sessions", "a"], value: {} } as any], {
      sessions: { a: { _id: "a" } },
    });
    await flushPersistence();
    expect(await loadCache()).toBeNull();
  });

  it("prunes sessions beyond the TTL and cap at load — and the prune reaches disk", async () => {
    // The web engine sheds months of on-disk accumulation at boot
    // (cacheRetention.ts); the native engine now applies the same policy.
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cid = (n: number) => `k${String(n).padStart(31, "0")}`;
    const fresh = { _id: cid(1), updated_at: now - 5 * DAY };
    const stale = { _id: cid(2), updated_at: now - 45 * DAY };
    const pinnedStale = { _id: cid(3), updated_at: now - 45 * DAY, is_pinned: true };
    const liveStale = { _id: cid(4), updated_at: now - 45 * DAY };
    const focusedStale = { _id: cid(5), updated_at: now - 45 * DAY };
    kv.set("col:sessions", JSON.stringify([fresh, stale, pinnedStale, liveStale, focusedStale]));
    kv.set("meta:liveInboxIdList", JSON.stringify([cid(4)]));
    kv.set("meta:lastFocusedConversationId", JSON.stringify(cid(5)));

    const cached = await loadCache();
    expect(Object.keys(cached!.sessions).sort()).toEqual([cid(1), cid(3), cid(4), cid(5)].sort());
    // The pruned blob was persisted back — the stale row is gone from disk too.
    await flushPersistence();
    const onDisk = JSON.parse(kv.get("col:sessions")!) as any[];
    expect(onDisk.map((r) => r._id).sort()).toEqual([cid(1), cid(3), cid(4), cid(5)].sort());
  });

  it("caps windowed sessions at the newest MAX_CACHED_SESSIONS on load", async () => {
    const now = Date.now();
    const cid = (n: number) => `k${String(n).padStart(31, "0")}`;
    const rows = [];
    for (let i = 0; i < 1300; i++) rows.push({ _id: cid(i), updated_at: now - i * 1000 });
    kv.set("col:sessions", JSON.stringify(rows));

    const cached = await loadCache();
    const ids = Object.keys(cached!.sessions);
    expect(ids.length).toBe(1200);
    expect(ids).toContain(cid(0)); // newest survives
    expect(ids).not.toContain(cid(1299)); // oldest of the windowed set dropped
  });

  it("prunes the conversations meta blob with the same retention policy", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cid = (n: number) => `k${String(n).padStart(31, "0")}`;
    kv.set("meta:conversations", JSON.stringify({
      [cid(1)]: { _id: cid(1), updated_at: now - 5 * DAY },
      [cid(2)]: { _id: cid(2), updated_at: now - 45 * DAY },
    }));

    const cached = await loadCache();
    expect(Object.keys(cached!.conversations)).toEqual([cid(1)]);
  });

  it("drops expired exclude tombstones at load, keeps recent ones and stamps legacy ones", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    kv.set("meta:pending", JSON.stringify({
      "sessions:old": { type: "exclude", ts: now - 45 * DAY },
      "sessions:new": { type: "exclude", ts: now - 5 * DAY },
      "sessions:legacy": { type: "exclude" },
      "sessions:edit:title": { type: "field", value: "x", ts: now - 400 * DAY },
    }));

    const cached = await loadCache();
    expect(Object.keys(cached!.pending).sort()).toEqual(
      ["sessions:new", "sessions:legacy", "sessions:edit:title"].sort(),
    );
    expect(cached!.pending["sessions:legacy"].ts).toBeGreaterThan(0);
  });

  it("loads the outbox sorted ascending by ts regardless of enqueue order", async () => {
    // Fire concurrently (no awaits between) to exercise the serialized
    // read-modify-write — every entry must survive, then sort by ts on load.
    enqueueDispatch({ id: "3", action: "x", args: {}, patches: {}, result: null, ts: 300 });
    enqueueDispatch({ id: "1", action: "x", args: {}, patches: {}, result: null, ts: 100 });
    enqueueDispatch({ id: "2", action: "x", args: {}, patches: {}, result: null, ts: 200 });

    const outbox = await loadOutbox();
    expect(outbox.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });
});
