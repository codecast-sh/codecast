import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createReplicationHost } from "@platform/engine";

// A window that boots beside a living host must not write the shared slice
// while it waits to learn its role. On 2026-11-14 every new desktop window
// rewrote the whole cache (100 to 220 MB a burst) as its feeders and the
// host's snapshot landed through full write-through, and outbox writes queued
// behind those bursts tripped "Local storage is not keeping up".

const writes: Array<Array<{ path: Array<string | number> }>> = [];
const realCache = { ...(await import("../idbCache")) };
mock.module("../idbCache", () => ({
  ...realCache,
  writePatchesToIDB: (patches: any[]) => { writes.push(patches); },
}));
const { replicationChannelName, replicationTransport, startSyncReplication, stopSyncReplication } = await import("../syncReplication");
const { useInboxStore } = await import("../inboxStore");
const { writePatchesToIDB } = await import("../idbCache");

const sharedKeysWritten = () => writes.flat().map((p) => String(p.path[0])).filter((k) => k === "sessions");

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

describe("a window's writes before its role is known", () => {
  const g = globalThis as any;
  let saved: Record<string, unknown>;
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const sessionPatch = (id: string) => [{ op: "replace", path: ["sessions", id], value: { _id: id, title: id } }];

  function install(grantLock: boolean) {
    const hub = makeHub({ grantLock });
    saved = { window: g.window, BroadcastChannel: g.BroadcastChannel, navigator: g.navigator };
    g.window = g.window ?? globalThis;
    g.BroadcastChannel = hub.FakeBroadcastChannel;
    g.navigator = { ...(g.navigator ?? {}), locks: hub.lockManager };
  }
  // The writer the window has installed right now.
  let installed: ((patches: any[], state: any) => unknown) | null = null;
  beforeEach(() => {
    writes.length = 0;
    installed = null;
    const real = (useInboxStore.getState() as any)._setIDBWrite;
    useInboxStore.setState({ _setIDBWrite: (fn: any) => { installed = fn; real?.(fn); } } as any);
    // As hydration leaves every window: full write-through.
    (useInboxStore.getState() as any)._setIDBWrite(writePatchesToIDB);
  });
  afterEach(() => {
    stopSyncReplication();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k]; else g[k] = v;
    }
  });

  it("beside a living host: the host's snapshot is applied without writing the shared slice", async () => {
    install(false);
    const name = replicationChannelName("userA");
    const hostTransport = replicationTransport(name, "hostX");
    const hostState: any = { sessions: { s1: { _id: "s1", title: "from the host" } } };
    const host = createReplicationHost({
      hostId: "hostX",
      channel: hostTransport.channel,
      getState: () => hostState,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: () => {},
    });
    startSyncReplication({ eligible: true, principalId: "userA" });
    // A feeder push before the snapshot lands: skipped, not written.
    installed!(sessionPatch("early"), useInboxStore.getState());
    await settle();
    expect(useInboxStore.getState().syncRole).toBe("follower");
    expect((useInboxStore.getState() as any).sessions?.s1?.title).toBe("from the host");
    expect(sharedKeysWritten()).toEqual([]);
    // Settled as a follower, nothing skipped is owed: the host persists it.
    installed!(sessionPatch("later"), useInboxStore.getState());
    expect(sharedKeysWritten()).toEqual([]);
    host.stop();
    hostTransport.close();
  });

  it("elected host: what was skipped before the election is written once, straight to disk", async () => {
    install(true);
    startSyncReplication({ eligible: true, principalId: "userA" });
    installed!(sessionPatch("early"), useInboxStore.getState());
    expect(sharedKeysWritten()).toEqual([]);
    await settle();
    // One whole-collection write for the skipped key, diffed against disk.
    const catchUp = writes.filter((batch) => batch.some((p) => p.path[0] === "sessions"));
    expect(catchUp).toHaveLength(1);
    expect(catchUp[0]).toEqual([expect.objectContaining({ op: "replace", path: ["sessions"] })]);
    // From here the host writes through as before.
    installed!(sessionPatch("after"), useInboxStore.getState());
    expect(sharedKeysWritten()).toEqual(["sessions", "sessions"]);
  });
});
