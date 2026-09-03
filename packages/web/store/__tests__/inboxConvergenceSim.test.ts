import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

// Real Convex compute over dozens of rows, hundreds of steps: seconds on an
// idle machine, far more on a loaded one. Never a 5s test.
setDefaultTimeout(120_000);
import { _resetChildAuqProbeCacheForTests } from "@codecast/convex/convex/conversations";
import { INBOX_PROJECTION_VERSION, inboxEpoch } from "@codecast/shared/contracts";
import { useInboxStore, projectReplicaInbox, type InboxSession } from "../inboxStore";
import {
  INBOX_HEAL_BUDGET,
  INBOX_PROBE_PAYLOAD_AGE_MS,
  INBOX_COMPARE_TICK_MS,
  evaluateInboxCompare,
} from "../inboxDigestCompare";
import {
  CRAWL_KEY,
  GEN_DAY,
  GEN_HOUR,
  GEN_MIN,
  ME,
  Replica,
  SERVER_EVENTS,
  SimServer,
  advance,
  bootReplica,
  convexIdFor,
  installSim,
  makeRng,
  memberIds,
  mono,
  now,
  pickShown,
  quietTick,
  seededWorld,
  settleAndAssertConverged,
  uninstallSim,
} from "./inboxSimHarness";

// THE TWO-REPLICA SIMULATION — the eventual-consistency proof as a test
// (docs/architecture/sync-convergence.md, "Validation plan": Simulation).
// The moving parts live in inboxSimHarness.ts; the multi-window, multi-device
// half of the proof is inboxMultiWindowSim.test.ts.
//
// The claim under test: whatever order payloads, ranges, floors, gestures,
// reconnects and epoch ticks arrive in, at quiescence both replicas hold the
// same working set, the same placed buckets and the same digest, all equal to
// the projection computed directly over canonical state — and the compare
// loop says "clean" on both.

beforeEach(() => {
  installSim();
  _resetChildAuqProbeCacheForTests();
  delete process.env.INBOX_DIGEST_DISABLED;
});
afterEach(() => {
  uninstallSim();
  delete process.env.INBOX_DIGEST_DISABLED;
});

// ── The scenarios ───────────────────────────────────────────────────────────

describe("two replicas converge", () => {
  it("hand-written interleaving: pin, dismiss, settle, trigger arm, queued send, revive, reconnect, epoch ticks — in different orders", async () => {
    const server = new SimServer(seededWorld(11));
    const a = await bootReplica(server, "A", 1);
    const b = await bootReplica(server, "B", 2);
    const ids = server.conversations.filter((c) => !c.is_subagent && !c.inbox_killed_at && !c.inbox_dismissed_at && !c.inbox_stashed_at).map((c) => c._id);
    const [p, q, r, s, t] = ids;

    // A pins p and kills q locally; B sees neither yet.
    await a.pin(p);
    await a.kill(q);
    // B stashes r while offline — its gesture reaches the server, its view of
    // A's gestures does not arrive until it reconnects.
    b.online = false;
    await b.stash(r);
    // The daemon settles s and a trigger arms on t (server-side facts).
    SERVER_EVENTS.agentSettles(server, () => 0.0, 0);
    server.mutate(t, { armed_trigger_kind: "standing" });
    // A queues a send on t and revives s (local overlays), then a minute passes.
    await a.setQueued(t, true);
    await a.revive(s);
    advance(GEN_MIN);
    await a.receiveAll();
    // Mid-flight: A's overlays make its compare fall through to the per-row
    // diff, which drops the affected ids — never drift.
    advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
    const mid = a.tick();
    expect(mid.kind === "clean" || mid.kind === "diff").toBe(true);
    // B reconnects a few minutes later, in the other order: overlay first,
    // then the log, then the base window.
    advance(3 * GEN_MIN);
    b.online = true;
    await b.receiveOverlay();
    await b.catchUp();
    await b.receiveBase();
    await settleAndAssertConverged(server, [a, b]);
    // No drift was ever counted on either side.
    expect(a.eventsNamed("inbox_drift")).toEqual([]);
    expect(b.eventsNamed("inbox_drift")).toEqual([]);
  });

  it("randomized interleavings over seeded worlds: any order of payloads, ranges, floors, gestures, reconnects and epoch ticks converges", async () => {
    // Replay one seed with SIM_SEEDS=25 (comma separated).
    const seeds = process.env.SIM_SEEDS ? process.env.SIM_SEEDS.split(",").map(Number) : [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const healedSeeds: string[] = [];
    for (const seed of seeds) {
      installSim();
      _resetChildAuqProbeCacheForTests();
      const server = new SimServer(seededWorld(seed));
      const a = await bootReplica(server, `A${seed}`, seed);
      const b = await bootReplica(server, `B${seed}`, seed + 100);
      const rng = makeRng(seed * 7);
      const replicas = [a, b];
      const eventNames = Object.keys(SERVER_EVENTS);
      for (let step = 0; step < 60; step++) {
        const roll = rng();
        const r = replicas[Math.floor(rng() * replicas.length)];
        const target = pickShown(r, rng);
        if (roll < 0.3) {
          SERVER_EVENTS[eventNames[Math.floor(rng() * eventNames.length)]](server, rng, step);
        } else if (roll < 0.4 && target) {
          await r.pin(target);
        } else if (roll < 0.45 && target) {
          await r.kill(target);
        } else if (roll < 0.5 && target) {
          await r.stash(target);
        } else if (roll < 0.55 && target) {
          await r.revive(target);
        } else if (roll < 0.6 && target) {
          await r.setQueued(target, true);
        } else if (roll < 0.63 && target) {
          await r.focus(target);
        } else if (roll < 0.7) {
          r.online = !r.online;
        } else if (roll < 0.78) {
          await r.receiveBase();
        } else if (roll < 0.86) {
          await r.receiveOverlay();
        } else if (roll < 0.92) {
          await r.catchUp();
        } else if (roll < 0.96) {
          await r.crawl();
        } else {
          advance([15_000, GEN_MIN, 5 * GEN_MIN, GEN_HOUR][Math.floor(rng() * 4)]);
        }
        if (rng() < 0.5) advance(Math.floor(rng() * 20_000));
      }
      const healed = await settleAndAssertConverged(server, replicas);
      if (healed.length) healedSeeds.push(`${seed}:${healed.join("|")}`);
    }
    // The channels alone leave a bounded residue (the pin-over-kill lock
    // case); the loop closes it. Printed so a reader sees which seeds needed
    // the heal, and pinned loosely so a channel regression that makes EVERY
    // seed depend on the heal is visible.
    console.log(`[sim] seeds converged through the heal: ${healedSeeds.join(", ") || "none"}`);
    expect(healedSeeds.length).toBeLessThan(seeds.length / 2);
  });
});

describe("the cold replica", () => {
  it("compares nothing until its floor completes; then the base list's fold omission heals within one budget", async () => {
    // A world whose fresh cluster sits a day above a tail of older rows: the
    // base list omits the tail (transport fold), the overlay stamps it.
    const world = seededWorld(31, 30);
    for (let i = 0; i < 6; i++) {
      world.conversations.push({
        _id: convexIdFor(`tail${i}`), user_id: ME, status: "active", updated_at: now() - 2 * GEN_DAY - i * GEN_HOUR,
        started_at: now() - 3 * GEN_DAY, message_count: 3, last_message_role: "assistant", title: `Tail ${i}`,
      });
    }
    const server = new SimServer(world);
    const warm = await bootReplica(server, "warm", 1);
    const cold = new Replica("cold", server, { seed: 2 });
    // The cold device: live window + overlay only, no floor yet.
    await cold.receiveBase();
    await cold.receiveOverlay();
    await cold.receiveDecisions();
    const { liveness } = await server.overlay();
    const folded = Object.entries(liveness).filter(([, r]: any) => r.below_fold).map(([id]) => id);
    expect(folded.length).toBeGreaterThan(0);
    for (const id of folded) expect((cold.state.sessions as any)[id]).toBeUndefined();
    expect(await quietTick(cold)).toMatchObject({ kind: "skip", reason: "cold_replica" });
    expect(cold.comparer.counters().skips.cold_replica).toBe(1);
    expect(cold.comparer.counters().checks).toBe(0);
    // The floor completes and stamps the watermark. It is additive and
    // window-bounded, so it may or may not carry every stamped member; what
    // it cannot carry, the compare finds and the heal hydrates by id.
    await cold.crawl();
    const first = await quietTick(cold);
    if (first.kind === "diff") {
      expect(first.diff.extra).toEqual([]);
      expect(first.diff.bucket_deltas).toEqual([]);
      // Persistence rule: a second compare at a DISTINCT payload epoch.
      advance(GEN_MIN);
      const second = await quietTick(cold);
      expect(second.kind).toBe("diff");
      expect(cold.eventsNamed("inbox_drift").length).toBe(1);
      expect(await cold.drainHeals()).toBe(1);
      expect(cold.comparer.counters().heals).toBe(1);
      expect(cold.comparer.counters().heals).toBeLessThanOrEqual(INBOX_HEAL_BUDGET);
    } else {
      expect(first.kind).toBe("clean");
    }
    expect(await quietTick(cold)).toMatchObject({ kind: "clean" });
    expect(cold.comparer.healLatched()).toBe(false);
    await settleAndAssertConverged(server, [warm, cold]);
  });
});

describe("a dead subscription is detected and healed", () => {
  it("overlay zombie: the payload ages out, the stale probe forces a fresh execution, the replica re-converges", async () => {
    const server = new SimServer(seededWorld(41));
    const a = await bootReplica(server, "A", 1);
    const id = memberIds(server, () => 0.3)!;
    a.overlayDead = true;
    // The world moves: a fact flips server-side that only the overlay carries.
    server.setAgent(id, { agent_status: "working", last_heartbeat: now(), agent_status_updated_at: now() });
    server.mutate(id, { updated_at: now(), message_count: 9 });
    advance(2 * GEN_MIN);
    await a.receiveBase();
    await a.catchUp();
    // Gate 3: the payload is older than the bound — skipped, counted, no heal.
    expect(await quietTick(a, { overlay: false })).toMatchObject({ kind: "skip", reason: "stale_payload" });
    expect(a.comparer.counters().skips.stale_payload).toBe(1);
    // Rendering over frozen facts falls back to the client sweep: the row the
    // server now calls working still reads from the last payload, and a row
    // whose liveness froze past the trust TTL settles honestly rather than
    // pinning a stale "working" — the compare never sees this (gated).
    const frozen = a.placed();
    expect(frozen.placements.get(id)?.bucket).not.toBe("working");
    // Past the probe age the comparer issues ONE budgeted probe.
    advance(INBOX_PROBE_PAYLOAD_AGE_MS);
    a.tick();
    expect(a.comparer.counters().probes).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The fresh payload landed through the applier: the probe's own execution
    // clock is the tick's, so the very next tick is clean.
    expect(a.tick()).toMatchObject({ kind: "clean" });
    expect(a.comparer.counters().heals).toBe(0);
    a.overlayDead = false;
    await settleAndAssertConverged(server, [a]);
  });

  it("base zombie: a row the overlay stamps but the window never delivered is missing, persists across two payload epochs, and heals by id", async () => {
    const server = new SimServer(seededWorld(42));
    const a = await bootReplica(server, "A", 1);
    a.baseDead = true;
    // A new session starts elsewhere; A's log cursor is stuck too (same socket).
    a.online = false;
    SERVER_EVENTS.newSession(server, () => 0, 99);
    const newId = convexIdFor("new99");
    a.online = true;
    const first = await quietTick(a);
    expect(first).toMatchObject({ kind: "diff", diff: { missing: [newId], extra: [], bucket_deltas: [], fold_deltas: [] } });
    // One tick between the pushes is a race, not drift: nothing counted yet.
    expect(a.comparer.counters().mismatches).toBe(0);
    advance(GEN_MIN);
    expect((await quietTick(a)).kind).toBe("diff");
    expect(a.comparer.counters().mismatches).toBe(1);
    expect(a.eventsNamed("inbox_drift")).toEqual([
      { event: "inbox_drift", props: expect.objectContaining({ missing: 1, extra: 0, bucket_deltas: 0, fold_deltas: 0, scope: "mine", platform: "sim-A" }) },
    ]);
    expect(await a.drainHeals()).toBe(1);
    expect(a.comparer.counters()).toMatchObject({ heals: 1, heals_missing: 1 });
    expect((a.state.sessions as any)[newId]).toBeDefined();
    expect(await quietTick(a)).toMatchObject({ kind: "clean" });
    expect(a.comparer.healLatched()).toBe(false);
    // Still one drift event: the same digest never reports twice.
    expect(a.eventsNamed("inbox_drift").length).toBe(1);
  });

  it("a persistent extra is reported, never deleted: three heals, then the latch", async () => {
    const server = new SimServer(seededWorld(43));
    const a = await bootReplica(server, "A", 1);
    // A ghost only this replica holds (a row the server will never return).
    const ghost = convexIdFor("ghost");
    await a.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: now(), message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    // Every compare reports the ghost; the persistence rule confirms one
    // drift per two payload epochs, each confirmation spends a heal, and the
    // fourth confirmation latches instead of healing.
    let healsRun = 0;
    let rounds = 0;
    while (!a.comparer.healLatched() && rounds < 2 * (INBOX_HEAL_BUDGET + 2)) {
      advance(GEN_MIN);
      const out = await quietTick(a);
      expect(out).toMatchObject({ kind: "diff", diff: { missing: [], extra: [ghost] } });
      healsRun += await a.drainHeals();
      rounds++;
    }
    expect(rounds).toBe(2 * (INBOX_HEAL_BUDGET + 1));
    expect(healsRun).toBe(INBOX_HEAL_BUDGET);
    expect(a.comparer.healLatched()).toBe(true);
    expect(a.eventsNamed("inbox_drift_persistent").length).toBe(1);
    expect(a.comparer.counters().heals).toBe(INBOX_HEAL_BUDGET);
    // The ghost row is still there: deletion truth is authorized absence.
    expect((a.state.sessions as any)[ghost]).toBeDefined();
    // ONE inbox_drift event: the digest never changed, so no repeat.
    expect(a.eventsNamed("inbox_drift").length).toBe(1);
  });
});

describe("the two drills", () => {
  it("a client on the wrong projection version stays silent: one skew metric, no heal, no drift", async () => {
    const server = new SimServer(seededWorld(51));
    const a = await bootReplica(server, "A", 1);
    // Diverge the replica on purpose so a compare WOULD report drift…
    const ghost = convexIdFor("ghost");
    await a.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: now(), message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    // …then feed it payloads from a server one version ahead (the deploy skew
    // window: convex shipped v+1 before this bundle reloaded).
    const skewed = async () => {
      const payload = await server.overlay();
      return { ...payload, projection: { ...payload.projection, v: INBOX_PROJECTION_VERSION + 1 } };
    };
    for (let round = 0; round < 4; round++) {
      advance(GEN_MIN);
      const payload = await skewed();
      await a.withStore(() => useInboxStore.getState().applyInboxLivenessPayload("mine", payload));
      advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
      expect(a.tick()).toMatchObject({ kind: "skip", reason: "version_skew", payload_v: INBOX_PROJECTION_VERSION + 1 });
      expect(await a.drainHeals()).toBe(0);
    }
    expect(a.comparer.counters().skips.version_skew).toBe(4);
    expect(a.comparer.counters().checks).toBe(0);
    expect(a.eventsNamed("inbox_digest_version_skew")).toEqual([
      { event: "inbox_digest_version_skew", props: expect.objectContaining({ payload_v: INBOX_PROJECTION_VERSION + 1, client_v: INBOX_PROJECTION_VERSION }) },
    ]);
    expect(a.eventsNamed("inbox_drift")).toEqual([]);
    // The rendered inbox is untouched by the skew: the replica still renders
    // from its own computation (the stamps were never a render source).
    expect(a.placed().placements.has(ghost)).toBe(true);
  });

  it("INBOX_DIGEST_DISABLED propagates on the next overlay execution: null digest, compare and heal off, telemetry names it", async () => {
    const server = new SimServer(seededWorld(52));
    const a = await bootReplica(server, "A", 1);
    const b = await bootReplica(server, "B", 2);
    expect((await quietTick(a)).kind).toBe("clean");
    // The switch flips on the Convex env. The payload already delivered still
    // carries a digest; the NEXT execution carries null — propagation is one
    // overlay cadence, no deploy.
    process.env.INBOX_DIGEST_DISABLED = "1";
    expect((a.state.sessionsProjection as any).mine.set_digest).not.toBeNull();
    // Diverge B so the kill switch has something to suppress.
    const ghost = convexIdFor("ghost");
    await b.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: now(), message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    advance(GEN_MIN);
    const flipAt = now();
    await a.receiveOverlay();
    await b.receiveOverlay();
    expect((a.state.sessionsProjection as any).mine.set_digest).toBeNull();
    expect((b.state.sessionsProjection as any).mine.set_digest).toBeNull();
    // Stamps and facts still ride the payload (rendering freshness is untouched).
    expect(Object.keys((a.state.sessionsProjection as any).mine.stamps).length).toBeGreaterThan(0);
    advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
    for (let round = 0; round < 3; round++) {
      expect(a.tick()).toEqual({ kind: "disabled" });
      expect(b.tick()).toEqual({ kind: "disabled" });
      expect(await b.drainHeals()).toBe(0);
      advance(INBOX_PROBE_PAYLOAD_AGE_MS + GEN_MIN);
    }
    expect(b.comparer.counters()).toMatchObject({ disabled: 3, checks: 0, heals: 0, probes: 0 });
    expect(b.eventsNamed("inbox_drift")).toEqual([]);
    // Propagation time: the first null payload is the first execution after
    // the flip — within one overlay cycle.
    expect((a.state.sessionsProjection as any).mine.epoch).toBe(inboxEpoch(flipAt));
    // Switching it back off restores the compare on the next payload.
    delete process.env.INBOX_DIGEST_DISABLED;
    advance(GEN_MIN);
    expect((await quietTick(a)).kind).toBe("clean");
  });
});

describe("the pure compare on the same replicas", () => {
  it("evaluateInboxCompare at the payload epoch agrees with the loop's verdict after convergence", async () => {
    const server = new SimServer(seededWorld(61));
    const a = await bootReplica(server, "A", 1);
    await settleAndAssertConverged(server, [a]);
    const state = a.compareState();
    const slot = (state.sessionsProjection as any).mine;
    const out = evaluateInboxCompare(state, { now: now(), nowMono: mono(), crawlMetaKey: CRAWL_KEY, lastApplyMono: mono() - 10 * GEN_MIN, inflight: 0 });
    expect(out).toMatchObject({ kind: "clean", short_circuit: true, epoch: slot.epoch });
    const { proj } = projectReplicaInbox(state, { scope: "mine", focusedId: null, epoch: slot.epoch, now: now() });
    expect(proj.set_digest).toBe(slot.set_digest);
  });
});
