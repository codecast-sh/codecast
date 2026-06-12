import { describe, expect, it } from "bun:test";
import {
  CLIENT_SYNC_REGISTRY,
  COLLECTION_STORE_KEYS,
  DISPATCH_FIELD_TABLE_MAP,
  DISPATCH_TABLE_MAP,
  HYDRATION_CRITICAL_KEYS,
  HYDRATION_DEFERRED_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  hydrationMergeStrategy,
  isPersistedClientStoreKey,
  isProtectedSyncCollection,
} from "../clientSyncRegistry";
import { MISSING_COLLECTION_TABLES } from "../idbCache";

describe("client sync registry", () => {
  it("covers the core synced and persisted store slices", () => {
    for (const key of [
      "docs",
      "plans",
      "tasks",
      "sessions",
      "conversations",
      "pendingMessages",
    ]) {
      expect(CLIENT_SYNC_REGISTRY).toHaveProperty(key);
    }
  });

  it("drives collection and meta persistence metadata", () => {
    for (const key of ["docs", "plans", "tasks", "sessions"]) {
      expect(COLLECTION_STORE_KEYS).toContain(key);
    }
    for (const key of ["conversations", "pendingMessages", "pending"]) {
      expect(META_STORE_KEYS).toContain(key);
    }

    expect(isPersistedClientStoreKey("pendingMessages")).toBe(true);
    expect(isPersistedClientStoreKey("messages")).toBe(false);
  });

  it("drives local-first protection metadata", () => {
    expect(isProtectedSyncCollection("sessions")).toBe(true);
    expect(isProtectedSyncCollection("conversations")).toBe(true);
    expect(isProtectedSyncCollection("tasks")).toBe(true);
    expect(isProtectedSyncCollection("docs")).toBe(true);
    expect(isProtectedSyncCollection("plans")).toBe(true);
    expect(isProtectedSyncCollection("pendingMessages")).toBe(false);
  });

  it("keeps server dispatch table metadata in the same registry", () => {
    expect(DISPATCH_TABLE_MAP.conversations).toEqual({ table: "conversations", kind: "collection" });
    expect(DISPATCH_TABLE_MAP.clientState).toEqual({ table: "client_state", kind: "singleton" });
    expect(DISPATCH_FIELD_TABLE_MAP.tabs).toEqual({ table: "client_state" });
    expect(DISPATCH_FIELD_TABLE_MAP.activeTabId).toEqual({ table: "client_state" });
  });

  // Persistence has three legs: write to IDB, read from disk, APPLY to the
  // store. The first two were always registry-generic; the apply leg used to be
  // hand-enumerated pick lists in inboxStore, and a key in neither list was a
  // silent cache no-op (ct-34920; the buckets label pop-in). These tests lock
  // the registry-derived contract: registering persistence IS hydration.
  describe("hydration is derived, never opt-in", () => {
    const hydrated = new Set([...HYDRATION_CRITICAL_KEYS, ...HYDRATION_DEFERRED_KEYS]);

    it("every persisted key hydrates or is explicitly manual", () => {
      for (const [key, entry] of Object.entries(CLIENT_SYNC_REGISTRY)) {
        if (!("persistence" in entry) || !entry.persistence) continue;
        const manual = "hydration" in entry && entry.hydration === "manual";
        expect(manual ? !hydrated.has(key) : hydrated.has(key)).toBe(true);
      }
    });

    it("no phase double-lists a key", () => {
      const overlap = HYDRATION_CRITICAL_KEYS.filter((k) =>
        (HYDRATION_DEFERRED_KEYS as readonly string[]).includes(k)
      );
      expect(overlap).toEqual([]);
    });

    it("buckets + assignments hydrate in the critical pass (label-bar pop-in regression)", () => {
      expect(HYDRATION_CRITICAL_KEYS).toContain("buckets");
      expect(HYDRATION_CRITICAL_KEYS).toContain("bucketAssignments");
    });

    it("heavy list-view collections stay deferred; restore-special keys stay manual", () => {
      for (const key of ["tasks", "docs", "plans", "projects"]) {
        expect(HYDRATION_DEFERRED_KEYS).toContain(key);
      }
      expect(hydrated.has("lastFocusedConversationId")).toBe(false);
    });

    it("live-synced singletons fill only an empty slot; everything else merges by shape", () => {
      expect(hydrationMergeStrategy("teamUnreadCount")).toBe("fill");
      expect(hydrationMergeStrategy("currentUser")).toBe("fill");
      expect(hydrationMergeStrategy("sessions")).toBe("shape");
      expect(hydrationMergeStrategy("buckets")).toBe("shape");
    });
  });

  it("every registered collection has a Dexie table (schema version bumped)", () => {
    // A missing table used to reject loadCache's whole Promise.all — one
    // forgotten migration silently disabled the entire cache.
    expect(MISSING_COLLECTION_TABLES).toEqual([]);
  });

  it("rejects foreign documents persisted under tasks (conversation-as-task poisoning)", () => {
    const validTask = collectionRowValidator("tasks")!;
    expect(validTask({ _id: "mh7abc", short_id: "ct-123", title: "Real task" })).toBe(true);
    // A conversation once stored by the table-blind webGetTaskDetail: session
    // short id, message_count, agent_type — not a task.
    expect(validTask({ _id: "jx781mx…", short_id: "jx781mx", title: "Budget distribution code", message_count: 744 })).toBe(false);
    expect(validTask({ _id: "jx74rqa…", title: "Session bucketing system" })).toBe(false);
    expect(validTask({})).toBe(false);
    // Collections without an invariant accept anything (no validator).
    expect(collectionRowValidator("sessions")).toBeUndefined();
    expect(collectionRowValidator("docs")).toBeUndefined();
  });
});
