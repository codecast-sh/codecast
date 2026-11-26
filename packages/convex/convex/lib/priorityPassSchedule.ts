// When a person's priorities pass runs (Priorities v2 design doc, Backend
// shape 6): soon after their activity, never on a clock. A pin change (a
// session going done included), an answered decision card, a task closing or
// reopening and a correction each ask for a pass in that (person, workspace);
// priorityPassSchedule.ts holds the one job per pair that a burst of asks
// coalesces into.
//
// The pass runs PASS_DEBOUNCE_MS after the last ask of a burst, and no later
// than PASS_MAX_WAIT_MS after its first, so steady activity cannot hold it off
// for good. Automatic passes of one pair start at least PASS_MIN_GAP_MS apart,
// and further apart as they cost more (priorityPassSchedule.ts
// passAllowedAt): the daily ceiling (priorityPassRun PRIORITY_PASS_DAILY_USD,
// $1.50 a pair) is spread over the day rather than spent by noon. Measured on
// prod (Nov 25-26, 26 incremental runs): $0.01 to $0.24 a run, median $0.07,
// mean $0.10; the heaviest pair's runs cost about $0.20 each and a 3-hour
// sweep's chain of six cost $1.25, which reached the ceiling in a day. Pins
// from a role's standing session, a trigger's run or a workflow ask for
// nothing (pinsAskForPass): they come round the clock.
//
// Leaf: the hot paths call passActivity / sessionActivity, which read the
// pair's row (and, for a session, its workspace; with no row, whether the
// feature is on) and schedule the write only when the pair's pending pass
// would move.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isRunLog } from "@codecast/shared/contracts";
import { sessionVisibility } from "./prioritySessionVisibility";
import { isStandingSession } from "./orgOwnership";
import { parseWorkspaceKey } from "./accessKeys";
import { workspaceHasFeature } from "./teamFeatureGuard";
import { isTeamMember } from "../privacy";

const MINUTE = 60_000;
export const PASS_DEBOUNCE_MS = 10 * MINUTE;
export const PASS_MAX_WAIT_MS = 30 * MINUTE;
export const PASS_MIN_GAP_MS = 60 * MINUTE;
/** A pending pass moved by less than this stays as it is: a burst of pins writes the row about once a minute. */
export const PASS_DUE_SLACK_MS = MINUTE;
/** A pending pass this far past its time lost its job (a fire that failed): the next ask schedules a new one. */
export const PASS_DUE_STALE_MS = 5 * MINUTE;

type Pair = { user_id: Id<"users">; workspace: string };
export type PassSchedule = Doc<"priority_pass_schedules">;

export const scheduleRow = (ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<PassSchedule | null> =>
  ctx.db
    .query("priority_pass_schedules")
    .withIndex("by_user_workspace", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .first();

/** The pair has a pass waiting on its job. */
export const pending = (row: PassSchedule | null, now: number): row is PassSchedule & { token: number } =>
  row?.token !== undefined && row.due_at > now - PASS_DUE_STALE_MS;

/**
 * When the pair's pass should run, given an ask at `now` that wants it
 * `delayMs` from now, and since when its burst has been waiting; null when the
 * pending pass already runs then or later (give or take PASS_DUE_SLACK_MS): an
 * ask never pulls a pending pass earlier, so one the gap holds stays held.
 */
export function nextPassDue(row: PassSchedule | null, now: number, delayMs: number): { due_at: number; since: number } | null {
  const live = pending(row, now);
  const since = live ? (row.since ?? now) : now;
  const due_at = Math.min(now + delayMs, since + PASS_MAX_WAIT_MS);
  if (live && due_at < row.due_at + PASS_DUE_SLACK_MS) return null;
  return { due_at, since };
}

// Pairs already asked for in this transaction (a cascade closing fifty tasks asks once per pair).
const askedIn = new WeakMap<object, Set<string>>();

/**
 * Activity in the pair: their pass runs after it settles (priorityPassSchedule.request
 * writes the job). A context with no scheduler (a write helper's bare `{ db }`) asks for nothing.
 */
export async function passActivity(ctx: { db: any; scheduler?: any }, userId: Id<"users">, workspace: string): Promise<void> {
  if (!ctx.scheduler) return;
  const asked = askedIn.get(ctx.db) ?? new Set<string>();
  const key = `${userId}|${workspace}`;
  if (asked.has(key)) return;
  askedIn.set(ctx.db, asked.add(key));
  const row = await scheduleRow(ctx, userId, workspace);
  if (!nextPassDue(row, Date.now(), PASS_DEBOUNCE_MS)) return;
  // A pair with a row had the feature on when it was written; one without is checked here, so the feature off costs reads and no job.
  if (!row && !(await passOn(ctx, userId, workspace))) return;
  await ctx.scheduler.runAfter(0, (internal as any).priorityPassSchedule.request, { user_id: userId, workspace } satisfies Pair);
}

/** Activity in a session: its owner's pass in the workspace it counts in. A workflow's run log is never pass input. */
export async function sessionActivity(ctx: { db: any; scheduler?: any }, conv: Doc<"conversations">): Promise<void> {
  if (isRunLog(conv)) return;
  await passActivity(ctx, conv.user_id, await sessionVisibility(ctx).workspaceOf(conv));
}

/**
 * Whether a session's pins ask for a pass: not a role's standing session, a
 * trigger's run or a workflow's session. A role's recurring output never drives
 * priorities; what the person typed there still counts, and the daily sweep
 * (priorityPassSweep.ts) finds it.
 */
export const pinsAskForPass = (conv: Pick<Doc<"conversations">, "standing_role_id" | "anchor_id" | "agent_task_id" | "workflow_run_id">): boolean =>
  !isStandingSession(conv) && !conv.agent_task_id && !conv.workflow_run_id;

/** Whether the priorities feature is on where the pass would write: a team key only for a member, a personal key only for its own person. */
export async function passOn(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<boolean> {
  const ws = parseWorkspaceKey(workspace);
  if (!ws) return false;
  // The flag first: one read, and false for nearly everyone.
  if (ws.type === "team") return (await workspaceHasFeature(ctx, { team_id: ws.teamId }, "priorities")) && (await isTeamMember(ctx, userId, ws.teamId));
  return String(ws.userId) === String(userId) && (await workspaceHasFeature(ctx, { user_id: userId }, "priorities"));
}
