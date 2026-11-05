// A source's recordings counted per person (ingestSchema replay_tallies), so
// the Replays list's total, the tab badge and each People row print exact
// counts however many recordings a workspace holds. The browse scan reads only
// the newest REPLAY_BROWSE_SCAN rows, so before these a big workspace's total
// was a floor and a person's People row counted only their recent recordings.
//
// Each recording adds one contribution to the row of its person (or, with no
// person, to one of TALLY_SHARDS rows): its length, errors and failed requests,
// split by whether the default active-time floor hides it (shared
// belowActiveFloor). Every write that can move one of those goes through
// patchReplay (lib/replayIndex.ts) or ensureReplay, which call moveTally with
// the row before and after. The tend cron recounts vendor sources whole
// (rebuild), which also stamps event_sources.replay_tally_at: the list reads
// tallies only for sources that carry it.
import type { Doc, Id } from "../_generated/dataModel";
import { belowActiveFloor, isAnonymous, personKey, personLabel, REPLAY_ACTIVE_DEFAULT_MS, REPLAY_ENV_KEYS, type ReplayMatch, type ReplayPerson } from "@codecast/shared/replay";

type Db = { db: any };

/** Rows a recording with no person may land in, so imports of anonymous recordings do not all write one row. */
export const TALLY_SHARDS = 8;

export type TallyInput = {
  external_id: string;
  user?: { id?: string; email?: string; name?: string } | null;
  duration_ms?: number | null;
  counts: { errors: number; failed_requests: number };
  shape?: { active_ms?: number } | null;
  facts?: { active_ms?: number } | null;
  group_ids?: readonly unknown[];
  started_at: number;
};

/** What one recording adds to its person's tally row. */
export type TallyContribution = {
  person_key?: string;
  shard?: number;
  label?: string;
  anonymous?: boolean;
  short: boolean;
  ms: number;
  errors: number;
  failed: number;
  at: number;
};

function shardOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % TALLY_SHARDS;
}

export function tallyContribution(r: TallyInput): TallyContribution {
  const key = personKey((r.user ?? null) as any) ?? undefined;
  return {
    ...(key ? { person_key: key, label: personLabel(r.user as any), anonymous: isAnonymous(r.user as any) } : { shard: shardOf(r.external_id) }),
    short: belowActiveFloor(r as any, REPLAY_ACTIVE_DEFAULT_MS),
    ms: Math.max(0, r.duration_ms ?? 0),
    errors: r.counts?.errors ?? 0,
    failed: r.counts?.failed_requests ?? 0,
    at: r.started_at,
  };
}

type Vec = { n: number; ms: number; errors: number; failed: number; short_n: number; short_ms: number; short_errors: number; short_failed: number };
const VEC_KEYS = ["n", "ms", "errors", "failed", "short_n", "short_ms", "short_errors", "short_failed"] as const;
const ZERO: Vec = { n: 0, ms: 0, errors: 0, failed: 0, short_n: 0, short_ms: 0, short_errors: 0, short_failed: 0 };

function vecOf(c: TallyContribution, sign: 1 | -1): Vec {
  const s = c.short ? sign : 0;
  return { n: sign, ms: sign * c.ms, errors: sign * c.errors, failed: sign * c.failed, short_n: s, short_ms: s * c.ms, short_errors: s * c.errors, short_failed: s * c.failed };
}

function addVec(a: Vec, b: Vec): Vec {
  const out = { ...a };
  for (const k of VEC_KEYS) out[k] += b[k];
  return out;
}

const slotOf = (c: TallyContribution) => (c.person_key !== undefined ? `p:${c.person_key}` : `s:${c.shard}`);

async function slotRow(ctx: Db, sourceId: Id<"event_sources">, c: Pick<TallyContribution, "person_key" | "shard">) {
  return await ctx.db
    .query("replay_tallies")
    .withIndex("by_source_person", (q: any) => q.eq("source_id", sourceId).eq("person_key", c.person_key).eq("shard", c.shard))
    .first();
}

async function applyVec(ctx: Db, owner: { workspace: string; source_id: Id<"event_sources"> }, c: TallyContribution, vec: Vec, adding: boolean, now: number): Promise<void> {
  if (VEC_KEYS.every((k) => vec[k] === 0) && !adding) return;
  const row = await slotRow(ctx, owner.source_id, c);
  if (!row) {
    if (vec.n <= 0) return;
    await ctx.db.insert("replay_tallies", {
      workspace: owner.workspace,
      source_id: owner.source_id,
      ...(c.person_key !== undefined ? { person_key: c.person_key, label: c.label, anonymous: c.anonymous } : { shard: c.shard }),
      ...vec,
      first_at: c.at,
      last_at: c.at,
      updated_at: now,
    });
    return;
  }
  const next = addVec(Object.fromEntries(VEC_KEYS.map((k) => [k, row[k] ?? 0])) as Vec, vec);
  if (next.n <= 0) {
    await ctx.db.delete(row._id);
    return;
  }
  const newer = adding && c.at >= row.last_at;
  await ctx.db.patch(row._id, {
    ...Object.fromEntries(VEC_KEYS.map((k) => [k, Math.max(0, next[k])])),
    ...(adding ? { first_at: Math.min(row.first_at, c.at), last_at: Math.max(row.last_at, c.at) } : {}),
    ...(newer && c.label !== undefined ? { label: c.label, anonymous: c.anonymous } : {}),
    updated_at: now,
  });
}

function sameContribution(a: TallyContribution, b: TallyContribution): boolean {
  return slotOf(a) === slotOf(b) && a.short === b.short && a.ms === b.ms && a.errors === b.errors && a.failed === b.failed && a.label === b.label && a.anonymous === b.anonymous && a.at === b.at;
}

/**
 * Move a recording's tally from what it was to what it is. `before` null is a
 * new recording, `after` null a removed one.
 */
export async function moveTally(ctx: Db, owner: { workspace: string; source_id: Id<"event_sources"> }, before: TallyInput | null, after: TallyInput | null, now = Date.now()): Promise<void> {
  const b = before ? tallyContribution(before) : null;
  const a = after ? tallyContribution(after) : null;
  if (b && a && sameContribution(b, a)) return;
  if (b && a && slotOf(b) === slotOf(a)) {
    await applyVec(ctx, owner, a, addVec(vecOf(b, -1), vecOf(a, 1)), true, now);
    return;
  }
  if (b) await applyVec(ctx, owner, b, vecOf(b, -1), false, now);
  if (a) await applyVec(ctx, owner, a, vecOf(a, 1), true, now);
}

// ── Recounting a source whole (the tend cron, and once after the table was added) ──

/** One slot's sums over a page of rows. */
export type TallySum = Vec & { person_key?: string; shard?: number; label?: string; anonymous?: boolean; first_at: number; last_at: number };

/** Fold rows into per-slot sums, onto `into` (keyed by slot). */
export function foldTallies(rows: readonly TallyInput[], into: Map<string, TallySum> = new Map()): Map<string, TallySum> {
  for (const r of rows) {
    const c = tallyContribution(r);
    const key = slotOf(c);
    const cur = into.get(key);
    if (!cur) {
      into.set(key, { ...ZERO, ...vecOf(c, 1), ...(c.person_key !== undefined ? { person_key: c.person_key, label: c.label, anonymous: c.anonymous } : { shard: c.shard }), first_at: c.at, last_at: c.at });
      continue;
    }
    Object.assign(cur, addVec(cur, vecOf(c, 1)));
    cur.first_at = Math.min(cur.first_at, c.at);
    if (c.at >= cur.last_at) {
      cur.last_at = c.at;
      if (c.label !== undefined) Object.assign(cur, { label: c.label, anonymous: c.anonymous });
    }
  }
  return into;
}

/** Merge two pages' sums (the rebuild's fold across pages). */
export function mergeTallySums(into: Map<string, TallySum>, page: readonly TallySum[]): Map<string, TallySum> {
  for (const s of page) {
    const key = s.person_key !== undefined ? `p:${s.person_key}` : `s:${s.shard}`;
    const cur = into.get(key);
    if (!cur) {
      into.set(key, { ...s });
      continue;
    }
    Object.assign(cur, addVec(cur, s));
    cur.first_at = Math.min(cur.first_at, s.first_at);
    if (s.last_at >= cur.last_at) Object.assign(cur, { last_at: s.last_at, ...(s.label !== undefined ? { label: s.label, anonymous: s.anonymous } : {}) });
  }
  return into;
}

/** Write recounted sums, stamped `stamp` so the prune after leaves only rows this recount or a live write touched. */
export async function writeTallySums(ctx: Db, owner: { workspace: string; source_id: Id<"event_sources"> }, sums: readonly TallySum[], stamp: number): Promise<void> {
  for (const s of sums) {
    const row = await slotRow(ctx, owner.source_id, s);
    // A live write since the recount began knows better than the recount's read.
    if (row && row.updated_at > stamp) continue;
    const vec = Object.fromEntries(VEC_KEYS.map((k) => [k, s[k]]));
    const fields = { ...vec, first_at: s.first_at, last_at: s.last_at, updated_at: stamp, ...(s.person_key !== undefined ? { label: s.label, anonymous: s.anonymous } : {}) };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("replay_tallies", { workspace: owner.workspace, source_id: owner.source_id, ...(s.person_key !== undefined ? { person_key: s.person_key } : { shard: s.shard }), ...fields });
  }
}

// ── Reading them (lib/replayReads.ts browseCore) ──

/**
 * Whether a filter is one the tallies answer: no filter but the active-time
 * floor, at none or the default. Any other filter is counted by the scan.
 */
export function tallyAnswers(m: ReplayMatch): boolean {
  if (m.q || m.person || m.has?.length || m.min_ms !== undefined || m.max_ms !== undefined || m.group || m.since !== undefined) return false;
  if (REPLAY_ENV_KEYS.some((k) => m[k])) return false;
  return !m.active_min_ms || m.active_min_ms === REPLAY_ACTIVE_DEFAULT_MS;
}

/** The totals and people a scope's tally rows say, under the floor or without it. */
export function readTallies(rows: readonly Pick<Doc<"replay_tallies">, keyof Vec | "person_key" | "label" | "anonymous" | "first_at" | "last_at">[], floor: boolean): { total: number; below: number; oldest_at: number | null; people: ReplayPerson[] } {
  let total = 0;
  let below = 0;
  let oldest = Infinity;
  const by = new Map<string, ReplayPerson & { short: number }>();
  for (const r of rows) {
    const shown = floor ? r.n - r.short_n : r.n;
    total += shown;
    if (floor) below += r.short_n;
    if (shown > 0) oldest = Math.min(oldest, r.first_at);
    if (r.person_key === undefined || shown <= 0) continue;
    const p = by.get(r.person_key) ?? { key: r.person_key, label: r.label ?? r.person_key, anonymous: r.anonymous ?? true, sessions: 0, ms: 0, errors: 0, failed: 0, last_at: 0, url: null, env: null, short: 0 };
    p.sessions += shown;
    p.ms += floor ? r.ms - r.short_ms : r.ms;
    p.errors += floor ? r.errors - r.short_errors : r.errors;
    p.failed += floor ? r.failed - r.short_failed : r.failed;
    if (floor) p.short += r.short_n;
    if (r.last_at >= p.last_at) Object.assign(p, { last_at: r.last_at, label: r.label ?? p.label, anonymous: r.anonymous ?? p.anonymous });
    by.set(r.person_key, p);
  }
  return { total, below, oldest_at: Number.isFinite(oldest) ? oldest : null, people: [...by.values()] };
}

/**
 * The tally rows of a scope, or null when a source in it has not been counted
 * whole yet (no replay_tally_at, and recordings): the scan answers then.
 */
export async function scopeTallies(ctx: Db, workspaceKey: string, sourceId: Id<"event_sources"> | null): Promise<Doc<"replay_tallies">[] | null> {
  const sources: Doc<"event_sources">[] = sourceId
    ? [await ctx.db.get(sourceId)].filter(Boolean)
    : await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspaceKey)).collect();
  for (const s of sources) {
    if (s.replay_tally_at !== undefined) continue;
    const any = await ctx.db.query("replays").withIndex("by_source_started", (q: any) => q.eq("source_id", s._id)).first();
    if (any) return null;
  }
  const rows: Doc<"replay_tallies">[] = sourceId
    ? await ctx.db.query("replay_tallies").withIndex("by_source_person", (q: any) => q.eq("source_id", sourceId)).collect()
    : await ctx.db.query("replay_tallies").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).collect();
  return rows.filter((r) => r.workspace === workspaceKey);
}
