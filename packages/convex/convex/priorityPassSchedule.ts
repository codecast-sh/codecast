// The one pending pass per (person, workspace) that their activity asks for
// (lib/priorityPassSchedule.ts has the timing and the hooks' side). `request`
// writes the pair's row and its job; `fire` starts the pass once it is due
// and the pair's spend allows it (passAllowedAt), else waits.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { PASS_DEBOUNCE_MS, PASS_SOON_MS, nextPassDue, passOn, pending, scheduleRow } from "./lib/priorityPassSchedule";
import { DAY, MINUTE, RESERVATION_TTL_MS } from "./priorityPassInputs";
import { PRIORITY_PASS_DAILY_USD, isPaidRun, runsOfDay } from "./priorityPassRun";

// Codegen catches up on the next push.
const self = (internal as any).priorityPassSchedule;
const run = (internal as any).priorityPassRun;

const pair = { user_id: v.id("users"), workspace: v.string() };

/** Runs that start within this of the run before are one pass: a chain's runs start seconds apart. */
const PASS_SPAN_MS = 10 * MINUTE;
/** The share of the daily ceiling the bucket refills with in a day; the rest is its capacity's room. */
export const PASS_PACE_SHARE = 0.8;
/** The bucket holds about this many passes, so a burst of work gets a few hourly passes before the pace sets in. */
export const PASS_BUCKET_PASSES = 3;
/** The slowest the bucket refills, as a share of the ceiling a day: a pass dearer than the whole ceiling still waits a finite time. */
export const PASS_MIN_REFILL_SHARE = 0.05;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * When the pair's next automatic pass may start, from its runs of the last
 * day (newest first): once a token bucket of dollars holds one expected pass
 * (the median of the day's passes, a chain counted as one). No fixed gap
 * between passes (Jason, Nov 26): spend paces them, and a pass already
 * running coalesces the next ask into itself (runPass).
 *
 * The bucket refills at PASS_PACE_SHARE of PRIORITY_PASS_DAILY_USD a day and
 * holds PASS_BUCKET_PASSES expected passes, but never more than the ceiling
 * leaves beside a day's refill (capacity + a day's refill <= the ceiling, so
 * no day's spend reaches it), and never less than one pass (the refill slows
 * instead, never below PASS_MIN_REFILL_SHARE of the ceiling a day, so a
 * median pass at or past the ceiling waits days, not forever). Its level is replayed from the day's runs, full a day ago, so it
 * needs no stored state. Catch-up runs spend their own allowance and count
 * only as the last run.
 */
export function passAllowedAt(day: Doc<"priority_pass_runs">[], now: number, ceiling = PRIORITY_PASS_DAILY_USD): number {
  const last = day.find((r) => isPaidRun(r) || (r.status === "running" && r.started_at > now - RESERVATION_TTL_MS));
  if (!last) return -Infinity;
  const paid = day.filter((r) => isPaidRun(r) && !r.catch_up).reverse();
  const passes: number[] = [];
  let prev = -Infinity;
  for (const r of paid) {
    if (r.started_at - prev > PASS_SPAN_MS) passes.push(0);
    passes[passes.length - 1] += r.cost_usd ?? 0;
    prev = r.started_at;
  }
  const expected = median(passes);
  const capacity = Math.max(expected, Math.min(PASS_BUCKET_PASSES * expected, (1 - PASS_PACE_SHARE) * ceiling));
  const perMs = Math.max(PASS_MIN_REFILL_SHARE * ceiling, Math.min(PASS_PACE_SHARE * ceiling, ceiling - capacity)) / DAY;
  let level = capacity;
  let at = now - DAY;
  for (const r of paid) {
    level = Math.min(capacity, level + (r.started_at - at) * perMs) - (r.cost_usd ?? 0);
    at = r.started_at;
  }
  level = Math.min(capacity, level + (now - at) * perMs);
  const ready = level >= expected ? now : now + (expected - level) / perMs;
  return ready;
}

/** When the pair's next pass may start by its spend (passAllowedAt). */
export async function gapEnds(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number> {
  return passAllowedAt(await runsOfDay(ctx, userId, workspace, now), now);
}

/** When the pair's pending pass runs, or null when none is pending. */
export async function scheduledPassAt(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number | null> {
  const row = await scheduleRow(ctx, userId, workspace);
  return pending(row, now) ? Math.max(row.due_at, await gapEnds(ctx, userId, workspace, now)) : null;
}

/**
 * A pass for the pair, `delayMs` from now (nextPassDue), folded into the one
 * already pending, whose job waits on to the later time. A new pending pass
 * needs the feature on where it would write. Returns when it is due, or null
 * when nothing changed.
 */
async function requestPass(ctx: { db: any; scheduler: any }, userId: Id<"users">, workspace: string, delayMs: number, soon = false): Promise<number | null> {
  const now = Date.now();
  const row = await scheduleRow(ctx, userId, workspace);
  // A "soon" ask moves a pass pending later to now + delayMs: a new job and token, so the later job stands down when it fires.
  if (soon && pending(row, now) && now + delayMs < row.due_at) {
    const token = now;
    const due_at = now + delayMs;
    await ctx.scheduler.runAt(due_at, self.fire, { user_id: userId, workspace, token });
    await ctx.db.patch(row._id, { due_at, token });
    return due_at;
  }
  const next = nextPassDue(row, now, delayMs);
  if (!next) return null;
  if (pending(row, now)) {
    await ctx.db.patch(row._id, { due_at: next.due_at });
    return next.due_at;
  }
  if (!(await passOn(ctx, userId, workspace))) return null;
  const token = now;
  await ctx.scheduler.runAt(next.due_at, self.fire, { user_id: userId, workspace, token });
  const fields = { due_at: next.due_at, since: next.since, token };
  if (row) await ctx.db.patch(row._id, fields);
  else await ctx.db.insert("priority_pass_schedules", { user_id: userId, workspace, ...fields });
  return next.due_at;
}

/** What a hook asks for: a pass PASS_DEBOUNCE_MS after this activity (passActivity), or PASS_SOON_MS and earlier than one pending (passSoon). */
export const request = internalMutation({
  args: { ...pair, soon: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<number | null> =>
    requestPass(ctx, args.user_id, args.workspace, args.soon ? PASS_SOON_MS : PASS_DEBOUNCE_MS, !!args.soon),
});

/** The pair's job: stands down when another job owns the row, waits while the pass is not due or the gap holds it, else starts the pass. */
export const fire = internalMutation({
  args: { ...pair, token: v.number() },
  handler: async (ctx, args): Promise<"superseded" | "waiting" | "started"> => {
    const row = await scheduleRow(ctx, args.user_id, args.workspace);
    if (!row || row.token !== args.token) return "superseded";
    const now = Date.now();
    const due_at = Math.max(row.due_at, await gapEnds(ctx, args.user_id, args.workspace, now));
    if (due_at > now) {
      if (due_at !== row.due_at) await ctx.db.patch(row._id, { due_at });
      await ctx.scheduler.runAt(due_at, self.fire, args);
      return "waiting";
    }
    await ctx.db.patch(row._id, { token: undefined, since: undefined });
    await ctx.scheduler.runAfter(0, run.runPass, { user_id: args.user_id, workspace: args.workspace });
    return "started";
  },
});

/** Passes for many pairs (the daily sweep, a feature turned on), `stagger_ms` apart from now. */
export const requestMany = internalMutation({
  args: { pairs: v.array(v.object(pair)), stagger_ms: v.number() },
  handler: async (ctx, args): Promise<void> => {
    for (const [i, p] of args.pairs.entries()) await requestPass(ctx, p.user_id, p.workspace, i * args.stagger_ms);
  },
});
