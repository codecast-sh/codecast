// Generated inputs for the sync-convergence validation suite
// (docs/architecture/sync-convergence.md, "Validation plan"). One seeded
// generator feeds three suites: the shared module's property tests, the
// convex overlay determinism tests, and the web two-replica simulation. Pure
// data, no runtime imports — the fixtures must load in the Convex runtime,
// bun and the browser bundle alike.

import type { ProjectableInboxRow } from "../inboxProjection";

export const GEN_MIN = 60_000;
export const GEN_HOUR = 60 * GEN_MIN;
export const GEN_DAY = 24 * GEN_HOUR;

// mulberry32: a tiny deterministic PRNG so every property run is replayable
// from its seed.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function between(rng: Rng, lo: number, hi: number): number {
  return Math.floor(lo + rng() * (hi - lo));
}

// A 32-character Convex-shaped id from a tag: the web store reads a non-Convex
// id as an optimistic create stub, so every generated row must look real.
export function convexIdFor(tag: string): string {
  const clean = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
  const body = `${clean}z${clean.length}`;
  return body.length >= 32 ? body.slice(0, 32) : body.padEnd(32, "0");
}

// An activity time drawn from the regions the fold and the recency window
// care about: the fresh cluster, the same day, past the 12h gap, and past the
// 30-day horizon.
export function genUpdatedAt(rng: Rng, epoch: number): number {
  const region = rng();
  if (region < 0.45) return epoch - between(rng, 0, GEN_HOUR);
  if (region < 0.7) return epoch - between(rng, GEN_HOUR, 11 * GEN_HOUR);
  if (region < 0.92) return epoch - between(rng, 13 * GEN_HOUR, 29 * GEN_DAY);
  return epoch - between(rng, 31 * GEN_DAY, 40 * GEN_DAY);
}

const AGENT_STATUSES = [undefined, undefined, "working", "idle", "idle", "done", "dormant", "waiting", "stopped", "permission_blocked"] as const;

// ── Shared-module rows (facts already on the row) ───────────────────────────

// `leadTag` names an earlier row this one may join as an agent-team teammate
// (spawned_by + agent_team_name — a rider of that lead's placement).
export function genProjectableRow(rng: Rng, epoch: number, tag: string, leadTag?: string): ProjectableInboxRow & Record<string, unknown> {
  const updated_at = genUpdatedAt(rng, epoch);
  const row: ProjectableInboxRow & Record<string, unknown> = {
    _id: convexIdFor(tag),
    status: chance(rng, 0.85) ? "active" : chance(rng, 0.8) ? "completed" : "failed",
    updated_at,
    message_count: chance(rng, 0.08) ? 0 : between(rng, 1, 40),
    title: chance(rng, 0.03) ? "[Using: claude]" : `Session ${tag}`,
    agent_status: pick(rng, AGENT_STATUSES),
    is_idle: chance(rng, 0.7),
    awaiting_input: chance(rng, 0.08),
    is_unresponsive: chance(rng, 0.03),
    has_pending_messages: chance(rng, 0.05),
  };
  if (chance(rng, 0.04)) row.is_subagent = true;
  if (chance(rng, 0.03)) { row.parent_conversation_id = convexIdFor("parent"); row.parent_message_uuid = chance(rng, 0.5) ? "m1" : undefined; }
  if (leadTag && chance(rng, 0.1)) { row.spawned_by_conversation_id = convexIdFor(leadTag); row.agent_team_name = "team"; }
  if (chance(rng, 0.12)) row.inbox_pinned_at = epoch - between(rng, 0, 40 * GEN_DAY);
  if (chance(rng, 0.1)) row.inbox_dismissed_at = epoch - between(rng, 0, 40 * GEN_DAY);
  if (chance(rng, 0.08)) row.inbox_stashed_at = epoch - between(rng, 0, 40 * GEN_DAY);
  if (chance(rng, 0.05)) row.inbox_killed_at = epoch - between(rng, 0, 10 * GEN_DAY);
  if (chance(rng, 0.1)) row.owned_by_me = true;
  if (chance(rng, 0.04)) row.anchor_id = "anchors_1";
  if (chance(rng, 0.08)) row.armed_trigger_kind = pick(rng, ["standing", "once", "none"]);
  if (chance(rng, 0.05)) row.loop_state = { status: "armed", wakeup_at: epoch + (chance(rng, 0.5) ? GEN_HOUR : -GEN_HOUR), event_at: epoch - GEN_HOUR };
  if (chance(rng, 0.08)) { row.settle_verdict = "done"; row.settle_verdict_at = updated_at + (chance(rng, 0.7) ? 1 : -1); }
  if (chance(rng, 0.06)) row.thread_state_status = pick(rng, ["done", "blocked", "working"]);
  if (chance(rng, 0.05)) row.pending_api_error = true;
  if (chance(rng, 0.05)) row.inbox_dormant_at = updated_at + (chance(rng, 0.7) ? 1 : -1);
  if (chance(rng, 0.3)) row.last_turn_allows_park = chance(rng, 0.6);
  return row;
}

export function genProjectableRows(seed: number, count: number, epoch: number): Array<ProjectableInboxRow & Record<string, unknown>> {
  const rng = makeRng(seed);
  return Array.from({ length: count }, (_, i) =>
    genProjectableRow(rng, epoch, `s${seed}r${i}`, i > 0 ? `s${seed}r${between(rng, 0, i)}` : undefined),
  );
}

// ── Server worlds (conversations + managed_sessions + decisions) ────────────

// The canonical tables a fake Convex db needs for one user. Facts are NOT on
// the conversation rows here: the overlay derives them from managed_sessions,
// exactly as prod does, so a replica only ever learns them from the overlay.
export type GenWorld = {
  conversations: Array<Record<string, any>>;
  managed_sessions: Array<Record<string, any>>;
  session_decisions: Array<Record<string, any>>;
  session_owners: Array<Record<string, any>>;
};

export function genWorld(seed: number, count: number, epoch: number, me: string): GenWorld {
  const rng = makeRng(seed);
  const world: GenWorld = { conversations: [], managed_sessions: [], session_decisions: [], session_owners: [] };
  for (let i = 0; i < count; i++) {
    const tag = `w${seed}c${i}`;
    const _id = convexIdFor(tag);
    const updated_at = genUpdatedAt(rng, epoch);
    const conv: Record<string, any> = {
      _id,
      user_id: me,
      status: chance(rng, 0.88) ? "active" : "completed",
      updated_at,
      started_at: updated_at - GEN_HOUR,
      message_count: chance(rng, 0.06) ? 0 : between(rng, 1, 40),
      last_message_role: "assistant",
      title: chance(rng, 0.03) ? "[Using: claude]" : `Session ${tag}`,
    };
    if (conv.message_count === 0) delete conv.last_message_role;
    // An agent-team teammate of an earlier row: a rider of that lead's placement.
    if (i > 0 && chance(rng, 0.1)) { conv.spawned_by_conversation_id = convexIdFor(`w${seed}c${between(rng, 0, i)}`); conv.agent_team_name = "team"; }
    if (chance(rng, 0.12)) conv.inbox_pinned_at = epoch - between(rng, 0, 40 * GEN_DAY);
    if (chance(rng, 0.1)) conv.inbox_dismissed_at = epoch - between(rng, 0, 40 * GEN_DAY);
    if (chance(rng, 0.08)) conv.inbox_stashed_at = epoch - between(rng, 0, 40 * GEN_DAY);
    if (chance(rng, 0.04)) conv.inbox_killed_at = epoch - between(rng, 0, 10 * GEN_DAY);
    if (chance(rng, 0.04)) conv.anchor_id = "anchors_1";
    if (chance(rng, 0.08)) conv.armed_trigger_kind = pick(rng, ["standing", "once"]);
    if (chance(rng, 0.06)) conv.thread_state_status = pick(rng, ["done", "blocked"]);
    if (chance(rng, 0.05)) conv.pending_api_error = true;
    if (chance(rng, 0.05)) conv.inbox_dormant_at = updated_at + 1;
    if (chance(rng, 0.05)) conv.has_pending_messages = true;
    world.conversations.push(conv);
    if (chance(rng, 0.45)) {
      const agent_status = pick(rng, ["working", "idle", "done", "dormant", "waiting", "stopped", "permission_blocked"] as const);
      world.managed_sessions.push({
        _id: `ms_${tag}`,
        user_id: me,
        conversation_id: _id,
        last_heartbeat: epoch - (chance(rng, 0.85) ? between(rng, 0, 20_000) : between(rng, 5 * GEN_MIN, GEN_DAY)),
        agent_status,
        agent_status_updated_at: epoch - between(rng, 0, chance(rng, 0.8) ? 30 * GEN_MIN : 3 * GEN_HOUR),
      });
    }
    if (chance(rng, 0.05)) {
      world.session_decisions.push({ _id: `sd_${tag}`, user_id: me, conversation_id: _id, status: "pending", created_at: epoch - GEN_MIN });
    }
  }
  return world;
}

// ── Fixture-file row expansion ───────────────────────────────────────────────

// Golden fixture files describe rows either literally or as a `repeat`
// block, so a cap-overflow case (101 pins) stays readable. Time fields are
// written relative to the fixture epoch ("E-2h", "E+30m", "E-31d") so a reader
// sees the rule a row exercises instead of a 13-digit number. `step` values
// (ms) are added per index to the base row's numeric fields.
export type FixtureRepeat = { count: number; idPrefix: string; row: Record<string, unknown>; step?: Record<string, number> };
export type FixtureRowSpec = Record<string, unknown> | { repeat: FixtureRepeat };

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: GEN_MIN, h: GEN_HOUR, d: GEN_DAY };

// "E", "E-2h", "E+30m", "E-30d-1ms": the epoch plus any chain of offsets.
export function resolveEpochRelative(value: unknown, epoch: number): unknown {
  if (typeof value !== "string") return value;
  if (!/^E(?:[+-]\d+(?:\.\d+)?(?:ms|s|m|h|d)?)*$/.test(value)) return value;
  let out = epoch;
  for (const m of value.slice(1).matchAll(/([+-]\d+(?:\.\d+)?)(ms|s|m|h|d)?/g)) {
    out += Number(m[1]) * UNIT_MS[m[2] ?? "ms"];
  }
  return out;
}

function resolveRow(row: Record<string, unknown>, epoch: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v)
      ? resolveRow(v as Record<string, unknown>, epoch)
      : resolveEpochRelative(v, epoch);
  }
  // Ids are written as tags: the row's own, and the parent / lead pointers
  // that name another row of the fixture.
  for (const k of ["_id", "parent_conversation_id", "spawned_by_conversation_id"]) {
    if (typeof out[k] === "string" && (out[k] as string).length !== 32) out[k] = convexIdFor(out[k] as string);
  }
  return out;
}

export function expandFixtureRows(specs: FixtureRowSpec[], epoch: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const rep = (spec as { repeat?: FixtureRepeat }).repeat;
    if (!rep) {
      out.push(resolveRow(spec as Record<string, unknown>, epoch));
      continue;
    }
    const base = resolveRow(rep.row, epoch);
    for (let i = 0; i < rep.count; i++) {
      const row: Record<string, unknown> = { ...base, _id: convexIdFor(`${rep.idPrefix}${i}`) };
      for (const [field, delta] of Object.entries(rep.step ?? {})) {
        row[field] = (Number(base[field]) || 0) + delta * i;
      }
      out.push(row);
    }
  }
  return out;
}
