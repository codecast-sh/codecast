import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";
import {
  Device,
  GEN_DAY,
  GEN_HOUR,
  GEN_MIN,
  Replica,
  SERVER_EVENTS,
  SimServer,
  advance,
  bootDevice,
  bootReplica,
  installSim,
  makeRng,
  newConversation,
  now,
  pickHidden,
  pickShown,
  resetClock,
  seededWorld,
  settleAndAssertConverged,
  uninstallSim,
} from "./inboxSimHarness";

// Real Convex compute over dozens of rows, hundreds of steps: never a 5s test.
setDefaultTimeout(120_000);

// THE MULTI-WINDOW, MULTI-DEVICE SIMULATION — the eventual-consistency proof
// for the sync-host model (docs/architecture/sync-host.md) with the client
// reconcile crawls gone (ct-47927).
//
// The claim: the sync log is the only healer a replica needs for inbox hide
// state. Whatever order gestures, replication, bridge messages, payloads,
// ranges, retention and reconnects arrive in, at quiescence every host holds
// the canonical projection and every follower renders exactly what its host
// renders. In particular a kill made in a FOLLOWER window — the one window
// model where the pending lock and the feeders live in different windows —
// never comes back.

beforeEach(installSim);
afterEach(uninstallSim);

// Rows every window on the device shows and the live window carries: what a
// user can click on, and what a stale push could bring back.
const visibleIds = async (server: SimServer, ...devices: Device[]): Promise<string[]> => {
  const live = new Set((await server.base()).sessions.map((s: any) => String(s._id)));
  const shown = devices.flatMap((d) => d.windows).map((w) => new Set(w.visibleIds()));
  return [...live].filter((id) => shown.every((s) => s.has(id)) && !server.conv(id).inbox_pinned_at).sort();
};

const everyWindow = (devices: Device[]): Replica[] => devices.flatMap((d) => d.windows);

/** Per window: whether `id` is out of every active bucket. */
const hiddenEverywhere = (windows: Replica[], id: string): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const w of windows) out[w.name] = !w.shows(id);
  return out;
};
/** Per window: whether `id` is gone from the rendered set entirely (killed). */
const goneEverywhere = (windows: Replica[], id: string): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const w of windows) out[w.name] = !w.membership().includes(id);
  return out;
};

describe("a kill from a follower window stays killed", () => {
  it("survives the host's replication echo, a stale live push and the log catch-up, in every window on both devices", async () => {
    const server = new SimServer(seededWorld(71));
    const A = await bootDevice(server, "A", 1, 1);
    const B = await bootDevice(server, "B", 2, 1);
    const [q, p] = await visibleIds(server, A, B);
    const w1 = A.followers[0];

    // A live push captured BEFORE the gesture — the window's subscription
    // result still in flight when the user clicks.
    const stale = await server.base();
    expect(stale.sessions.some((s: any) => s._id === q && !s.inbox_dismissed_at)).toBe(true);

    // The follower kills q: its own store hides the row at once, the bridge
    // announces it, the mut offers it to the host. Nothing delivered yet.
    await w1.kill(q);
    expect(w1.shows(q)).toBe(false);
    expect(A.host.shows(q)).toBe(true);
    expect(A.pendingDeliveries()).toBeGreaterThan(0);

    // Bridge, then mut: the host plants the lock, then applies the follower's
    // rows — the value echo must not strip the lock while the server has not
    // yet answered.
    await A.deliver();
    expect(A.host.shows(q)).toBe(false);

    // The stale live push lands on the host after the gesture. Without a lock
    // it would re-show q; the lock the bridge planted must hold it hidden.
    await A.host.withStore(() => useInboxStore.getState().syncTable("sessions", stale.sessions as unknown as InboxSession[]));
    expect(hiddenEverywhere(A.windows, q)).toEqual({ "A-host": true, "A-w1": true });

    // The host's ordinary feeds: the live window (which never carries a
    // killed row) and the log (which carries the kill, and the server's
    // retired marker with it). Then replication fans the outcome to the
    // follower: the row is now gone from both, not merely dismissed.
    await A.host.receiveAll();
    await A.drain();
    expect(goneEverywhere(A.windows, q)).toEqual({ "A-host": true, "A-w1": true });

    // Device B learns the same way: log first, then its follower.
    await B.host.receiveAll();
    await B.drain();
    expect(goneEverywhere(everyWindow([A, B]), q)).toEqual({ "A-host": true, "A-w1": true, "B-host": true, "B-w1": true });

    // A pin from B's follower rides the same paths the other way.
    await B.followers[0].pin(p);
    await B.drain();
    await A.host.receiveAll();
    await A.drain();
    for (const w of everyWindow([A, B])) expect({ w: w.name, pinned: (w.state.sessions as any)[p]?.is_pinned }).toEqual({ w: w.name, pinned: true });

    await settleAndAssertConverged(server, everyWindow([A, B]));
    expect(goneEverywhere(everyWindow([A, B]), q)).toEqual({ "A-host": true, "A-w1": true, "B-host": true, "B-w1": true });
  });

  it("a restore elsewhere reaches every window through the log, never through a crawl", async () => {
    const server = new SimServer(seededWorld(72));
    const A = await bootDevice(server, "A", 1, 1);
    const B = await bootDevice(server, "B", 2, 0);
    const [q] = await visibleIds(server, A, B);
    await A.followers[0].kill(q);
    await A.drain();
    await B.host.receiveAll();
    expect(B.host.shows(q)).toBe(false);
    // B restores it (the /sessions page, another device).
    await B.host.restore(q);
    expect(B.host.shows(q)).toBe(true);
    // A's lock on the kill is still inside its settle window; the restore's
    // log position is above the kill's, so it lands regardless.
    advance(GEN_MIN);
    await A.host.receiveAll();
    await A.drain();
    expect(hiddenEverywhere(A.windows, q)).toEqual({ "A-host": false, "A-w1": false });
    await settleAndAssertConverged(server, everyWindow([A, B]));
  });
});

describe("randomized interleavings across four windows on two devices", () => {
  it("any order of gestures, replication, bridge messages, payloads, ranges, floors, retention, reconnects and epoch ticks converges", async () => {
    // Replay one seed with SIM_SEEDS=25 (comma separated).
    const seeds = process.env.SIM_SEEDS ? process.env.SIM_SEEDS.split(",").map(Number) : [81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92];
    const healedSeeds: string[] = [];
    for (const seed of seeds) {
      resetClock();
      installSim();
      const server = new SimServer(seededWorld(seed));
      const A = await bootDevice(server, `A${seed}`, seed, 1);
      const B = await bootDevice(server, `B${seed}`, seed + 100, 1);
      const devices = [A, B];
      const windows = everyWindow(devices);
      const hosts = devices.map((d) => d.host);
      const rng = makeRng(seed * 7);
      const eventNames = Object.keys(SERVER_EVENTS);
      for (let step = 0; step < 80; step++) {
        const roll = rng();
        const w = windows[Math.floor(rng() * windows.length)];
        const h = hosts[Math.floor(rng() * hosts.length)];
        const d = devices[Math.floor(rng() * devices.length)];
        const target = pickShown(w, rng);
        const hidden = pickHidden(w, rng);
        if (roll < 0.22) {
          SERVER_EVENTS[eventNames[Math.floor(rng() * eventNames.length)]](server, rng, step);
        } else if (roll < 0.3 && target) {
          await w.pin(target);
        } else if (roll < 0.36 && target) {
          await w.kill(target);
        } else if (roll < 0.41 && target) {
          await w.stash(target);
        } else if (roll < 0.45 && hidden) {
          await w.restore(hidden);
        } else if (roll < 0.49 && target) {
          await w.revive(target);
        } else if (roll < 0.53 && target) {
          await w.setQueued(target, true);
        } else if (roll < 0.56 && target) {
          await w.focus(target);
        } else if (roll < 0.6) {
          h.online = !h.online;
        } else if (roll < 0.66) {
          await h.receiveBase();
        } else if (roll < 0.72) {
          await h.receiveOverlay();
        } else if (roll < 0.78) {
          await h.catchUp();
        } else if (roll < 0.8) {
          await h.crawl();
        } else if (roll < 0.83) {
          // Retention passes some replica's cursor while it is away.
          server.retain(Math.floor(server.head() * rng()));
        } else if (roll < 0.93) {
          // Deliver some — not all — of a device's queued messages, so bridge
          // and replication interleave with feeds and gestures.
          await d.deliver(1 + Math.floor(rng() * 3));
        } else {
          advance([15_000, GEN_MIN, 5 * GEN_MIN, GEN_HOUR][Math.floor(rng() * 4)]);
        }
        if (rng() < 0.5) advance(Math.floor(rng() * 20_000));
      }
      const healed = await settleAndAssertConverged(server, windows);
      if (healed.length) healedSeeds.push(`${seed}:${healed.join("|")}`);
    }
    // The channels alone leave a bounded residue (the pin-over-kill lock
    // case); the loop closes it. Printed so a reader sees which seeds needed
    // the heal, and pinned loosely so a channel regression that makes EVERY
    // seed depend on the heal is visible.
    console.log(`[sim:multi-window] seeds converged through the heal: ${healedSeeds.join(", ") || "none"}`);
    expect(healedSeeds.length).toBeLessThan(seeds.length / 2);
  });
});

describe("retention passes a replica's cursor", () => {
  it("kills, restores and hard deletes made while it was away land on the recut floor: returned rows overlay, omitted rows prune", async () => {
    const server = new SimServer(seededWorld(101));
    const A = await bootDevice(server, "A", 1, 1);
    const B = await bootReplica(server, "B", 2);
    const [q, r, s] = await visibleIds(server, A);
    // A blank row A cached, that the GC deletes while A is away.
    const blank = newConversation("blank1", { message_count: 0, last_message_role: undefined, started_at: now() - GEN_DAY });
    server.insert(blank);
    await A.host.receiveAll();
    await A.drain();
    expect((A.host.state.sessions as any)[blank._id]).toBeDefined();

    A.host.online = false;
    // Elsewhere: q is killed, r is stashed then restored, s is pinned, the
    // blank is hard-deleted; then retention sweeps the log past A's cursor.
    await B.kill(q);
    await B.stash(r);
    await B.restore(r);
    await B.pin(s);
    server.delete(blank._id);
    advance(2 * GEN_DAY);
    server.retain(server.head());
    expect(server.range(A.host.cursor).resync).toBe(true);

    A.host.online = true;
    await A.host.catchUp();
    await A.drain();
    expect(hiddenEverywhere(A.windows, q)).toEqual({ "A-host": true, "A-w1": true });
    expect(hiddenEverywhere(A.windows, r)).toEqual({ "A-host": false, "A-w1": false });
    for (const w of A.windows) {
      expect({ w: w.name, pinned: (w.state.sessions as any)[s]?.is_pinned }).toEqual({ w: w.name, pinned: true });
      expect({ w: w.name, blank: (w.state.sessions as any)[blank._id] }).toEqual({ w: w.name, blank: undefined });
    }
    await settleAndAssertConverged(server, [...A.windows, B]);
  });

  it("a warm cache with no log cursor (a bundle upgraded from before the log) heals the same way", async () => {
    const server = new SimServer(seededWorld(102));
    const old = await bootReplica(server, "old", 1);
    const other = await bootReplica(server, "other", 2);
    const q = other.visibleIds()[0];
    await other.kill(q);
    // The upgraded client: the old bundle's cache, no scope cursor (0), and
    // the server's log has moved past everything it could replay from.
    advance(GEN_HOUR);
    server.retain(server.head());
    const upgraded = await bootReplica(server, "upgraded", 3);
    upgraded.state = structuredClone(old.state);
    upgraded.cursor = 0;
    await upgraded.catchUp();
    expect(upgraded.shows(q)).toBe(false);
    await settleAndAssertConverged(server, [upgraded, other]);
  });
});

describe("a follower that joins late", () => {
  it("boots from the host's snapshot and then tracks it byte for byte", async () => {
    const server = new SimServer(seededWorld(111));
    const A = await bootDevice(server, "A", 1, 0);
    const ids = A.host.visibleIds();
    await A.host.kill(ids[0]);
    await A.host.pin(ids[1]);
    const late = new Replica("A-late", server, { seed: 9 });
    await A.addFollower(late);
    expect(late.placementsSnapshot()).toEqual(A.host.placementsSnapshot());
    await late.stash(ids[2]);
    await A.drain();
    await A.host.receiveAll();
    await A.drain();
    expect(late.placementsSnapshot()).toEqual(A.host.placementsSnapshot());
    await settleAndAssertConverged(server, A.windows);
  });
});
