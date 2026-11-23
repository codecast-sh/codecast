import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

// A sync host with no follower posts nothing: one window alone used to diff
// and post ~260 replication messages a minute to nobody. Followers say they
// are here; a host that hears nobody for a while stops its runtime, and each
// time it starts again it does so under a new hostId and says so, so a
// follower that slept through the quiet takes a fresh snapshot.
const { replicationChannelName, replicationTransport, startSyncReplication, stopSyncReplication } = await import("../syncReplication");
const { useInboxStore } = await import("../inboxStore");

function makeHub(opts: { grantLock: boolean }) {
  const members = new Map<string, Set<(e: MessageEvent) => void>>();
  class FakeBroadcastChannel {
    private own = new Set<(e: MessageEvent) => void>();
    private closed = false;
    constructor(public name: string) {}
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
    // Another window holds the lock unless the hub grants it.
    request: (_name: string, _o: unknown, cb: () => unknown) => (opts.grantLock ? Promise.resolve().then(() => cb()) : new Promise(() => {})),
  };
  return { FakeBroadcastChannel, lockManager };
}

describe("a sync host with no follower", () => {
  const g = globalThis as any;
  let saved: Record<string, unknown>;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  let write: ((patches: any[], state: any) => unknown) | null = null;
  const touch = (id: string) => write!([{ op: "replace", path: ["sessions", id], value: { _id: id, title: id } }], useInboxStore.getState());

  beforeEach(() => {
    jest.useFakeTimers();
    const hub = makeHub({ grantLock: true });
    saved = { window: g.window, BroadcastChannel: g.BroadcastChannel, navigator: g.navigator };
    g.window = g.window ?? globalThis;
    g.BroadcastChannel = hub.FakeBroadcastChannel;
    g.navigator = { ...(g.navigator ?? {}), locks: hub.lockManager };
    write = null;
    useInboxStore.setState({ _setIDBWrite: (fn: any) => { write = fn; } } as any);
  });
  afterEach(() => {
    stopSyncReplication();
    jest.useRealTimers();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  });

  it("goes quiet when nobody follows, and wakes under a new hostId for the next follower", async () => {
    const name = replicationChannelName("userA");
    const ear = replicationTransport(name, "ear");
    const heard: any[] = [];
    ear.channel.onMessage((m) => heard.push(m));
    startSyncReplication({ eligible: true, principalId: "userA" });
    await flush();
    expect(useInboxStore.getState().syncRole).toBe("host");
    const first = heard.find((m) => m.type === "update")?.hostId;
    expect(first).toBeDefined();
    touch("a");
    await flush();
    expect(heard.filter((m) => m.type === "update" && m.seq > 0)).toHaveLength(1);

    jest.advanceTimersByTime(181_000);
    heard.length = 0;
    for (const id of ["b", "c", "d"]) touch(id);
    await flush();
    expect(heard).toEqual([]);

    ear.channel.post({ type: "present", from: "ear" } as any);
    await flush();
    const woke = heard.find((m) => m.type === "update");
    expect(woke.hostId).not.toBe(first);
    expect(woke.seq).toBe(0);
    touch("e");
    await flush();
    expect(heard.filter((m) => m.type === "update" && m.seq > 0).map((m) => m.hostId)).toEqual([woke.hostId]);
    ear.close();
  });

  it("answers the hello that wakes it with a snapshot, without waiting for a retry", async () => {
    const name = replicationChannelName("userA");
    startSyncReplication({ eligible: true, principalId: "userA" });
    await flush();
    jest.advanceTimersByTime(181_000);
    const ear = replicationTransport(name, "late");
    const heard: any[] = [];
    ear.channel.onMessage((m) => heard.push(m));
    ear.channel.post({ type: "hello", from: "late", snapshotRequest: "late:1" } as any);
    await flush();
    expect(heard.some((m) => (m.type === "snapshotChunk" || m.type === "snapshot") && m.to === "late")).toBe(true);
    ear.close();
  });
});
