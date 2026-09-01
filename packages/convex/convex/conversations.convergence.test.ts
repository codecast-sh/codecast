import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  _resetChildAuqProbeCacheForTests,
} from "./conversations";
import {
  INBOX_PROJECTION_VERSION,
  digestProjection,
  inboxEpoch,
  projectInbox,
  selectWorkingSet,
  type ProjectableInboxRow,
} from "@codecast/shared/contracts";
import { GEN_DAY, GEN_HOUR, convexIdFor, genWorld, makeRng, type GenWorld } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { makeFakeDb } from "./testDb";

// SERVER DETERMINISM over GENERATED worlds (sync-convergence C2/C4, the
// "Validation plan"). The hand-built fixtures in conversations.projection and
// inboxCompat pin each rule once; this suite runs the real overlay and the
// real CLI path over seeded random worlds so the identities hold across the
// combinations no fixture author thought of:
//   1. two executions inside one minute are byte identical;
//   2. the scan's stamped set is exactly selectWorkingSet over the same rows,
//      truncation flags included;
//   3. the overlay's digest and tally are the shared projectInbox over the
//      server's own facts and stamps — the server never places a row any
//      other way;
//   4. inboxForCLI's fold agrees with the overlay's per row, label extras
//      fold exempt.

const ME = "users_me";
const EPOCH = inboxEpoch(1_800_000_000_000);
const SEEDS = Array.from({ length: 14 }, (_, i) => 500 + i);

function dbFor(world: GenWorld, extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    messages: [],
    ...world,
    ...extra,
  });
}

// Deep-copy a world so two executions read identical but distinct tables.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(EPOCH + 5_000);
  _resetChildAuqProbeCacheForTests();
});
afterEach(() => {
  nowSpy.mockRestore();
  delete process.env.INBOX_DIGEST_DISABLED;
});

describe("same minute, same bytes", () => {
  test("two overlay executions inside one minute over a generated world are byte identical", async () => {
    for (const seed of SEEDS) {
      const world = genWorld(seed, 70, EPOCH, ME);
      nowSpy.mockReturnValue(EPOCH + 5_000);
      _resetChildAuqProbeCacheForTests();
      const first = await computeSessionsLiveness({ db: dbFor(clone(world)) }, ME as any);
      nowSpy.mockReturnValue(EPOCH + 55_000);
      _resetChildAuqProbeCacheForTests();
      const second = await computeSessionsLiveness({ db: dbFor(clone(world)) }, ME as any);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.projection.v).toBe(INBOX_PROJECTION_VERSION);
      expect(first.projection.epoch).toBe(EPOCH);
      expect(JSON.stringify(first)).not.toContain(String(EPOCH + 5_000));
    }
  });

  test("the base list is likewise identical inside the minute, with and without liveness", async () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const world = genWorld(seed, 50, EPOCH, ME);
      for (const includeLiveness of [false, true]) {
        nowSpy.mockReturnValue(EPOCH + 1_000);
        const a = await computeInboxSessions({ db: dbFor(clone(world)) }, ME as any, { show_all: false, includeLiveness, fastFieldsInOverlay: true });
        nowSpy.mockReturnValue(EPOCH + 59_000);
        const b = await computeInboxSessions({ db: dbFor(clone(world)) }, ME as any, { show_all: false, includeLiveness, fastFieldsInOverlay: true });
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      }
    }
  });
});

describe("the scan is the shared selection", () => {
  test("stamped ids == selectWorkingSet members over the same conversations, flags included", async () => {
    for (const seed of SEEDS) {
      const world = genWorld(seed, 90, EPOCH, ME);
      // Owned rows: a handful of the user's own conversations also carry an
      // owner row (the canonical owner set), so the owned window is exercised.
      const rng = makeRng(seed);
      const owners = world.conversations.filter(() => rng() < 0.1).map((c, i) => ({ _id: `so_${seed}_${i}`, user_id: ME, conversation_id: c._id }));
      const { liveness, projection } = await computeSessionsLiveness({ db: dbFor(world, { session_owners: owners }) }, ME as any);
      const stamped = Object.entries(liveness).filter(([, r]) => (r as any).bucket !== undefined).map(([id]) => id).sort();
      const ownedIds = new Set(owners.map((o) => o.conversation_id));
      const rows = world.conversations.map((c) => ({ ...c, owned_by_me: ownedIds.has(c._id) }));
      const { members, truncated } = selectWorkingSet(rows as any, EPOCH);
      expect(stamped).toEqual([...members.keys()].sort());
      expect(projection.truncated).toEqual(truncated);
    }
  });

  test("a window at cap + 1 names itself on both sides and drops the same row", async () => {
    const world = genWorld(77, 10, EPOCH, ME);
    for (let i = 0; i < 201; i++) {
      world.conversations.push({
        _id: convexIdFor(`cap${i}`),
        user_id: ME,
        status: "active",
        updated_at: EPOCH - 40 * GEN_DAY,
        started_at: EPOCH - 41 * GEN_DAY,
        message_count: 3,
        last_message_role: "assistant",
        title: `Dismissed ${i}`,
        inbox_dismissed_at: EPOCH - GEN_HOUR - i * 1000,
      });
    }
    const { liveness, projection } = await computeSessionsLiveness({ db: dbFor(world) }, ME as any);
    const { members, truncated } = selectWorkingSet(world.conversations as any, EPOCH);
    expect(projection.truncated).toEqual(truncated);
    expect(projection.truncated).toContain("dismissed");
    const stamped = Object.entries(liveness).filter(([, r]) => (r as any).bucket !== undefined).map(([id]) => id).sort();
    expect(stamped).toEqual([...members.keys()].sort());
    expect(liveness[convexIdFor("cap200")]).toBeUndefined();
  });
});

describe("the overlay is the shared projection over its own facts", () => {
  function replicaRowsOf(world: GenWorld, liveness: Record<string, any>): { rows: ProjectableInboxRow[]; asking: Set<string> } {
    const rows: ProjectableInboxRow[] = [];
    const asking = new Set<string>();
    for (const c of world.conversations) {
      const lv = liveness[c._id];
      const row: ProjectableInboxRow = { ...c } as any;
      if (lv) {
        // The overlay's FACTS (never its stamps) land on the row, exactly as a
        // replica's applier merges them.
        for (const f of ["agent_status", "is_idle", "is_unresponsive", "awaiting_input", "message_count", "updated_at", "last_turn_allows_park"]) {
          if (lv[f] !== undefined) (row as any)[f] = lv[f];
        }
        if (lv.asking) asking.add(c._id);
      }
      rows.push(row);
    }
    return { rows, asking };
  }

  test("digest, tally and per-row placement equal projectInbox over conversations + overlay facts", async () => {
    for (const seed of SEEDS) {
      const world = genWorld(seed, 80, EPOCH, ME);
      const { liveness, projection } = await computeSessionsLiveness({ db: dbFor(world) }, ME as any);
      const { rows, asking } = replicaRowsOf(world, liveness);
      const local = projectInbox(rows, EPOCH, { asking: (id) => asking.has(id) });
      expect(local.set_digest).toBe(projection.set_digest!);
      expect(local.tally).toEqual(projection.tally);
      for (const [id, stamp] of Object.entries(liveness)) {
        if ((stamp as any).bucket === undefined) continue;
        const p = local.placements.get(id)!;
        expect({ id, bucket: p.bucket, work_state: p.work_state, below_fold: p.below_fold })
          .toEqual({ id, bucket: (stamp as any).bucket, work_state: (stamp as any).work_state, below_fold: (stamp as any).below_fold });
      }
      // The digest is the shared algorithm over the stamps themselves.
      const entries = Object.entries(liveness)
        .filter(([, r]) => (r as any).bucket !== undefined)
        .map(([id, r]) => [id, (r as any).bucket, !!(r as any).below_fold] as const);
      expect(digestProjection(entries)).toBe(projection.set_digest!);
    }
  });

  test("the kill switch nulls the digest and nothing else", async () => {
    const world = genWorld(9, 40, EPOCH, ME);
    const on = await computeSessionsLiveness({ db: dbFor(clone(world)) }, ME as any);
    process.env.INBOX_DIGEST_DISABLED = "1";
    _resetChildAuqProbeCacheForTests();
    const off = await computeSessionsLiveness({ db: dbFor(clone(world)) }, ME as any);
    expect(off.projection.set_digest).toBeNull();
    expect({ ...off.projection, set_digest: on.projection.set_digest }).toEqual(on.projection);
    expect(JSON.stringify(off.liveness)).toBe(JSON.stringify(on.liveness));
  });
});

describe("inboxForCLI folds where the overlay folds", () => {
  test("below_fold agrees per row; label extras outside the selection never fold and never move the cut", async () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const world = genWorld(seed, 80, EPOCH, ME);
      // A label's filed extra: far outside every window, hydrated by id.
      const extraId = convexIdFor(`extra${seed}`);
      world.conversations.push({
        _id: extraId, user_id: ME, status: "active", updated_at: EPOCH - 60 * GEN_DAY, started_at: EPOCH - 61 * GEN_DAY,
        message_count: 3, last_message_role: "assistant", title: "Filed long ago",
      });
      const overlay = await computeSessionsLiveness({ db: dbFor(clone(world)) }, ME as any);
      _resetChildAuqProbeCacheForTests();
      const cli = await computeInboxSessions({ db: dbFor(clone(world)) }, ME as any, { show_all: true, projection: true, extraConvIds: [extraId] });
      const cliRow = (id: string) => cli.sessions.find((s: any) => s._id === id);
      expect(overlay.liveness[extraId]).toBeUndefined();
      expect(cliRow(extraId)).toMatchObject({ below_fold: false });
      let compared = 0;
      for (const [id, stamp] of Object.entries(overlay.liveness)) {
        if ((stamp as any).bucket === undefined) continue;
        const row = cliRow(id);
        if (!row) continue; // dismissed/stashed rows leave the CLI list by its own filters
        compared++;
        expect({ id, bucket: row.bucket, below_fold: row.below_fold })
          .toEqual({ id, bucket: (stamp as any).bucket, below_fold: (stamp as any).below_fold });
      }
      expect(compared).toBeGreaterThan(0);
    }
  });
});
