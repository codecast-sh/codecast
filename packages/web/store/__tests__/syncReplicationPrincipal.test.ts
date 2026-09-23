import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createReplicationFollower, createReplicationHost, type ReplicationChannel, type ReplicationMessage } from "@platform/engine";
import { replicationChannelName, replicationLockName, startSyncReplication, stopSyncReplication } from "../syncReplication";
import { useInboxStore } from "../inboxStore";

// Replication is scoped to the account a window acts for: channel and lock
// names carry the principal, so a host and its followers share one account
// by construction and a window that signed in as someone else hears nothing
// from the previous account's host.

describe("replication names", () => {
  it("carry the principal", () => {
    expect(replicationChannelName("userA")).toBe("codecast-replication-v1:userA");
    expect(replicationLockName("userA")).toBe("codecast-sync-host:userA");
    expect(replicationChannelName("userA")).not.toBe(replicationChannelName("userB"));
  });
});

// A BroadcastChannel-like hub: channels with the same name see each other's
// posts, a closed channel neither sends nor receives.
function makeHub() {
  const opened: string[] = [];
  const locks: string[] = [];
  const members = new Map<string, Set<(e: MessageEvent) => void>>();
  class FakeBroadcastChannel {
    private own = new Set<(e: MessageEvent) => void>();
    private closed = false;
    constructor(public name: string) { opened.push(name); }
    postMessage(data: unknown) {
      if (this.closed) return;
      for (const fn of members.get(this.name) ?? []) {
        if (this.own.has(fn)) continue;
        queueMicrotask(() => fn({ data: structuredClone(data) } as MessageEvent));
      }
    }
    addEventListener(_t: string, fn: (e: MessageEvent) => void) {
      this.own.add(fn);
      if (!members.has(this.name)) members.set(this.name, new Set());
      members.get(this.name)!.add(fn);
    }
    removeEventListener(_t: string, fn: (e: MessageEvent) => void) {
      this.own.delete(fn);
      members.get(this.name)?.delete(fn);
    }
    close() {
      this.closed = true;
      for (const fn of this.own) members.get(this.name)?.delete(fn);
      this.own.clear();
    }
  }
  const lockManager = {
    request: (name: string, _opts: unknown, cb: () => unknown) => {
      locks.push(name);
      return Promise.resolve().then(() => cb());
    },
  };
  return { opened, locks, FakeBroadcastChannel, lockManager };
}

describe("startSyncReplication", () => {
  const g = globalThis as any;
  let saved: Record<string, unknown>;
  let hub: ReturnType<typeof makeHub>;
  beforeEach(() => {
    hub = makeHub();
    saved = { window: g.window, BroadcastChannel: g.BroadcastChannel, navigator: g.navigator };
    g.window = g.window ?? globalThis;
    g.BroadcastChannel = hub.FakeBroadcastChannel;
    g.navigator = { ...(g.navigator ?? {}), locks: hub.lockManager };
  });
  afterEach(() => {
    stopSyncReplication();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  });

  it("does nothing for a window with no account", () => {
    const stop = startSyncReplication({ eligible: true, principalId: null });
    expect(hub.opened).toEqual([]);
    expect(hub.locks).toEqual([]);
    expect(useInboxStore.getState().syncRole).toBe("host");
    stop();
  });

  it("opens the account's channel and requests the account's lock", async () => {
    startSyncReplication({ eligible: true, principalId: "userA" });
    await new Promise((r) => setTimeout(r, 0));
    expect(hub.opened).toEqual(["codecast-replication-v1:userA"]);
    expect(hub.locks).toEqual(["codecast-sync-host:userA"]);
    expect((window as any).__syncReplication().principalId).toBe("userA");
  });

  it("stopSyncReplication ends the old account's transport and leaves the window a host", async () => {
    startSyncReplication({ eligible: false, principalId: "userA" });
    stopSyncReplication();
    // A fresh start for the next account opens that account's channel, not the old one.
    startSyncReplication({ eligible: false, principalId: "userB" });
    expect(hub.opened).toEqual(["codecast-replication-v1:userA", "codecast-replication-v1:userB"]);
    expect(useInboxStore.getState().syncRole).toBe("host");
  });
});

// Two windows on the engine runtimes: a host for account A, a follower that
// signed in as account B. Distinct channel names mean the follower never
// syncs from A's host, and a late message from A's host after the follower
// re-keyed lands nowhere because its old channel is closed.
describe("host and follower of different accounts", () => {
  function channelFor(hub: ReturnType<typeof makeHub>, name: string): { channel: ReplicationChannel; bc: InstanceType<typeof hub.FakeBroadcastChannel> } {
    const bc = new hub.FakeBroadcastChannel(name);
    return {
      bc,
      channel: {
        post: (msg: ReplicationMessage) => bc.postMessage(msg),
        onMessage: (cb) => {
          const handler = (e: MessageEvent) => cb(e.data);
          bc.addEventListener("message", handler);
          return () => bc.removeEventListener("message", handler);
        },
      },
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("never sync, and a follower that switches accounts drops the old host's stream", async () => {
    const hub = makeHub();
    const state = { sessions: { s1: { _id: "s1", title: "account A's row" } } };
    const hostA = createReplicationHost({
      hostId: "hostA",
      channel: channelFor(hub, replicationChannelName("userA")).channel,
      getState: () => state,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: () => {},
    });
    const appliedB: unknown[] = [];
    const followerB = createReplicationFollower({
      selfId: "winB",
      channel: channelFor(hub, replicationChannelName("userB")).channel,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: (u) => appliedB.push(u),
      helloRetryMs: 1,
    });
    await settle();
    expect(followerB.synced()).toBe(false);
    expect(appliedB).toEqual([]);

    // The same window as account A does sync, so the test proves scoping, not a dead harness.
    const appliedA: unknown[] = [];
    const winOnA = channelFor(hub, replicationChannelName("userA"));
    const followerA = createReplicationFollower({
      selfId: "winA",
      channel: winOnA.channel,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: (u) => appliedA.push(u),
      helloRetryMs: 1,
    });
    await settle();
    expect(followerA.synced()).toBe(true);
    expect(JSON.stringify(appliedA)).toContain("account A's row");

    // That window signs in as account B: its old channel closes with its follower.
    followerA.stop();
    winOnA.bc.close();
    const before = appliedA.length;
    state.sessions = { s2: { _id: "s2", title: "late row from A" } } as any;
    hostA.tee([{ op: "replace", path: ["sessions"], value: state.sessions }] as any, state);
    await settle();
    expect(appliedA.length).toBe(before);
    followerB.stop();
    hostA.stop();
  });
});
