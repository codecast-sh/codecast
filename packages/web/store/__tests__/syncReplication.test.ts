import { describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { applyUpdatesToStore } from "../syncReplication";
import {
  CLIENT_SYNC_REGISTRY,
  REPLICATION_CLASSIFICATION,
  REPLICATED_STORE_KEYS,
  isReplicatedCollectionKey,
} from "../clientSyncRegistry";

describe("replication classification", () => {
  it("classifies every registry key, and only registry keys", () => {
    const registryKeys = Object.keys(CLIENT_SYNC_REGISTRY).sort();
    const classified = Object.keys(REPLICATION_CLASSIFICATION).sort();
    expect(classified).toEqual(registryKeys);
  });

  it("never replicates per-window optimism or window arrangement", () => {
    for (const key of ["pending", "drafts", "queuedMessages", "tabs", "activeTabId", "sidePanelSessionId"]) {
      expect(REPLICATION_CLASSIFICATION[key as keyof typeof REPLICATION_CLASSIFICATION]).toBe("local");
    }
    expect(REPLICATED_STORE_KEYS).not.toContain("pending");
  });

  it("collection detection matches the registry", () => {
    expect(isReplicatedCollectionKey("sessions")).toBe(true);
    expect(isReplicatedCollectionKey("teams")).toBe(false); // meta list
    expect(isReplicatedCollectionKey("pending")).toBe(false); // local
  });
});

describe("applyUpdatesToStore", () => {
  it("lands collection upserts through syncTable (pending respected)", () => {
    const id = "k".repeat(32);
    applyUpdatesToStore([
      { key: "sessions", upserts: [{ _id: id, session_id: `sess-${id}`, title: "from host", updated_at: 1 }] },
    ]);
    expect((useInboxStore.getState().sessions as any)[id]?.title).toBe("from host");

    // A local pending field lock beats a replicated row (invariant 4).
    useInboxStore.setState((s: any) => ({
      pending: { ...s.pending, [`sessions:${id}:title`]: { type: "field", value: "mine", ts: Date.now() } },
    }));
    applyUpdatesToStore([
      { key: "sessions", upserts: [{ _id: id, session_id: `sess-${id}`, title: "stale", updated_at: 2 }] },
    ]);
    expect((useInboxStore.getState().sessions as any)[id]?.title).toBe("mine");
  });

  it("applies removals but never tears out an include-pending row", () => {
    const gone = "g".repeat(32);
    const kept = "h".repeat(32);
    applyUpdatesToStore([
      { key: "sessions", upserts: [
        { _id: gone, session_id: `s-${gone}`, updated_at: 1 },
        { _id: kept, session_id: `s-${kept}`, updated_at: 1 },
      ] },
    ]);
    useInboxStore.setState((s: any) => ({
      pending: { ...s.pending, [`sessions:${kept}`]: { type: "include", ts: Date.now() } },
    }));
    applyUpdatesToStore([{ key: "sessions", removes: [gone, kept] }]);
    expect((useInboxStore.getState().sessions as any)[gone]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[kept]).toBeDefined();
  });

  it("routes twin keys through their set-rebuilding setters", () => {
    const ids = ["a".repeat(32), "b".repeat(32)];
    applyUpdatesToStore([{ key: "liveInboxIdList", value: ids, hasValue: true }]);
    const s = useInboxStore.getState();
    expect(s.liveInboxIdList).toEqual(ids);
    expect(s.liveInboxIds.has(ids[0])).toBe(true);
  });

  it("applies value keys without a sync registry entry by shape", () => {
    applyUpdatesToStore([{ key: "docProjectPaths", value: { d1: "/x" }, hasValue: true }]);
    expect((useInboxStore.getState() as any).docProjectPaths?.d1).toBe("/x");
  });
});
