import { describe, expect, it } from "bun:test";
import { action, sync } from "./middleware";
import { createLocalFirstStore } from "./store";
import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationChannel,
} from "./replicationRuntime";
import type { ReplicationMessage } from "./replication";
import type { PlatformConfig } from "./types";

// ---------------------------------------------------------------------------
// Harness: an async in-memory broadcast hub (BroadcastChannel-like: in-order,
// microtask-delivered, sender excluded) + a minimal app store on the real
// middleware, so the whole pipeline — action drafts, pending protection,
// patch tee, sync application — is the production code path.
// ---------------------------------------------------------------------------

function createHub() {
  const ports: Array<{ deliver: (msg: ReplicationMessage) => void }> = [];
  let dropNext = 0;
  return {
    dropNextBroadcast() {
      dropNext++;
    },
    channel(): ReplicationChannel {
      const subs = new Set<(msg: ReplicationMessage) => void>();
      const port = {
        deliver(msg: ReplicationMessage) {
          queueMicrotask(() => subs.forEach((cb) => cb(msg)));
        },
      };
      ports.push(port);
      return {
        post(msg) {
          if (dropNext > 0 && msg.type === "update") {
            dropNext--;
            return;
          }
          for (const p of ports) if (p !== port) p.deliver(msg);
        },
        onMessage(cb) {
          subs.add(cb);
          return () => subs.delete(cb);
        },
      };
    },
  };
}

const CONFIG: PlatformConfig = {
  dbName: "test",
  dbVersion: 1,
  registry: {
    sessions: { persistence: { kind: "collection", key: "sessions" }, localFirst: true },
    theme: { persistence: { kind: "meta", key: "theme" } },
  },
  syncRegistry: {
    sessions: { kind: "collection", isDelta: true },
    theme: { kind: "scalar" },
  },
};

const REPLICATED = ["sessions", "theme"];
const isCollection = (k: string) => k === "sessions";

function makeStore() {
  const built = createLocalFirstStore(CONFIG, (_set: any, _get: any) => ({
    sessions: {} as Record<string, any>,
    theme: "dark" as string,
    pending: {} as Record<string, any>,
    // A server feed push (what a live query feeder does).
    feed: sync(function (this: any, rows: any[]) {
      built.syncEngine.syncTable(this, "sessions", rows, { isDelta: true });
    }),
    // Optimistic user gestures.
    rename: action(function (this: any, id: string, title: string) {
      const row = this.sessions[id];
      if (row) row.title = title;
    }),
    createRow: action(function (this: any, id: string) {
      this.sessions[id] = { _id: id, title: "new" };
    }),
    removeRow: action(function (this: any, id: string) {
      delete this.sessions[id];
    }),
    setTheme: action(function (this: any, theme: string) {
      this.theme = theme;
    }),
    // The replication applier every window wires (mirrors the app store's).
    _applyReplication: sync(function (this: any, updates: any[]) {
      for (const u of updates) {
        if (u.hasValue) {
          built.syncEngine.syncTable(this, u.key, u.value, { kind: "scalar" });
          continue;
        }
        if (u.upserts?.length) {
          built.syncEngine.syncTable(this, u.key, u.upserts, { isDelta: true, force: true });
        }
        for (const id of u.removes ?? []) {
          if (this.pending[`${u.key}:${id}`]?.type === "include") continue;
          if (this[u.key]?.[id] !== undefined) delete this[u.key][id];
        }
      }
    }),
  }));
  return built;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

function wireHost(hub: ReturnType<typeof createHub>, id = "host") {
  const store = makeStore();
  const channel = hub.channel();
  const host = createReplicationHost({
    hostId: id,
    channel,
    getState: () => store.useStore.getState(),
    replicatedKeys: REPLICATED,
    isCollectionKey: isCollection,
    applyUpdates: (updates) => (store.useStore.getState() as any)._applyReplication(updates),
  });
  // The host's write-through tee (production wraps the IDB write with this).
  (store.useStore.getState() as any)._setIDBWrite((patches: any[], state: any) => {
    host.tee(patches, state);
  });
  return { store, host };
}

function wireFollower(hub: ReturnType<typeof createHub>, id: string) {
  const store = makeStore();
  const channel = hub.channel();
  const follower = createReplicationFollower({
    selfId: id,
    channel,
    replicatedKeys: REPLICATED,
    isCollectionKey: isCollection,
    applyUpdates: (updates) => (store.useStore.getState() as any)._applyReplication(updates),
    helloRetryMs: 5,
  });
  (store.useStore.getState() as any)._setActionTee(
    (name: string, patches: any[], state: any) => follower.mutTee(name, patches, state),
  );
  return { store, follower };
}

const rows = (s: any) => s.useStore.getState().sessions;

describe("replication runtime", () => {
  it("snapshot on join, then live host feeds converge to followers", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    (h.store.useStore.getState() as any).feed([{ _id: "a", title: "A", updated_at: 1 }]);

    const f = wireFollower(hub, "w2");
    await tick();
    expect(f.follower.synced()).toBe(true);
    expect(rows(f.store).a.title).toBe("A");

    (h.store.useStore.getState() as any).feed([{ _id: "b", title: "B", updated_at: 1 }]);
    await tick();
    expect(rows(f.store).b.title).toBe("B");
    expect(f.store.useStore.getState().theme).toBe("dark");
  });

  it("a follower's optimistic action reaches the host and other followers", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    (h.store.useStore.getState() as any).feed([{ _id: "a", title: "A", updated_at: 1 }]);
    const f1 = wireFollower(hub, "w1");
    const f2 = wireFollower(hub, "w2");
    await tick();

    (f1.store.useStore.getState() as any).rename("a", "renamed");
    await tick();
    await tick();
    expect(rows(h.store).a.title).toBe("renamed");
    expect(rows(f2.store).a.title).toBe("renamed");
    // Origin keeps its pending field lock (its echo was skipped).
    expect(f1.store.useStore.getState().pending["sessions:a:title"]?.type).toBe("field");
    // Host applied the mut bare: no pending lock there.
    expect(h.store.useStore.getState().pending["sessions:a:title"]).toBeUndefined();
  });

  it("origin pending survives a stale broadcast; echo retires it", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    (h.store.useStore.getState() as any).feed([{ _id: "a", title: "old", updated_at: 1 }]);
    const f = wireFollower(hub, "w1");
    await tick();

    (f.store.useStore.getState() as any).rename("a", "mine");
    // A stale feed push on the host (pre-write server state) must not clobber
    // the origin's optimistic value.
    (h.store.useStore.getState() as any).feed([{ _id: "a", title: "old", updated_at: 1 }]);
    await tick();
    await tick();
    expect(rows(f.store).a.title).toBe("mine");
    // The echo (server accepted the write) retires the lock everywhere.
    (h.store.useStore.getState() as any).feed([{ _id: "a", title: "mine", updated_at: 2 }]);
    await tick();
    expect(rows(f.store).a.title).toBe("mine");
    expect(f.store.useStore.getState().pending["sessions:a:title"]).toBeUndefined();
  });

  it("row creation and removal propagate both directions", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    const f = wireFollower(hub, "w1");
    await tick();

    (f.store.useStore.getState() as any).createRow("n1");
    await tick();
    await tick();
    expect(rows(h.store).n1.title).toBe("new");

    (h.store.useStore.getState() as any).removeRow("n1");
    await tick();
    // Origin's include-pending keeps its optimistic row until the server
    // acknowledges; a peer's delete does not tear it out from under it.
    expect(rows(f.store).n1).toBeDefined();

    // A host-side removal of an ordinary row does reach followers.
    (h.store.useStore.getState() as any).feed([{ _id: "x", title: "X", updated_at: 1 }]);
    await tick();
    expect(rows(f.store).x).toBeDefined();
    (h.store.useStore.getState() as any).removeRow("x");
    await tick();
    expect(rows(f.store).x).toBeUndefined();
  });

  it("scalar keys replicate", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    const f = wireFollower(hub, "w1");
    await tick();
    (h.store.useStore.getState() as any).setTheme("light");
    await tick();
    expect(f.store.useStore.getState().theme).toBe("light");

    (f.store.useStore.getState() as any).setTheme("solarized");
    await tick();
    await tick();
    expect(h.store.useStore.getState().theme).toBe("solarized");
  });

  it("a dropped broadcast forces resync and the follower still converges", async () => {
    const hub = createHub();
    const h = wireHost(hub);
    const f = wireFollower(hub, "w1");
    await tick();
    expect(f.follower.synced()).toBe(true);

    hub.dropNextBroadcast();
    (h.store.useStore.getState() as any).feed([{ _id: "lost", title: "L", updated_at: 1 }]);
    (h.store.useStore.getState() as any).feed([{ _id: "next", title: "N", updated_at: 1 }]);
    await tick();
    await tick(); // hello retry (5ms) + snapshot
    await new Promise((r) => setTimeout(r, 15));
    expect(f.follower.synced()).toBe(true);
    expect(rows(f.store).lost?.title).toBe("L");
    expect(rows(f.store).next?.title).toBe("N");
  });

  it("host restart (new hostId) resyncs followers", async () => {
    const hub = createHub();
    const h1 = wireHost(hub, "h1");
    (h1.store.useStore.getState() as any).feed([{ _id: "a", title: "A", updated_at: 1 }]);
    const f = wireFollower(hub, "w1");
    await tick();
    expect(rows(f.store).a).toBeDefined();

    h1.host.stop();
    const h2 = wireHost(hub, "h2");
    (h2.store.useStore.getState() as any).feed([
      { _id: "a", title: "A", updated_at: 1 },
      { _id: "b", title: "B", updated_at: 1 },
    ]);
    await tick();
    await new Promise((r) => setTimeout(r, 15));
    expect(f.follower.synced()).toBe(true);
    expect(rows(f.store).b?.title).toBe("B");
  });
});
