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

describe("replicated facts and locks", () => {
  // A follower mounts no overlay: the host's row is its only fact writer, so
  // a fact the host's overlay cleared must clear here too.
  it("a follower takes the host's overlay facts verbatim, a null included", () => {
    const id = "f".repeat(32);
    applyUpdatesToStore([{ key: "sessions", upserts: [{ _id: id, session_id: `s-${id}`, updated_at: 1, daemon_alive_until: 500 }] }]);
    applyUpdatesToStore([{ key: "sessions", upserts: [{ _id: id, session_id: `s-${id}`, updated_at: 1, daemon_alive_until: null }] }]);
    expect((useInboxStore.getState().sessions as any)[id].daemon_alive_until).toBeNull();
  });

  // ct-56048: the bridge and the follower's replicated write both reach the
  // host, in either order with the write's acknowledgement.
  it("a replicated field write keeps a lock's acknowledgement, and plants none on a value already acknowledged and echoed", () => {
    const id = "r".repeat(32);
    const ack = [{ s: "user:me", p: 3 }];
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1 }], { isDelta: true });
    useInboxStore.setState((s: any) => ({ pending: { ...s.pending, [`sessions:${id}:inbox_dismissed_at`]: { type: "field", value: 9, ts: 9, ack } } }));
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_dismissed_at: 9 } }, 10);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:inbox_dismissed_at`]).toEqual({ type: "field", value: 9, ts: 10, ack });

    useInboxStore.setState((s: any) => {
      const { [`sessions:${id}:inbox_dismissed_at`]: _gone, ...pending } = s.pending;
      return { pending };
    });
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_dismissed_at: 9 } }, 11);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:inbox_dismissed_at`]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[id].inbox_dismissed_at).toBe(9);
  });

  // A follower pins; its mut waits in the channel while the host unpins. The
  // late mut must not put the pin back under a lock the server, which took
  // the unpin, never echoes (legacy multi-window sim seeds 83 and 86).
  it("a replicated field write older than this window's own lock on the field is dropped", () => {
    const id = "p".repeat(32);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1, inbox_pinned_at: null }], { isDelta: true });
    useInboxStore.setState((s: any) => ({ pending: { ...s.pending, [`sessions:${id}:inbox_pinned_at`]: { type: "field", value: null, ts: 20 } } }));
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_pinned_at: 15 } }, 15);
    expect((useInboxStore.getState().sessions as any)[id].inbox_pinned_at).toBeNull();
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:inbox_pinned_at`]).toEqual({ type: "field", value: null, ts: 20 });

    // A newer one lands.
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_pinned_at: 25 } }, 25);
    expect((useInboxStore.getState().sessions as any)[id].inbox_pinned_at).toBe(25);
  });

  // A follower undoes a kill and redoes it; its undo's mut waits in the
  // channel while the server stamps the redo's kill and this window takes the
  // row. Only the server writes the marker, so the stamp the row holds is the
  // newest kill: the older clear must not land under a lock no ack retires.
  it("a replicated clear of inbox_killed_at older than the stamp the row holds is dropped", () => {
    const id = "k".repeat(32);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1, inbox_killed_at: 30 }], { isDelta: true });
    for (const ts of [20, 30]) useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_killed_at: null } }, ts);
    expect((useInboxStore.getState().sessions as any)[id].inbox_killed_at).toBe(30);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:inbox_killed_at`]).toBeUndefined();

    // A clear made after the kill lands.
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { inbox_killed_at: null } }, 40);
    expect((useInboxStore.getState().sessions as any)[id].inbox_killed_at).toBeNull();
  });
});
