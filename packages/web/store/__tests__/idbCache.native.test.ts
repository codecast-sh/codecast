import { beforeEach, describe, expect, it, mock } from "bun:test";

// jsdom/node has no native expo-sqlite, so back the kv-store with an in-memory
// AsyncStorage-compatible shim that mirrors the methods idbCache.native uses.
const kv = new Map<string, string>();
mock.module("expo-sqlite/kv-store", () => {
  const Storage = {
    async getItem(key: string): Promise<string | null> {
      return kv.has(key) ? (kv.get(key) as string) : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      kv.set(key, value);
    },
    async removeItem(key: string): Promise<void> {
      kv.delete(key);
    },
    async multiGet(keys: string[]): Promise<[string, string | null][]> {
      return keys.map((k) => [k, kv.has(k) ? (kv.get(k) as string) : null]);
    },
  };
  return { __esModule: true, default: Storage, Storage, AsyncStorage: Storage };
});

const {
  writePatchesToIDB,
  loadCache,
  enqueueDispatch,
  loadOutbox,
  setHydrating,
  isPersistedStoreKey,
  PERSISTENCE_AVAILABLE,
} = await import("../idbCache.native");

describe("idbCache.native", () => {
  beforeEach(() => {
    kv.clear();
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
    await Promise.resolve();

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
    await Promise.resolve();

    const cached = await loadCache();
    expect(cached!.clientState).toEqual({ current_conversation_id: "conv1", tips: { seen: ["x"] } });
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadCache()).toBeNull();
  });

  it("no-ops writes while hydrating", async () => {
    setHydrating(true);
    writePatchesToIDB([{ op: "replace", path: ["sessions", "a"], value: {} } as any], {
      sessions: { a: { _id: "a" } },
    });
    await Promise.resolve();
    expect(await loadCache()).toBeNull();
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
