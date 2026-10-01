// Window and device self-test (docs/architecture/multiplayer-sim-harness.md,
// unit U9): a window boots to the server's own projection, a follower joins
// through a chunked snapshot under live writes, a follower's gesture reaches
// the server and its acknowledgement retires the lock, each window keeps its
// own engine closure, and a dropped response is settled once by the server's
// dedupe when the window comes back online.
//
// The fixture builds only what a window needs (backend, net, realm). The full
// world, with genesis through real mutations, is sim/world.ts.

import { afterEach, describe, expect, test } from "bun:test";
import { inboxEpoch } from "@codecast/shared/contracts";
import { convexIdFor } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { genTeamWorld } from "@codecast/shared/contracts/__fixtures__/teamWorldGen";
import { makeSimBackend } from "@codecast/convex/convex/simBackend.testing";
import { snapshotEntries } from "@platform/engine";
import { useInboxStore } from "../../../inboxStore";
import { REPLICATED_STORE_KEYS } from "../../../clientSyncRegistry";
import { syncMetaKey } from "../../../../hooks/reconcileCrawl";
import { inboxCrawlWsKey } from "../../../../hooks/useSyncInboxSessions";
import { Net, type Delivery } from "../net";
import { advance, attachRealm, installRealm, now, stream, uninstallRealm } from "../realm";
import { SimDevice } from "../device";
import { windowOnline, type SimWindow, type SimWindowWorld } from "../window";

type Fixture = SimWindowWorld & {
  userId: string;
  /** Every delivery, in run order. */
  events: Delivery[];
  /** Called with each delivery just before it runs. */
  taps: ((d: Delivery) => void)[];
  device: (name: string) => SimDevice;
};

function fixture(seed: number, rows = 24): Fixture {
  installRealm(seed);
  const gen = genTeamWorld({ users: ["ada"], teams: [], rowsPerUser: rows, seed, epoch: inboxEpoch(now()) });
  const userId = gen.users[0]._id;
  const tables: Record<string, any[]> = {
    users: gen.users,
    teams: gen.teams,
    team_memberships: gen.team_memberships,
    ...gen.perUser.ada,
    messages: [],
    pending_messages: [],
    inbox_hides: [],
  };
  const events: Delivery[] = [];
  const taps: ((d: Delivery) => void)[] = [];
  const windows = new Map<string, SimWindow>();
  let net!: Net;
  const backend = makeSimBackend({
    tables,
    now,
    rngFor: (seq) => stream(`call:${seq}`),
    mintId: (table, n) => convexIdFor(`${table}:${n}`),
    onSchedule: (job) =>
      net.enqueue("sched", { due: job.due, label: job.name, producer: `sched ${job.name}`, run: () => backend.runScheduled(job) }),
  });
  const world: Fixture = {
    backend,
    get net() {
      return net;
    },
    windows,
    userId,
    events,
    taps,
    device: (name) => new SimDevice(world, { userId }, name),
  };
  net = new Net({
    rng: stream("net"),
    writes: backend.writes,
    now,
    advance,
    onOnline: (win) => windowOnline(world, win),
    onDeliver: (d) => {
      events.push(d);
      for (const tap of taps) tap(d);
    },
  });
  attachRealm({ timers: net, serverCall: () => backend.activeCall() });
  return world;
}

const lockKeys = (w: SimWindow, id: string) => Object.keys(w.store.getState().pending).filter((k) => k.includes(id));

// A top-level row the window shows in an active bucket: one a person can act on.
async function actionable(w: SimWindow): Promise<string[]> {
  const placed = await w.placed();
  const sessions = w.store.getState().sessions as Record<string, any>;
  return [...placed.placements]
    .filter(([id, p]) => p.bucket !== "dismissed" && p.bucket !== "stashed" && !sessions[id]?.parent_conversation_id && !sessions[id]?.is_subagent)
    .map(([id]) => id)
    .sort();
}

function sentOn(f: Fixture, channel: string, label: RegExp): Delivery[] {
  return f.events.filter((d) => d.channel === channel && label.test(d.label));
}

afterEach(() => uninstallRealm());

describe("sim window and device", () => {
  test("a host window boots to the server's own projection of its inbox", async () => {
    const f = fixture(11);
    const dev = await f.device("A").start();
    const host = dev.host;
    expect(host.errors).toEqual([]);

    // The floor ran after catch-up stamped the log (its gate), and the cursor sits at the head.
    const state = host.store.getState();
    expect(state.syncMeta[syncMetaKey("sessions", inboxCrawlWsKey(f.userId))]?.backfilledAt).toBeNumber();
    expect(state.syncLogScopeStamps[`user:${f.userId}`]).toBeDefined();

    const placed = await host.placed();
    const canonical = await f.backend.clientFor({ kind: "user", userId: f.userId }).query("conversations:sessionsLiveness", {});
    expect(placed.placements.size).toBeGreaterThan(0);
    expect(placed.set_digest).toBe(canonical.projection.set_digest);
    expect(placed.tally).toEqual(canonical.projection.tally);
  });

  test("a follower completes a chunked snapshot while a live write lands between chunks", async () => {
    const f = fixture(21);
    const dev = await f.device("A").start();
    const host = dev.host;
    const target = host.store.getState().liveInboxIdList[0];
    expect(target).toBeString();

    // The moment the first chunk reaches the follower, another device renames a row.
    let wrote = false;
    f.taps.push((d) => {
      if (wrote || d.channel !== "repl:A-host>A-w1" || !/^snapshotChunk 0 /.test(d.label)) return;
      wrote = true;
      void f.backend.db.patch(target, { title: "renamed between chunks" });
    });
    const follower = await dev.addWindow("follower");

    const toFollower = f.events.filter((d) => d.channel === "repl:A-host>A-w1").map((d) => d.label);
    const first = toFollower.findIndex((l) => /^snapshotChunk 0 /.test(l));
    const last = toFollower.findIndex((l) => /^snapshotChunk \d+ \(last\)/.test(l));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first + 1); // more than one chunk
    expect(toFollower.slice(first, last).some((l) => l.startsWith("update "))).toBe(true);

    expect(dev.synced(follower)).toBe(true);
    expect(follower.errors).toEqual([]);
    expect((follower.store.getState().sessions as any)[target].title).toBe("renamed between chunks");
    expect(snapshotEntries(follower.store.getState(), REPLICATED_STORE_KEYS)).toEqual(
      snapshotEntries(host.store.getState(), REPLICATED_STORE_KEYS),
    );
  });

  test("a follower's kill replicates to the host, reaches dispatch:dispatch, and the ack retires the lock", async () => {
    const f = fixture(31);
    const dev = await f.device("A").start({ followers: 1 });
    const [host, follower] = [dev.host, dev.followers[0]];
    const id = (await actionable(follower))[0];
    expect(id).toBeString();

    await follower.run(() => useInboxStore.getState().killSession(id));
    expect(lockKeys(follower, id).length).toBeGreaterThan(0);
    // The response carries the log position the write landed at; the follower
    // stamps it on the lock that write created.
    for (;;) {
      const d = await f.net.step();
      if (!d) throw new Error("the kill never got a response");
      if (d.channel === follower.conn && d.label.startsWith("res dispatch:dispatch")) break;
    }
    const lock = (follower.store.getState().pending as Record<string, any>)[`conversations:${id}:inbox_dismissed_at`];
    expect(lock?.ack).toEqual([{ s: `user:${f.userId}`, p: expect.any(Number) }]);
    await f.net.drain();

    expect(sentOn(f, "repl:A-w1>A-host", /^mut from A-w1/).length).toBeGreaterThan(0);
    expect(sentOn(f, "conn:A-w1", /^req mutation dispatch:dispatch/).length).toBe(1);
    expect(f.backend.calls.filter((c) => c.name === "dispatch:dispatch" && c.ok)).toHaveLength(1);
    const row = f.backend.db._tables.conversations.find((c: any) => c._id === id);
    expect(row.inbox_killed_at).toBeNumber();

    // The acting window's locks retire through its acknowledgement.
    expect(lockKeys(follower, id)).toEqual([]);
    // The host mirrored the gesture (bridge hide plus the follower's mut) and
    // holds no acknowledged lock. Its mirrors for fields the follower never
    // dispatched (the stash fields, the sessions twins) take no ack and, with
    // values that already match the server, no echo either; on a host only
    // the digest comparer's heal releases a settled lock. That is production
    // behaviour, and INV-pending-locks is where it is judged.
    const hostPending = host.store.getState().pending as Record<string, any>;
    expect(lockKeys(host, id).filter((k) => hostPending[k]?.ack)).toEqual([]);
    for (const w of [host, follower]) {
      expect({ window: w.name, shown: (await actionable(w)).includes(id) }).toEqual({ window: w.name, shown: false });
      expect(w.outbox.size).toBe(0);
      expect(w.errors).toEqual([]);
    }
  });

  test("two windows of one device keep distinct outbox closures", async () => {
    const f = fixture(41);
    const dev = await f.device("A").start({ followers: 1 });
    const [host, follower] = [dev.host, dev.followers[0]];
    const [a, b] = await actionable(host);

    f.net.offline(follower.name);
    await follower.run(() => useInboxStore.getState().pinSession(a));
    await f.net.drain();
    expect(follower.outbox.size).toBe(1);
    expect(f.backend.calls.filter((c) => c.name === "dispatch:dispatch")).toHaveLength(0);

    // The host's engine is its own: wired, nothing parked, and its writes land.
    expect((host.store.getState() as any)._isDispatchWired()).toBe(true);
    expect(host.outbox.size).toBe(0);
    await host.run(() => useInboxStore.getState().pinSession(b));
    await f.net.drain();
    expect(host.outbox.size).toBe(0);
    expect(follower.outbox.size).toBe(1);
    const conv = (id: string) => f.backend.db._tables.conversations.find((c: any) => c._id === id);
    expect(conv(b).inbox_pinned_at).toBeNumber();
    expect(conv(a).inbox_pinned_at ?? null).not.toBe(conv(b).inbox_pinned_at);

    f.net.online(follower.name);
    await f.net.drain();
    expect(follower.outbox.size).toBe(0);
    expect(conv(a).inbox_pinned_at).toBeNumber();
    expect([host.errors, follower.errors]).toEqual([[], []]);
  });

  test("a dropped response plus online() delivers exactly once, through the server receipt", async () => {
    const f = fixture(51);
    const dev = await f.device("A").start();
    const host = dev.host;
    const id = (await actionable(host))[0];
    const clientId = "sim-send-1";
    const rows = () => f.backend.db._tables.pending_messages.filter((m: any) => m.client_id === clientId);

    host.dropResponse(1);
    await host.run(() => useInboxStore.getState().sendMessage(id, "hello from the sim", undefined, clientId));
    // Run until the first response arrives (and is dropped), then lose the connection.
    for (;;) {
      const d = await f.net.step();
      if (!d) throw new Error("the send never got a response");
      if (d.channel === host.conn && d.label.startsWith("res dispatch:dispatch")) break;
    }
    expect(rows()).toHaveLength(1);
    f.net.offline(host.name);
    await f.net.drain(); // the retry ladder re-sends; the request waits on the dead connection
    expect(host.outbox.size).toBe(1);
    expect(sentOn(f, host.conn, /^req mutation dispatch:dispatch/)).toHaveLength(1);

    f.net.online(host.name);
    await f.net.drain();
    const sends = f.backend.calls.filter((c) => c.name === "dispatch:dispatch");
    expect(sends.map((c) => c.ok)).toEqual([true, true]); // delivered twice
    expect(rows()).toHaveLength(1); // written once
    expect(host.outbox.size).toBe(0);
    expect(host.store.getState().lastDispatchFailure ?? null).toBeNull();
    expect(host.errors).toEqual([]);
  });
});
