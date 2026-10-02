import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
  computeInboxSessions,
  computeSessionsLiveness,
  _resetChildAuqProbeCacheForTests,
} from "./conversations";
import {
  INBOX_FACT_FIELDS,
  INBOX_PROJECTION_VERSION,
  INBOX_ROW_FIELDS,
  digestProjection,
  inboxEpoch,
  projectInbox,
  selectWorkingSet,
  type ProjectableInboxRow,
} from "@codecast/shared/contracts";
import { GEN_DAY, GEN_HOUR, convexIdFor, genWorld, makeRng, type GenWorld } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { makeFakeDb } from "./testDb";
import schema from "./schema";

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

// One inbox row, every feeder (ct-56011, ct-56053). The base list, byIds and
// the completeness floor all write the client's never-prune `sessions` cache,
// and the delta syncTable replaces the whole row: a viewer field one feeder
// stamps and another omits flaps on every catch-up. The overlay-owned facts
// are nulled by every base feeder and excluded here.
describe("one row, every feeder", () => {
  const THEM = "users_them";
  const base = (tag: string, over: Record<string, any> = {}) => ({
    _id: convexIdFor(tag), user_id: ME, status: "active", updated_at: EPOCH - GEN_HOUR, started_at: EPOCH - 2 * GEN_HOUR,
    message_count: 4, last_message_role: "assistant", title: tag, ...over,
  });
  const own = base("own");
  const ownOwned = base("ownowned", { owner_user_id: ME });
  const foreignOwned = base("foreignowned", { user_id: THEM, owner_user_id: ME });
  const seat = base("seat", { owner_user_id: ME, standing_role_id: "org_roles_1", org_role_id: "org_roles_1" });
  const world = () => ({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }, { _id: THEM, name: "Them", email: "them@example.com" }],
    messages: [],
    managed_sessions: [],
    session_decisions: [],
    conversations: [own, ownOwned, foreignOwned, seat].map((c) => ({ ...c })),
    session_owners: [
      { _id: "so1", conversation_id: ownOwned._id, user_id: ME, added_by: ME, added_at: EPOCH - GEN_HOUR, seen_at: EPOCH - GEN_HOUR },
      { _id: "so2", conversation_id: foreignOwned._id, user_id: ME, added_by: THEM, added_at: EPOCH - GEN_HOUR, note: "yours now" },
      { _id: "so3", conversation_id: seat._id, user_id: ME, added_by: ME, added_at: EPOCH - GEN_HOUR, seen_at: EPOCH - GEN_HOUR },
    ],
  });
  const overlayOwned = new Set<string>(INBOX_FACT_FIELDS);
  const bodyOf = (row: any) => Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(row))).filter(([k]) => !overlayOwned.has(k)));

  test("list row == byIds row == floor row, viewer stamps included", async () => {
    const list = await computeInboxSessions({ db: makeFakeDb(world()) }, ME as any, { show_all: true, includeLiveness: false, fastFieldsInOverlay: true });
    const ids = [own, ownOwned, foreignOwned, seat].map((c) => c._id);
    const byIds = await collectInboxSessionsByIds({ db: makeFakeDb(world()) }, ME as any, ids);
    const floor = await collectInboxSessionsPaginated({ db: makeFakeDb(world()) }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    const rowIn = (rows: any[], id: string) => rows.find((r: any) => String(r._id) === id);
    for (const id of ids) {
      const l = rowIn(list.sessions, id);
      const b = rowIn(byIds.sessions, id);
      expect(l, id).toBeDefined();
      expect(bodyOf(b), id).toEqual(bodyOf(l));
      const f = rowIn(floor.page, id);
      if (id !== foreignOwned._id) expect(bodyOf(f), id).toEqual(bodyOf(l));
    }
    const l = (id: string) => rowIn(list.sessions, id);
    expect(l(own._id).owned_by_me).toBe(false);
    expect(l(ownOwned._id).owned_by_me).toBe(true);
    expect(l(foreignOwned._id)).toMatchObject({ owned_by_me: true, author_name: "Them", author_email: "them@example.com", owner_name: "Me" });
    expect(l(foreignOwned._id).assigned_ping).toMatchObject({ by_name: "Them", note: "yours now" });
    expect(l(seat._id)).toMatchObject({ owned_by_me: true, owner_name: "Me", owner_email: "me@example.com" });
  });
});

// The row shape (ct-56050). Sync-log cargo lands a raw conversation field on a
// sessions row only if INBOX_ROW_FIELDS names it, so that list must be exactly
// what the base feeders write: a field missing from it is dropped from cargo
// (stale until the next push), and an extra one rides in on cargo and flaps.
// Every conversation field is set, from the schema's own validator, so a new
// column reaches this test without anyone listing it.
describe("the row shape is INBOX_ROW_FIELDS plus the facts", () => {
  function sample(f: any): any {
    switch (f.kind) {
      case "id": return `${f.tableName}_x`;
      case "string": return "x";
      case "float64": case "int64": return 1;
      case "boolean": return true;
      case "array": return [];
      case "object": return {};
      case "literal": return f.value;
      case "union": return sample(f.members[0]);
      default: return "x";
    }
  }
  test("byIds, the floor and a subagent child row write exactly those keys", async () => {
    const THEM = "users_them";
    const every: Record<string, any> = {};
    for (const [k, f] of Object.entries<any>((schema as any).tables.conversations.validator.fields)) every[k] = sample(f);
    const live = { status: "active", is_workflow_sub: false, inbox_dismissed_at: undefined, inbox_stashed_at: undefined, inbox_killed_at: undefined, updated_at: EPOCH - GEN_HOUR, started_at: EPOCH - 2 * GEN_HOUR, message_count: 3 };
    const parent = { ...every, ...live, _id: "conversations_p", user_id: ME, is_subagent: false, parent_conversation_id: undefined, parent_message_uuid: undefined };
    const child = { ...every, ...live, _id: "conversations_c", user_id: ME, is_subagent: true, parent_conversation_id: "conversations_p" };
    const foreign = { ...parent, _id: "conversations_f", user_id: THEM, owner_user_id: ME };
    const db = makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@example.com" }, { _id: THEM, name: "Them", email: "them@example.com" }],
      conversations: [parent, child, foreign], messages: [], managed_sessions: [], session_decisions: [],
      session_owners: [{ _id: "so1", conversation_id: "conversations_f", user_id: ME, added_by: THEM, added_at: EPOCH }],
    });
    const byIds = await collectInboxSessionsByIds({ db }, ME as any, ["conversations_p", "conversations_f"]);
    const floor = await collectInboxSessionsPaginated({ db }, ME as any, { paginationOpts: { numItems: 10, cursor: null } });
    expect(floor.page.map((r: any) => String(r._id)).sort()).toEqual(["conversations_c", "conversations_p"]);
    const written = new Set<string>();
    for (const r of [...byIds.sessions, ...floor.page]) for (const k of Object.keys(r)) written.add(k);
    const shape = new Set<string>([...INBOX_ROW_FIELDS, ...INBOX_FACT_FIELDS]);
    expect([...written].filter((k) => !shape.has(k)).sort()).toEqual([]);
    expect([...shape].filter((k) => !written.has(k)).sort()).toEqual([]);
  });
});
