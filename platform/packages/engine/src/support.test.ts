import { describe, expect, it } from "bun:test";
import { deriveRegistryMaps } from "./registry";
import { diffCollection } from "./idbCollectionDiff";
import { expireExcludeTombstones } from "./idbCache";
import { hydrateMergeValue, unionHydrate } from "./persistence";
import {
  canRedo,
  canUndo,
  performRedo,
  performUndo,
  pushUndo,
  setUndoNotifier,
  _resetUndoStacks,
} from "./undoStack";
import type { RegistryEntry } from "./types";

const REGISTRY: Record<string, RegistryEntry> = {
  items: {
    persistence: { kind: "collection", key: "items" },
    localFirst: true,
    dispatchTable: { table: "item_rows", kind: "collection" },
    validRow: (row: any) => typeof row?.kind === "string" && row.kind === "item",
  },
  archive: {
    persistence: { kind: "collection", key: "archive" },
    hydration: { phase: "deferred" },
  },
  prefs: {
    persistence: { kind: "meta", key: "prefs" },
    dispatchTable: { table: "client_prefs", kind: "singleton" },
  },
  activeId: {
    persistence: { kind: "meta", key: "activeId" },
    dispatchFieldTable: "client_prefs",
  },
  liveIdList: {
    persistence: { kind: "meta", key: "liveIdList" },
    hydration: "manual",
  },
  unreadCount: {
    persistence: { kind: "meta", key: "unreadCount" },
    hydration: { merge: "fill" },
  },
  transient: {},
};

describe("registry derivation", () => {
  const maps = deriveRegistryMaps(REGISTRY);

  it("splits persisted keys by storage kind", () => {
    expect(maps.collectionStoreKeys).toEqual(["items", "archive"]);
    expect(maps.metaStoreKeys).toEqual(["prefs", "activeId", "liveIdList", "unreadCount"]);
    expect(maps.isPersistedStoreKey("transient")).toBe(false);
  });

  it("puts every persisted key in exactly one hydration phase, manual keys aside", () => {
    const covered = [...maps.hydrationCriticalKeys, ...maps.hydrationDeferredKeys];
    expect(maps.hydrationDeferredKeys).toEqual(["archive"]);
    expect(covered).not.toContain("liveIdList");
    for (const key of [...maps.collectionStoreKeys, ...maps.metaStoreKeys]) {
      if (key === "liveIdList") continue;
      expect(covered.filter((k) => k === key)).toHaveLength(1);
    }
  });

  it("derives the dispatch maps and the local-first set", () => {
    expect(maps.dispatchTableMap.items).toEqual({ table: "item_rows", kind: "collection" });
    expect(maps.dispatchFieldTableMap.activeId).toEqual({ table: "client_prefs" });
    expect(maps.isProtectedSyncCollection("items")).toBe(true);
    expect(maps.isProtectedSyncCollection("archive")).toBe(false);
  });

  it("exposes the merge strategy and the row validator", () => {
    expect(maps.hydrationMergeStrategy("unreadCount")).toBe("fill");
    expect(maps.hydrationMergeStrategy("items")).toBe("shape");
    expect(maps.collectionRowValidator("items")!({ kind: "item" })).toBe(true);
    expect(maps.collectionRowValidator("archive")).toBeUndefined();
  });
});

describe("hydration merge", () => {
  const strategy = deriveRegistryMaps(REGISTRY).hydrationMergeStrategy;

  it("unions an object with the cache as floor and live data winning per key", () => {
    const merged = hydrateMergeValue(
      "items",
      { a: { _id: "a", v: "cached" }, b: { _id: "b" } },
      { a: { _id: "a", v: "live" } },
      strategy,
    );
    expect(merged.apply).toBe(true);
    expect(merged.value).toEqual({ a: { _id: "a", v: "live" }, b: { _id: "b" } });
  });

  it("only fills a still-empty slot for a fill key", () => {
    expect(hydrateMergeValue("unreadCount", 4, null, strategy)).toEqual({ apply: true, value: 4 });
    expect(hydrateMergeValue("unreadCount", 4, 9, strategy)).toEqual({ apply: false });
  });

  it("fills an array only when the store slot is empty", () => {
    expect(hydrateMergeValue("prefs", ["a"], [], strategy)).toEqual({ apply: true, value: ["a"] });
    expect(hydrateMergeValue("prefs", ["a"], ["live"], strategy)).toEqual({ apply: false });
  });

  it("replaces a scalar", () => {
    expect(hydrateMergeValue("activeId", "t1", "t0", strategy)).toEqual({ apply: true, value: "t1" });
  });

  it("unions with either side missing", () => {
    expect(unionHydrate(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(unionHydrate({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("diffCollection", () => {
  it("writes only rows whose reference changed and reports removals", () => {
    const rowA = { _id: "a" };
    const rowB = { _id: "b" };
    const first = diffCollection(undefined, { a: rowA, b: rowB });
    expect(first.puts).toEqual([rowA, rowB]);
    expect(first.deletes).toEqual([]);

    const unchanged = diffCollection(first.next, { a: rowA, b: rowB });
    expect(unchanged.puts).toEqual([]);
    expect(unchanged.deletes).toEqual([]);

    const rowAv2 = { _id: "a", v: 2 };
    const changed = diffCollection(first.next, { a: rowAv2 });
    expect(changed.puts).toEqual([rowAv2]);
    expect(changed.deletes).toEqual(["b"]);
  });
});

describe("expireExcludeTombstones", () => {
  const now = 1_000_000_000;
  const ttl = 1000;

  it("drops an aged tombstone, stamps an unstamped one, keeps the rest", () => {
    const cleaned = expireExcludeTombstones(
      {
        "items:old": { type: "exclude", ts: now - ttl - 1 },
        "items:fresh": { type: "exclude", ts: now - 1 },
        "items:legacy": { type: "exclude" },
        "items:a:title": { type: "field", value: "mine", ts: 0 },
        "items:stub": { type: "include", ts: 0 },
      },
      now,
      ttl,
    );

    expect(cleaned["items:old"]).toBeUndefined();
    expect(cleaned["items:fresh"]).toBeDefined();
    expect(cleaned["items:legacy"].ts).toBe(now);
    // Local-first writes awaiting acknowledgement never expire.
    expect(cleaned["items:a:title"]).toBeDefined();
    expect(cleaned["items:stub"]).toBeDefined();
  });

  it("drops stale field locks on fields the registry declares unprotected", () => {
    const cleaned = expireExcludeTombstones(
      {
        // Persisted by an older build before the field was unprotected — a
        // corrupted single-element value that can never echo.
        "items:a:comments": { type: "field", value: { _id: "temp_1" }, ts: now },
        "items:a:title": { type: "field", value: "mine", ts: now },
        "items:a": { type: "include", ts: now },
      },
      now,
      ttl,
      (key, field) => key === "items" && field === "comments",
    );

    expect(cleaned["items:a:comments"]).toBeUndefined();
    expect(cleaned["items:a:title"]).toBeDefined();
    expect(cleaned["items:a"]).toBeDefined();
  });
});

describe("undo stack", () => {
  it("walks undo and redo, and tells the user through the installed notifier", () => {
    _resetUndoStacks();
    const said: string[] = [];
    setUndoNotifier({ notify: (m) => said.push(m) });

    let value = 0;
    pushUndo({ label: "set to 1", undo: () => { value = 0; }, redo: () => { value = 1; } });
    value = 1;

    expect(canUndo()).toBe(true);
    expect(performUndo()).toBe(true);
    expect(value).toBe(0);
    expect(canRedo()).toBe(true);
    expect(performRedo()).toBe(true);
    expect(value).toBe(1);
    expect(said).toEqual(["Undid: set to 1", "Redid: set to 1"]);
  });

  it("clears the redo stack when new work is pushed", () => {
    _resetUndoStacks();
    setUndoNotifier({ notify: () => {} });
    pushUndo({ label: "a", undo: () => {}, redo: () => {} });
    performUndo();
    expect(canRedo()).toBe(true);
    pushUndo({ label: "b", undo: () => {}, redo: () => {} });
    expect(canRedo()).toBe(false);
  });
});
