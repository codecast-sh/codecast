// The one pending pass per (person, workspace) that their activity asks for
// (lib/priorityPassSchedule.ts has the timing and the hooks' side). `request`
// writes the pair's row and its job; `fire` starts the pass once it is due
// and the pair's last paid run (priority_pass_runs, `cast priorities run`
// included) is PASS_MIN_GAP_MS behind, else waits.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PASS_DEBOUNCE_MS, PASS_MIN_GAP_MS, nextPassDue, pending, scheduleRow } from "./lib/priorityPassSchedule";
import { RESERVATION_TTL_MS, recentRuns } from "./priorityPassInputs";
import { passOn } from "./priorityPassRun";

// Codegen catches up on the next push.
const self = (internal as any).priorityPassSchedule;
const run = (internal as any).priorityPassRun;

const pair = { user_id: v.id("users"), workspace: v.string() };

/** When the pair's next pass may start by the gap: PASS_MIN_GAP_MS after the last run that asked the model or still holds the pair. */
export async function gapEnds(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number> {
  const last = (await recentRuns(ctx, userId, workspace)).find(
    (r) => r.status === "ok" || r.status === "error" || (r.cost_usd ?? 0) > 0 || (r.status === "running" && r.started_at > now - RESERVATION_TTL_MS),
  );
  return last ? last.started_at + PASS_MIN_GAP_MS : -Infinity;
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
async function requestPass(ctx: { db: any; scheduler: any }, userId: Id<"users">, workspace: string, delayMs: number): Promise<number | null> {
  const now = Date.now();
  const row = await scheduleRow(ctx, userId, workspace);
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

/** What a hook asks for (lib/priorityPassSchedule passActivity): a pass PASS_DEBOUNCE_MS after this activity. */
export const request = internalMutation({
  args: pair,
  handler: async (ctx, args): Promise<number | null> => requestPass(ctx, args.user_id, args.workspace, PASS_DEBOUNCE_MS),
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
