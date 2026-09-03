import { describe, expect, it } from "bun:test";
import {
  CLIENT_SYNC_REGISTRY,
  COLLECTION_INDEXES,
  COLLECTION_STORE_KEYS,
  DISPATCH_FIELD_TABLE_MAP,
  DISPATCH_TABLE_MAP,
  HYDRATION_CRITICAL_KEYS,
  HYDRATION_DEFERRED_KEYS,
  META_STORE_KEYS,
  REGISTRY_SYNC_OPTS,
  WORKSPACE_SCOPED_KEYS,
  collectionRowHydrator,
  collectionRowValidator,
  hydrationMergeStrategy,
  isPersistedClientStoreKey,
  isProtectedSyncCollection,
} from "../clientSyncRegistry";
import { CACHE_SCHEMA_SIGNATURE, MISSING_COLLECTION_TABLES, cacheSchemaSignature } from "../idbCache";
import { useInboxStore } from "../inboxStore";

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
    for (const key of [
      "docs", "plans", "tasks", "sessions",
      "projects",
    ]) {
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

  it("never field-locks a task's comment stream", () => {
    // The append-only comment list reconciles wholesale from the server; a
    // field lock could never retire (the optimistic temp comment never matches
    // the echo) and once corrupted the whole Threads page down. See
    // tasks.unprotectedFields in the registry.
    expect(CLIENT_SYNC_REGISTRY.tasks.unprotectedFields).toContain("comments");
  });

  it("rejects task rows whose comment stream was poisoned into a non-array", () => {
    const validRow = collectionRowValidator("tasks")!;
    expect(validRow({ short_id: "ct-1" })).toBe(true);
    expect(validRow({ short_id: "ct-1", comments: [] })).toBe(true);
    // A pre-fix pending lock re-asserted a lone comment object as the whole
    // field; hydration drops such rows so live sync re-fills them clean.
    expect(validRow({ short_id: "ct-1", comments: { _id: "temp_1" } })).toBe(false);
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
      for (const key of [
        "tasks", "docs", "plans", "projects",
      ]) {
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

  // Chat opts OUT of local-first field protection on purpose, and that choice is
  // load-bearing enough to lock down: auto-pending clears only on an exact echo,
  // and chat's fields are server clock stamps the client cannot predict, so a
  // pending entry over one could never retire and would mask the real row.
  it("chat collections persist and hydrate late, and are deliberately not field-protected", () => {
    for (const key of ["chatChannels", "chatMessages", "chatReactions", "chatReads"]) {
      expect(COLLECTION_STORE_KEYS).toContain(key);
      expect(HYDRATION_DEFERRED_KEYS).toContain(key);
      expect(isProtectedSyncCollection(key)).toBe(false);
      expect(DISPATCH_TABLE_MAP[key]).toBeUndefined();
    }
    expect(META_STORE_KEYS).toContain("chatRail");

    // A message row must know its channel; anything else is a foreign document
    // that would hydrate as a message with no home.
    const validMessage = collectionRowValidator("chatMessages")!;
    expect(validMessage({ _id: "m1", channel_id: "c1", content: "hi" })).toBe(true);
    expect(validMessage({ _id: "m1", content: "hi" })).toBe(false);
    expect(validMessage({})).toBe(false);
  });

  it("every registered collection has a Dexie table (schema is derived from the registry)", () => {
    // A missing table used to reject loadCache's whole Promise.all — one
    // forgotten migration silently disabled the entire cache.
    expect(MISSING_COLLECTION_TABLES).toEqual([]);
  });

  // ── Registration is the whole job ────────────────────────────────────────
  // Adding a synced collection used to touch five files (registry, SYNC_REGISTRY,
  // a Dexie schema version, the state interface, initial state) and forgetting
  // any one of them failed silently — no table, undefined at boot, or a
  // snapshot sync pruning the cache. These pin the derivations that replaced
  // the hand-written lines.
  describe("derived registration", () => {
    it("the on-disk schema signature matches the pinned one (bump CACHE_SCHEMA_VERSION when it changes)", () => {
      // If this fails you added/removed a persisted collection or changed an
      // index: bump CACHE_SCHEMA_VERSION and paste the new signature. That
      // bump is what makes IndexedDB run the upgrade on users' machines.
      expect(cacheSchemaSignature()).toBe(CACHE_SCHEMA_SIGNATURE);
    });

    it("every persisted collection defaults to _id and carries its own indexes", () => {
      expect(COLLECTION_INDEXES.tasks).toBe("_id");
      expect(COLLECTION_INDEXES.chatMessages).toBe("_id, channel_id, thread_root_id");
      for (const key of COLLECTION_STORE_KEYS) expect(COLLECTION_INDEXES[key]).toBeTruthy();
    });

    it("every registered collection starts as an empty record in the store", () => {
      const state = useInboxStore.getState() as any;
      for (const key of COLLECTION_STORE_KEYS) {
        expect(state[key]).toBeDefined();
        expect(typeof state[key]).toBe("object");
      }
      // And so does every persisted meta key: hydration writes into it.
      for (const key of META_STORE_KEYS) expect(key in state).toBe(true);
    });

    it("sync opts registered on the collection reach the store's sync path", () => {
      // docs/plans/projects declare isDelta on the registry entry (no
      // SYNC_REGISTRY line). A snapshot sync of ONE row must not prune the rest.
      expect(REGISTRY_SYNC_OPTS.plans).toEqual({ isDelta: true });
      useInboxStore.setState({ plans: { a: { _id: "a" }, b: { _id: "b" } } } as any);
      useInboxStore.getState().syncTable("plans", [{ _id: "a", title: "A" }]);
      expect(Object.keys(useInboxStore.getState().plans).sort()).toEqual(["a", "b"]);
    });

    it("saved views persist as a snapshot, so a pinned view resolves on an offline boot", () => {
      // The sidebar's pinned rows render from client UI state and then look
      // the view up in this collection on click; unpersisted, that click was
      // a silent no-op offline. Snapshot mode is what removes a deleted view.
      expect(COLLECTION_STORE_KEYS).toContain("savedViews");
      expect(REGISTRY_SYNC_OPTS.savedViews?.isDelta).toBeFalsy();
    });

    it("workspace-scoped tables are declared on the entry", () => {
      expect(WORKSPACE_SCOPED_KEYS.sort()).toEqual(["docs", "issueSyncSources", "plans", "projects", "tasks"].sort());
    });
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

describe("docs hydrateRow", () => {
  const hydrate = collectionRowHydrator("docs")!;

  it("drops a cached body (content/entries/embedding) on load", () => {
    const row = { _id: "d1", title: "T", content: "# big body", entries: [1], embedding: [0.1] };
    const out = hydrate(row, { pending: {} });
    expect(out).toEqual({ _id: "d1", title: "T" });
    // The on-disk row is untouched (the shadow keeps it for the persist diff).
    expect(row.content).toBe("# big body");
  });

  it("returns the same row when there is nothing to trim", () => {
    const row = { _id: "d1", title: "T" };
    expect(hydrate(row, { pending: {} })).toBe(row);
  });

  it("keeps the body of an unsynced local edit (pending field lock)", () => {
    const row = { _id: "d1", title: "T", content: "local draft" };
    expect(hydrate(row, { pending: { "docs:d1:content": { type: "field", value: "local draft" } } })).toBe(row);
  });
});
