import { describe, expect, it } from "bun:test";
import { syncLogScopeMetaKey, useInboxStore } from "../inboxStore";
import { applyUpdatesToStore, followerActionTee } from "../syncReplication";
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

  // ct-57027: a follower's write reached this host as a mut and is held here
  // under a mirrored lock. The server refused it, so no echo retires that
  // lock; the follower's rollback releases it and puts the prior value back.
  it("a sibling's refused write releases the mirrored lock and restores the prior value", () => {
    const id = "f".repeat(32);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1, title: "server" }], { isDelta: true });
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { title: "refused" } }, 10);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:title`]?.value).toBe("refused");

    const tee = followerActionTee({ post: (m: any) => posted.push(m), onMessage: () => () => {} } as any, "w1");
    const posted: any[] = [];
    const after = { ...useInboxStore.getState(), sessions: { [id]: { _id: id, title: "server" } } };
    tee("rename", [{ op: "replace", path: ["sessions", id, "title"], value: "server" }], after, {
      refused: [{ key: `sessions:${id}:title`, storeKey: "sessions", recordId: id, field: "title", ts: 10, value: "refused", prior: "server", hadPrior: true }],
    });
    expect(posted[0].updates[0].release).toEqual({ [id]: { title: "refused" } });

    applyUpdatesToStore(posted[0].updates, { optimistic: true });
    expect((useInboxStore.getState().sessions as any)[id].title).toBe("server");
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:title`]).toBeUndefined();
  });

  // A later write on the field (this window's own, or a newer sibling's) has
  // moved past the refused value: the release leaves it alone.
  it("a refused-write release leaves a field that has moved on", () => {
    const id = "g".repeat(32);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1, title: "server" }], { isDelta: true });
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { title: "newer" } }, 20);
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { title: "server" } }, 30, { [id]: { title: "refused" } });
    expect((useInboxStore.getState().sessions as any)[id].title).toBe("newer");
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:title`]?.value).toBe("newer");
  });
});

// A lock released after the update it blocked has landed would strand that
// update: nothing delivers the row again, so the window keeps its own older
// value while the host and the server hold the newer one. A lock retired by
// its acknowledgement hands the row the newest server value it hid.
describe("a lock retired by its acknowledgement lands the value it hid", () => {
  const SCOPE = "user:ack-scope";
  const field = "inbox_stashed_at";
  const seedLocked = (id: string, cursor: number, ack?: Array<{ s: string; p: number }>) => {
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 1, [field]: null }], { isDelta: true });
    useInboxStore.setState((s: any) => ({
      syncMeta: { ...s.syncMeta, [syncLogScopeMetaKey(SCOPE)]: { cursor } },
      pending: { ...s.pending, [`sessions:${id}:${field}`]: { type: "field", value: null, ts: Date.now(), ...(ack ? { ack } : {}) } },
    }));
  };

  it("a follower's lock released by the host's cursor after the page's rows", () => {
    const id = "q".repeat(32);
    seedLocked(id, 8, [{ s: SCOPE, p: 9 }]);
    // The page's row (another device stashed again at 10) arrives first.
    applyUpdatesToStore([{ key: "sessions", upserts: [{ _id: id, session_id: `s-${id}`, updated_at: 2, [field]: 777 }] }]);
    expect((useInboxStore.getState().sessions as any)[id][field]).toBeNull();
    applyUpdatesToStore([{ key: "syncMeta", hasValue: true, value: { [syncLogScopeMetaKey(SCOPE)]: { cursor: 10 } } }]);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:${field}`]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[id][field]).toBe(777);
  });

  it("an acknowledgement that arrives after the cursor already passed it", () => {
    const id = "w".repeat(32);
    seedLocked(id, 8);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 2, [field]: 777 }], { isDelta: true });
    expect((useInboxStore.getState().sessions as any)[id][field]).toBeNull();
    useInboxStore.setState((s: any) => ({ syncMeta: { ...s.syncMeta, [syncLogScopeMetaKey(SCOPE)]: { cursor: 10 } } }));
    useInboxStore.getState().stampSyncAck({ conversations: { [id]: { [field]: null } } }, [{ scope_key: SCOPE, position: 9 }], Date.now() + 1, { local: true });
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:${field}`]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[id][field]).toBe(777);
  });

  // The host: the bridge landed a follower's write, the cursor retired its
  // lock and the range brought another device's newer value. The follower's
  // replicated mut of the same write arrives last and must not put it back.
  it("a sibling's replicated write that arrives after its acknowledgement retired is dropped", () => {
    const id = "z".repeat(32);
    seedLocked(id, 8, [{ s: SCOPE, p: 9 }]);
    const ts = (useInboxStore.getState().pending as any)[`sessions:${id}:${field}`].ts;
    useInboxStore.getState().retireAckedPending(SCOPE, 10);
    useInboxStore.getState().syncTable("sessions", [{ _id: id, session_id: `s-${id}`, updated_at: 2, [field]: 777 }], { isDelta: true });
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { [field]: null } }, ts);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:${field}`]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[id][field]).toBe(777);
    // A newer write of the sibling's still lands.
    useInboxStore.getState().applyReplicatedFields("sessions", { [id]: { [field]: null } }, ts + 1);
    expect((useInboxStore.getState().sessions as any)[id][field]).toBeNull();
  });

  it("a lock that hid nothing newer leaves the row on its value", () => {
    const id = "y".repeat(32);
    seedLocked(id, 8, [{ s: SCOPE, p: 9 }]);
    applyUpdatesToStore([{ key: "syncMeta", hasValue: true, value: { [syncLogScopeMetaKey(SCOPE)]: { cursor: 10 } } }]);
    expect((useInboxStore.getState().pending as any)[`sessions:${id}:${field}`]).toBeUndefined();
    expect((useInboxStore.getState().sessions as any)[id][field]).toBeNull();
  });
});
