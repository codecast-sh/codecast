// When the per-session classifier runs (priorityClassifier.ts has the call):
// at the person's first typed message, so the session shows its priority in
// seconds; then at its title, its pins and the person's later messages only
// while its last answer was "new", and never once it is filed (Study 1,
// ct-102386: the first message and the title decide most sessions, and
// reading on after a filing breaks as many answers as it fixes; the pass, not
// the classifier, revises a filing). Again over the pair's sessions it left
// unassigned once a pass creates a priority or milestone. Only behind the
// priority_classifier feature, which needs priorities on as well.
//
// Every ask writes a pending priority_classifications row holding the call's
// worst case; a pair's rows of the last day, settled at their cost and
// pending at their hold, stay under CLASSIFIER_DAILY_USD. This is its own cap,
// apart from the pass's token bucket (priorityPassSchedule passAllowedAt),
// which reads only pass runs: a classification is about a thousandth of a pass.
//
// Leaf: the hot paths (a title written, a pin changed, a plan applied) call
// askClassifier / askRerun, which read an index row or two before anything.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sessionVisibility } from "./prioritySessionVisibility";
import { machineSession, passOn, prioritiesOn, prioritiesPossibleFor } from "./priorityPassSchedule";
import { parseWorkspaceKey } from "./accessKeys";
import { workspaceHasFeature } from "./teamFeatureGuard";
import { worstCaseCost } from "./teamBudget";
import { CLASSIFIER_CAPS, PRIORITY_CLASSIFIER_MODEL, PRIORITY_CLASSIFIER_SYSTEM } from "./priorityClassifier";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** What one (person, workspace) may spend on classifications in a day: about 150 calls at the worst case, many more at the usual cost. */
export const CLASSIFIER_DAILY_USD = 0.25;
/** A re-run waits this long after a new priority or milestone, so a chain of passes settles first. */
export const RERUN_DELAY_MS = 10 * MINUTE;
/** A re-run looks back this far for sessions the classifier left unassigned. */
export const RERUN_WINDOW_MS = 14 * DAY;
/** The most sessions one re-run asks about, newest first. */
export const RERUN_MAX = 40;
const RERUN_READ = 500;
const RERUN_STAGGER_MS = 2_000;
/** The most of a pair's classifications a cap check reads. */
const DAY_READ = 1_000;

// Codegen catches up on the next push.
const fns = () => (internal as any).priorityClassifier;

/** The worst a call can cost: the largest prompt and every output token. */
export const CLASSIFY_HOLD_USD = worstCaseCost(PRIORITY_CLASSIFIER_MODEL, CLASSIFIER_CAPS.prompt_chars + PRIORITY_CLASSIFIER_SYSTEM.length, CLASSIFIER_CAPS.max_tokens);

/**
 * The sessions the classifier reads: never a machine's (machineSession: a
 * role's standing session, a trigger's run, a workflow's run log or one of its
 * station agents), nor a Task-tool subagent, which rolls up under its parent
 * (lib/priorityLinks inheritLink). A worker is read: it takes its parent's
 * placement when that has one.
 */
export const classifierReads = (conv: Doc<"conversations">): boolean => !machineSession(conv) && !conv.is_subagent;

/** Whether the classifier may run where it would write: the priorities feature on there (passOn) and the classifier's own flag, by the same rule. */
export async function classifierOn(ctx: { db: any }, userId: Id<"users">, workspace: string): Promise<boolean> {
  const ws = parseWorkspaceKey(workspace);
  // The priorities flag first (one read for a team), then the classifier's, then membership.
  if (!ws || !(await prioritiesOn(ctx, workspace))) return false;
  const flag = await workspaceHasFeature(ctx, ws.type === "team" ? { team_id: ws.teamId } : { user_id: userId }, "priority_classifier");
  return flag && (await passOn(ctx, userId, workspace));
}

/** What the pair's classifications of the last day spent, a pending one at its hold. */
export async function spentToday(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<number> {
  const rows: Doc<"priority_classifications">[] = await ctx.db
    .query("priority_classifications")
    .withIndex("by_user_workspace_at", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).gte("at", now - DAY))
    .take(DAY_READ);
  return rows.reduce((sum, r) => sum + (r.status === "pending" ? r.held_usd : (r.cost_usd ?? 0)), 0);
}

/** What the pair may still hold today, read once per mutation. */
const roomToday = async (ctx: { db: any }, userId: Id<"users">, workspace: string) => ({ left: CLASSIFIER_DAILY_USD - (await spentToday(ctx, userId, workspace, Date.now())) });

/** What asked: the session's title, its pin, or a re-run after a new priority or milestone. */
export type ClassifyTrigger = "message" | "title" | "pin" | "rerun";

/** Asks about one session `delayMs` from now, when the pair's day has room for its hold. Returns whether it asked. */
async function enqueue(ctx: { db: any; scheduler: any }, conv: Doc<"conversations">, workspace: string, trigger: ClassifyTrigger, delayMs: number, room: { left: number }): Promise<boolean> {
  const at = Date.now();
  if (room.left < CLASSIFY_HOLD_USD) return false;
  room.left -= CLASSIFY_HOLD_USD;
  const classification_id = await ctx.db.insert("priority_classifications", {
    user_id: conv.user_id, workspace, conversation_id: conv._id, at, trigger, status: "pending", model: PRIORITY_CLASSIFIER_MODEL, held_usd: CLASSIFY_HOLD_USD,
  });
  await ctx.scheduler.runAfter(delayMs, fns().classify, { classification_id });
  return true;
}

/** The most asks one session gets, read in one index range to decide whether to ask again. */
export const ASKS_PER_SESSION = 12;

/**
 * Whether a typed message, title or pin asks: the session's first ask, or a
 * later one while the last answered "new" and none is still pending, up to
 * ASKS_PER_SESSION. A filed session never reaches here (askClassifier).
 */
export function asksNow(asks: Array<Pick<Doc<"priority_classifications">, "status" | "at">>): boolean {
  if (!asks.length) return true;
  if (asks.length >= ASKS_PER_SESSION || asks.some((a) => a.status === "pending")) return false;
  return asks.reduce((a, b) => (b.at > a.at ? b : a)).status === "new";
}

/**
 * The person typed into a session, or it got a title or a pin: while it is mapped nowhere and asksNow
 * says so, the classifier places it (classifierReads). A context with no
 * scheduler asks for nothing.
 */
export async function askClassifier(ctx: { db: any; scheduler?: any }, conv: Doc<"conversations">, trigger: "message" | "title" | "pin"): Promise<boolean> {
  if (!ctx.scheduler || conv.priority_id || !classifierReads(conv) || !(await prioritiesPossibleFor(ctx, conv))) return false;
  const workspace = await sessionVisibility(ctx).workspaceOf(conv);
  if (!(await classifierOn(ctx, conv.user_id, workspace))) return false;
  const asks = await ctx.db.query("priority_classifications").withIndex("by_conversation_at", (q: any) => q.eq("conversation_id", conv._id)).take(ASKS_PER_SESSION);
  if (!asksNow(asks)) return false;
  return enqueue({ db: ctx.db, scheduler: ctx.scheduler }, conv, workspace, trigger, 0, await roomToday(ctx, conv.user_id, workspace));
}

/** A pass created a priority or milestone in the pair: after RERUN_DELAY_MS, the classifier asks again about what it left unassigned. */
export async function askRerun(ctx: { db: any; scheduler?: any }, userId: Id<"users">, workspace: string): Promise<void> {
  if (!ctx.scheduler || !(await classifierOn(ctx, userId, workspace))) return;
  await ctx.scheduler.runAfter(RERUN_DELAY_MS, fns().rerun, { user_id: userId, workspace, since: Date.now() });
}

/**
 * The re-run: each of the pair's sessions the classifier asked about in the
 * last RERUN_WINDOW_MS, still unassigned and last asked before `since` (when
 * the new priority or milestone appeared), newest first, up to RERUN_MAX. A
 * session asked since, a pending ask included, already saw it, so a burst of
 * re-runs asks about each session once.
 */
export async function rerunUnassigned(ctx: { db: any; scheduler: any }, userId: Id<"users">, workspace: string, since: number): Promise<number> {
  if (!(await classifierOn(ctx, userId, workspace))) return 0;
  const rows: Doc<"priority_classifications">[] = await ctx.db
    .query("priority_classifications")
    .withIndex("by_user_workspace_at", (q: any) => q.eq("user_id", userId).eq("workspace", workspace).gte("at", Date.now() - RERUN_WINDOW_MS))
    .order("desc")
    .take(RERUN_READ);
  const vis = sessionVisibility(ctx);
  const room = await roomToday(ctx, userId, workspace);
  const seen = new Set<string>();
  let asked = 0;
  for (const r of rows) {
    const key = String(r.conversation_id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.at >= since) continue;
    const conv: Doc<"conversations"> | null = await ctx.db.get(r.conversation_id);
    if (!conv || conv.priority_id || !classifierReads(conv) || (await vis.workspaceOf(conv)) !== workspace) continue;
    if (!(await enqueue(ctx, conv, workspace, "rerun", asked * RERUN_STAGGER_MS, room))) break;
    if (++asked >= RERUN_MAX) break;
  }
  return asked;
}
