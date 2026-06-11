import { describe, expect, it } from "bun:test";
import {
  CLIENT_SYNC_REGISTRY,
  COLLECTION_STORE_KEYS,
  DISPATCH_FIELD_TABLE_MAP,
  DISPATCH_TABLE_MAP,
  META_STORE_KEYS,
  collectionRowValidator,
  isPersistedClientStoreKey,
  isProtectedSyncCollection,
} from "../clientSyncRegistry";

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
