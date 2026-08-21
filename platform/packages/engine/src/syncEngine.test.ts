import { describe, expect, it } from "bun:test";
import { applyMerge, createSyncEngine, rekeyPending } from "./syncEngine";
import type { PlatformConfig, SyncOpts } from "./types";

// The engine recipes sit between an incoming payload and the store draft. Their
// job is to land server truth without losing a local write, without churning
// object identity, and without stranding a stub row once its real server row
// arrives.

const SERVER_ID = "a".repeat(32);
const OTHER_SERVER_ID = "b".repeat(32);

function makeConfig(syncRegistry: Record<string, SyncOpts> = {}, extra: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    dbName: "test",
    dbVersion: 1,
    registry: {
      items: { persistence: { kind: "collection", key: "items" }, localFirst: true },
    },
    syncRegistry,
    ...extra,
  };
}

const draftOf = (over: Record<string, any> = {}): Record<string, any> => ({ items: {}, pending: {}, ...over });

describe("collection recipe", () => {
  it("skips the draft write when the push changed nothing", () => {
    const engine = createSyncEngine(makeConfig());
    const items = { [SERVER_ID]: { _id: SERVER_ID, updated_at: 1 } };
    const pending = {};
    const draft = draftOf({ items, pending });

    engine.syncTable(draft, "items", [{ _id: SERVER_ID, updated_at: 1 }]);

    expect(draft.items).toBe(items);
    expect(draft.pending).toBe(pending);
  });

  it("short-circuits on the updated_at check before touching the draft", () => {
    const engine = createSyncEngine(makeConfig());
    const items = { [SERVER_ID]: { _id: SERVER_ID, updated_at: 5, title: "old" } };
    const draft = draftOf({ items });

    // Same key set, same updated_at — a payload whose other fields differ is
    // still treated as a no-op by the cheap pre-check.
    engine.syncTable(draft, "items", [{ _id: SERVER_ID, updated_at: 5, title: "new" }]);
    expect(draft.items).toBe(items);
  });

  it("keeps the selected row when the payload no longer carries it", () => {
    const engine = createSyncEngine(makeConfig({ items: { keepSelected: "currentId" } }));
    const prevRow = { _id: SERVER_ID, updated_at: 1 };
    const draft = draftOf({ items: { [SERVER_ID]: prevRow }, currentId: SERVER_ID });

    engine.syncTable(draft, "items", [{ _id: OTHER_SERVER_ID, updated_at: 1 }]);

    expect(draft.items[SERVER_ID]).toBe(prevRow);
    expect(draft.items[OTHER_SERVER_ID]).toBeDefined();
  });

  it("merges per-call opts over the registered ones", () => {
    const engine = createSyncEngine(makeConfig({ items: { isDelta: true } }));
    const draft = draftOf({ items: { [SERVER_ID]: { _id: SERVER_ID, updated_at: 1 } } });

    engine.syncTable(draft, "items", [{ _id: OTHER_SERVER_ID, updated_at: 1 }], { isDelta: false });

    expect(draft.items[SERVER_ID]).toBeUndefined();
  });
});

describe("altKey stub supersede", () => {
  const config = makeConfig({ items: { isDelta: true, altKey: "client_id" } });

  it("rekeys the stub onto the server row, carrying pending and field overrides", () => {
    const rekeyed: Array<[string, string]> = [];
    const engine = createSyncEngine(
      makeConfig({ items: { isDelta: true, altKey: "client_id" } }, {
        rekeyExtra: (_draft, oldId, newId) => { rekeyed.push([oldId, newId]); },
      }),
    );
    const draft = draftOf({
      items: { "stub-1": { _id: "stub-1", client_id: "stub-1", title: "typed locally" } },
      pending: {
        "items:stub-1": { type: "include", ts: 1 },
        "items:stub-1:title": { type: "field", value: "typed locally", ts: 1 },
      },
    });

    engine.syncTable(draft, "items", [
      { _id: SERVER_ID, client_id: "stub-1", title: "server title", updated_at: 2 },
    ]);

    // The stub is gone and the server row carries the local override.
    expect(draft.items["stub-1"]).toBeUndefined();
    expect(draft.items[SERVER_ID].title).toBe("typed locally");
    // Pending protection followed the id.
    expect(draft.pending["items:stub-1:title"]).toBeUndefined();
    expect(draft.pending["items:" + SERVER_ID + ":title"]).toBeDefined();
    // The app got its chance to rekey whatever else pointed at the stub.
    expect(rekeyed).toEqual([["stub-1", SERVER_ID]]);
  });

  it("carries preserved local-only fields across the rekey", () => {
    const engine = createSyncEngine(
      makeConfig({ items: { isDelta: true, altKey: "client_id", preserveFields: ["_intent"] } }),
    );
    const draft = draftOf({
      items: { "stub-1": { _id: "stub-1", client_id: "stub-1", _intent: "file-it" } },
    });

    engine.syncTable(draft, "items", [{ _id: SERVER_ID, client_id: "stub-1", updated_at: 1 }]);

    expect(draft.items[SERVER_ID]._intent).toBe("file-it");
  });

  it("keeps an unmatched stub alive", () => {
    const engine = createSyncEngine(config);
    const stub = { _id: "stub-2", client_id: "stub-2" };
    const draft = draftOf({ items: { "stub-2": stub } });

    engine.syncTable(draft, "items", [{ _id: SERVER_ID, client_id: "someone-else", updated_at: 1 }]);

    expect(draft.items["stub-2"]).toBe(stub);
  });
});

describe("singleton, list and scalar recipes", () => {
  it("merges a singleton per its spec and flips the initialized flag", () => {
    const engine = createSyncEngine(
      makeConfig({ prefs: { kind: "singleton", merge: { theme: "local_wins", tips: "set_union" } } }),
    );
    const draft = draftOf({
      prefs: { theme: "dark", tips: ["a"] },
      prefsInitialized: true,
      pending: {},
    });

    engine.syncTable(draft, "prefs", { theme: "light", tips: ["b"] });

    expect(draft.prefs.theme).toBe("dark");
    expect(draft.prefs.tips.sort()).toEqual(["a", "b"]);
    expect(draft.prefsInitialized).toBe(true);
  });

  it("bails on a value-identical list push", () => {
    const engine = createSyncEngine(makeConfig({ members: { kind: "list" } }));
    const members = [{ _id: "m1", name: "Ada" }];
    const draft = draftOf({ members });

    engine.syncTable(draft, "members", [{ _id: "m1", name: "Ada" }]);

    expect(draft.members).toBe(members);
  });

  it("normalizes before the equality bail", () => {
    const engine = createSyncEngine(
      makeConfig({
        members: {
          kind: "list",
          normalize: (list: any[]) => list.map((m) => ({ ...m, seen: Math.floor(m.seen / 1000) * 1000 })),
        },
      }),
    );
    const members = [{ _id: "m1", seen: 60_000 }];
    const draft = draftOf({ members });

    engine.syncTable(draft, "members", [{ _id: "m1", seen: 60_400 }]);

    expect(draft.members).toBe(members);
  });

  it("replaces a scalar", () => {
    const engine = createSyncEngine(makeConfig({ unread: { kind: "scalar" } }));
    const draft = draftOf({ unread: 1 });
    engine.syncTable(draft, "unread", 4);
    expect(draft.unread).toBe(4);
  });

  it("ignores an empty payload", () => {
    const engine = createSyncEngine(makeConfig());
    const draft = draftOf({ items: { x: 1 } as any });
    engine.syncTable(draft, "items", null);
    expect(draft.items).toEqual({ x: 1 } as any);
  });
});

describe("syncRecord", () => {
  it("writes only the fields that changed", () => {
    const engine = createSyncEngine(makeConfig());
    const existing = { _id: SERVER_ID, title: "a", updated_at: 1 };
    const draft = draftOf({ items: { [SERVER_ID]: existing } });

    engine.syncRecord(draft, "items", SERVER_ID, { _id: SERVER_ID, title: "b", updated_at: 1 });

    expect(draft.items[SERVER_ID]).toBe(existing);
    expect(existing.title).toBe("b");
  });

  it("refuses a record the store excluded", () => {
    const engine = createSyncEngine(makeConfig());
    const draft = draftOf({ items: {}, pending: { [`items:${SERVER_ID}`]: { type: "exclude" } } });

    engine.syncRecord(draft, "items", SERVER_ID, { _id: SERVER_ID, title: "back from the dead" });

    expect(draft.items[SERVER_ID]).toBeUndefined();
  });
});

describe("syncOverlay", () => {
  it("annotates existing rows only, and only where a field changed", () => {
    const engine = createSyncEngine(makeConfig());
    const rowA = { _id: SERVER_ID, live: "off" };
    const draft = draftOf({ items: { [SERVER_ID]: rowA } });

    engine.syncOverlay(draft, "items", {
      [SERVER_ID]: { live: "on" },
      [OTHER_SERVER_ID]: { live: "on" },
    });

    expect(draft.items[SERVER_ID].live).toBe("on");
    expect(draft.items[OTHER_SERVER_ID]).toBeUndefined();
  });
});

describe("applyMerge", () => {
  it("implements each named policy", () => {
    expect(applyMerge("local", "server", "replace", true)).toBe("server");
    expect(applyMerge("local", "server", "local_wins", true)).toBe("local");
    // Not yet initialized: there is no local truth to defend.
    expect(applyMerge("local", "server", "local_wins", false)).toBe("server");
    expect(applyMerge({ a: 1 }, { a: 2, b: 3 }, "local_wins", true)).toEqual({ a: 1, b: 3 });
    expect(applyMerge(["a"], ["b"], "set_union", true).sort()).toEqual(["a", "b"]);
    expect(applyMerge({ a: 1, b: 1 }, { b: 2 }, "deep_merge", true)).toEqual({ a: 1, b: 2 });
  });

  it("walks a nested spec and accepts a function rule", () => {
    const merged = applyMerge(
      { ui: { theme: "dark" }, count: 2 },
      { ui: { theme: "light" }, count: 9 },
      { ui: { theme: "local_wins" }, count: (l: number, s: number) => Math.max(l, s) },
      true,
    );
    expect(merged).toEqual({ ui: { theme: "dark" }, count: 9 });
  });
});

describe("rekeyPending", () => {
  it("renames every entry of the old id and leaves others alone", () => {
    const pending: Record<string, any> = {
      "items:old:title": { type: "field", value: 1 },
      "items:old": { type: "include" },
      "items:keep:title": { type: "field", value: 2 },
    };
    rekeyPending(pending, "old", "new");
    expect(pending["items:new:title"]).toBeDefined();
    expect(pending["items:new"]).toBeDefined();
    expect(pending["items:old:title"]).toBeUndefined();
    expect(pending["items:keep:title"]).toBeDefined();
  });
});
