import { describe, expect, it } from "bun:test";
import { createFollowerInbox, snapshotBatches, type ReplicationMessage, type ReplicationUpdate } from "./replication";
import { createReplicationFollower, createReplicationHost, type ReplicationChannel } from "./replicationRuntime";

function port() {
  const posted: ReplicationMessage[] = [];
  const listeners = new Set<(msg: ReplicationMessage) => void>();
  const channel: ReplicationChannel = {
    post: (msg) => posted.push(msg),
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { channel, posted, deliver: (msg: ReplicationMessage) => listeners.forEach((cb) => cb(msg)) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
const keys = ["rows", "theme"];
const isCollection = (key: string) => key === "rows";
const rows = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { _id: String(i), title: `row ${i}` }]));

function follower() {
  const p = port();
  const applied: ReplicationUpdate[][] = [];
  const f = createReplicationFollower({ selfId: "f", channel: p.channel, replicatedKeys: keys, isCollectionKey: isCollection, applyUpdates: (updates) => applied.push(updates) });
  const request = () => (p.posted.at(-1) as Extract<ReplicationMessage, { type: "hello" }>).snapshotRequest!;
  const chunk = (index: number, done: boolean, updates: ReplicationUpdate[] = [], requestId = request()) => p.deliver({ type: "snapshotChunk", hostId: "h", seq: 4, to: "f", request: requestId, index, done, updates });
  return { ...p, f, applied, request, chunk };
}

describe("bounded replication snapshots", () => {
  it("bounds rows across collections and retains singleton values", () => {
    const source = { rows: rows(601), theme: "dark" };
    const batches = [...snapshotBatches(source, keys, isCollection)];
    expect(batches.map((batch) => batch.reduce((n, u) => n + (u.upserts?.length ?? 1), 0))).toEqual([256, 256, 90]);
    expect(batches.flat().flatMap((u) => u.upserts ?? [])).toEqual(Object.values(source.rows));
    expect(batches.at(-1)?.at(-1)).toEqual({ key: "theme", value: "dark", hasValue: true });
  });

  it("yields transport batches while keeping one snapshot position and immutable source", async () => {
    const p = port();
    let state = { rows: rows(601), theme: "dark" };
    const h = createReplicationHost({ hostId: "h", channel: p.channel, getState: () => state, replicatedKeys: keys, isCollectionKey: isCollection, applyUpdates: () => {} });
    try {
      p.deliver({ type: "hello", from: "f", snapshotRequest: "r1" });
      expect(p.posted).toHaveLength(1);
      state = { rows: { ...state.rows, "600": { _id: "600", title: "new" } }, theme: "light" };
      h.tee([{ op: "replace", path: ["rows", "600", "title"], value: "new" }], state);
      for (let i = 0; i < 20 && !p.posted.some((m) => m.type === "snapshotChunk" && m.done); i++) await tick();
      const chunks = p.posted.filter((m) => m.type === "snapshotChunk");
      expect(chunks.map((m) => [m.index, m.seq, m.done])).toEqual([[0, 0, false], [1, 0, false], [2, 0, true]]);
      expect(chunks.flatMap((m) => m.updates).flatMap((u) => u.upserts ?? []).at(-1)?.title).toBe("row 600");
      expect(p.posted[1].type).toBe("update");
    } finally {
      h.stop();
    }
  });

  it("buffers intervening updates until the last chunk and skips the author's echo", () => {
    const f = follower();
    try {
      f.chunk(0, false, [{ key: "rows", upserts: [{ _id: "a", title: "old" }] }]);
      f.deliver({ type: "update", hostId: "h", seq: 5, origin: "h", updates: [{ key: "rows", upserts: [{ _id: "b", title: "new" }] }] });
      f.deliver({ type: "update", hostId: "h", seq: 6, origin: "f", updates: [{ key: "theme", value: "own", hasValue: true }] });
      expect(f.f.synced()).toBe(false);
      expect(f.applied).toHaveLength(1);
      f.chunk(1, true, [{ key: "rows", upserts: [{ _id: "b", title: "old" }] }]);
      expect(f.f.synced()).toBe(true);
      expect(f.applied.flat().flatMap((u) => u.upserts ?? []).map((row) => row.title)).toEqual(["old", "old", "new"]);
      expect(f.applied.flat().some((u) => u.key === "theme")).toBe(false);
    } finally {
      f.f.stop();
    }
  });

  it("retries a missing chunk and ignores the abandoned transfer", () => {
    const f = follower();
    try {
      const abandoned = f.request();
      f.chunk(0, false);
      f.chunk(2, true);
      expect(f.request()).not.toBe(abandoned);
      f.chunk(1, true, [{ key: "theme", value: "stale", hasValue: true }], abandoned);
      expect(f.applied.flat()).toEqual([]);
      f.chunk(0, true, [{ key: "theme", value: "fresh", hasValue: true }]);
      expect(f.f.synced()).toBe(true);
      expect(f.applied.flat()).toEqual([{ key: "theme", value: "fresh", hasValue: true }]);
    } finally {
      f.f.stop();
    }
  });

  it("a new host interrupts an in-flight snapshot", () => {
    const f = follower();
    try {
      const abandoned = f.request();
      f.chunk(0, false);
      f.deliver({ type: "update", hostId: "new", seq: 1, origin: "new", updates: [] });
      expect(f.request()).not.toBe(abandoned);
      f.chunk(1, true, [], abandoned);
      expect(f.f.synced()).toBe(false);
      f.deliver({ type: "snapshotChunk", hostId: "new", seq: 1, to: "f", request: f.request(), index: 0, done: true, updates: [] });
      expect(f.f.synced()).toBe(true);
    } finally {
      f.f.stop();
    }
  });

  it("keeps both directions compatible with legacy snapshots", () => {
    const p = port();
    const h = createReplicationHost({ hostId: "h", channel: p.channel, getState: () => ({ rows: rows(1), theme: "dark" }), replicatedKeys: keys, isCollectionKey: isCollection, applyUpdates: () => {} });
    const f = follower();
    try {
      p.deliver({ type: "hello", from: "f" });
      expect(p.posted[0].type).toBe("snapshot");
      f.deliver(p.posted[0]);
      expect(f.f.synced()).toBe(true);
      expect(f.applied.flat().flatMap((u) => u.upserts ?? [])).toEqual(Object.values(rows(1)));
    } finally {
      h.stop();
      f.f.stop();
    }
  });

  it("cancels old host timers on a replacement request and on stop", async () => {
    const p = port();
    const h = createReplicationHost({ hostId: "h", channel: p.channel, getState: () => ({ rows: rows(900) }), replicatedKeys: keys, isCollectionKey: isCollection, applyUpdates: () => {} });
    p.deliver({ type: "hello", from: "f", snapshotRequest: "old" });
    p.deliver({ type: "hello", from: "f", snapshotRequest: "new" });
    await tick();
    expect(p.posted.filter((m) => m.type === "snapshotChunk" && m.request === "old")).toHaveLength(1);
    h.stop();
    const length = p.posted.length;
    await tick();
    expect(p.posted).toHaveLength(length);
  });

  it("overflow requests a newer snapshot instead of silently losing the buffered tail", () => {
    const inbox = createFollowerInbox<{ hostId: string; seq: number }>(2);
    inbox.onUpdate({ hostId: "h", seq: 1 });
    inbox.onUpdate({ hostId: "h", seq: 2 });
    expect(inbox.onUpdate({ hostId: "h", seq: 3 })).toEqual({ action: "resync" });
    expect(inbox.synced()).toBe(false);
    expect(inbox.onSnapshot({ hostId: "h", seq: 3 })).toEqual({ action: "apply", messages: [] });
  });
});
