// The plan's routine limits for hosted conversations (plan pl-840, spec
// "Plans"). A routine bound to a hosted conversation fires from the server
// (agentTasks.cloudTriggerConversation) and every firing wakes a paid turn,
// so the plan bounds how many may be armed and how often one repeats. The
// numbers live in PLANS; routineRefusal holds the rule. This module only
// gathers the facts it needs, and is a leaf so agentTasks can import it.
import type { Id } from "../_generated/dataModel";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { routineRefusal, type RoutineShape } from "@codecast/shared/contracts/assistant";
import { walletPlan } from "../lib/wallet";
import { cadenceAt, nextCadenceRun, type WallCadence } from "@platform/assistant/cadence";
import { wallClockAt } from "@platform/assistant/zone";

// The statuses that count as armed: a paused routine fires nothing.
const ARMED_STATUSES = ["scheduled", "running"] as const;

export const HOSTED_ROUTINE_NOT_OWNER = "Only the owner can set a routine on a hosted assistant conversation";

// A hosted conversation takes input from its owner alone
// (canSendProductMessage), and a routine anchored on one is input to it: its
// prompt, focus and schedule wake paid turns that run with the owner's
// connectors. This is the one definition of that rule: the reason `userId`
// may not anchor a routine on these conversations, or null when every hosted
// one among them is theirs. Callers pass the user they answer for (the
// routine's owner, or the person editing or arming it).
export async function hostedOwnerRefusal(
  ctx: { db: any },
  userId: Id<"users"> | string,
  anchors: Array<Id<"conversations"> | string | null | undefined>,
): Promise<string | null> {
  for (const id of new Set(anchors.filter(Boolean).map(String))) {
    const conversation = await ctx.db.get(id);
    if (conversation && isHostedAgentType(conversation.agent_type) && String(conversation.user_id) !== String(userId)) {
      return HOSTED_ROUTINE_NOT_OWNER;
    }
  }
  return null;
}

// The agent_tasks.hosted_home stamp for a routine whose home is `homeId`:
// true when the home is a hosted conversation, else absent. This is the one
// definition of "this routine's home is hosted": agentTasks writes it on every
// row (insertTask, patchTask, backfillHostedHome), and the plan limit and the
// dispatcher read the stamp rather than deriving it again.
export async function hostedHomeStamp(
  ctx: { db: any },
  homeId: Id<"conversations"> | string | null | undefined,
): Promise<true | undefined> {
  const home = homeId ? await ctx.db.get(homeId) : null;
  return home && isHostedAgentType(home.agent_type) ? true : undefined;
}

export type HostedRoutine = RoutineShape & {
  _id?: Id<"agent_tasks">;
  _creationTime?: number;
  user_id: Id<"users">;
  originating_conversation_id?: Id<"conversations"> | string | null;
  created_at?: number;
  status?: string;
};

type Order = { created_at?: number; _creationTime?: number; _id?: unknown };

// A total order on routines: creation time, then insertion time, then id, so
// routines created in one mutation (a template install) still rank the same
// way on every check.
function olderThan(a: Order, b: Order): boolean {
  const ka = [a.created_at ?? 0, a._creationTime ?? 0];
  const kb = [b.created_at ?? 0, b._creationTime ?? 0];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
  return String(a._id) < String(b._id);
}

/** Why this routine is refused on a hosted conversation, or null when it fits
 *  or its home is not hosted. Only the conversation's owner may set one, on
 *  any status. A paused routine is checked against the plan when it is armed.
 *
 *  Arming (create, resume, activate, run now, an edit) counts every OTHER
 *  armed hosted routine the person has. `olderOnly` is for the dispatcher's
 *  recheck of a routine already armed: it counts only the routines older
 *  than this one, so when a plan shrinks the newest pause first. */
export async function hostedRoutineRefusal(
  ctx: { db: any },
  routine: HostedRoutine,
  opts: { olderOnly?: boolean } = {},
): Promise<string | null> {
  if (!routine.originating_conversation_id) return null;
  const ownerRefusal = await hostedOwnerRefusal(ctx, routine.user_id, [routine.originating_conversation_id]);
  if (ownerRefusal) return ownerRefusal;
  if (!(await hostedHomeStamp(ctx, routine.originating_conversation_id))) return null;
  if (routine.status === "paused") return null;

  const plan = await walletPlan(ctx, routine.user_id);

  let armedOthers = 0;
  if (plan.routines.max !== null) {
    for (const status of ARMED_STATUSES) {
      const rows = await ctx.db.query("agent_tasks")
        .withIndex("by_user_status", (q: any) => q.eq("user_id", routine.user_id).eq("status", status))
        .collect();
      for (const row of rows) {
        if (routine._id && String(row._id) === String(routine._id)) continue;
        if (opts.olderOnly && !olderThan(row, routine)) continue;
        if (row.hosted_home === true) armedOthers++;
      }
    }
  }
  return routineRefusal(plan, routine, armedOthers);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The stored shape of agent_tasks.cadence. */
export type StoredCadence = WallCadence;

// A hosted routine said as a time of day keeps that time on the person's
// clock (@platform/assistant cadence): a daily or weekly repeat, or one on
// listed weekdays, is stored with a wall-clock cadence in their zone, so a
// daylight saving change moves nothing and "weekdays" skips the weekend. A
// repeat of hours ("every 3 hours") stays a plain interval. This is the one
// rule for it: insertTask applies it to every new routine and applyTaskUpdate
// to every schedule edit, whichever surface (the assistant's tool, the web
// form) set it. `weekdays` overrides the days the interval implies; `kept`
// is the cadence the routine had, whose days survive an edit of its time.
// Returns the cadence and the first run it makes (on or after `run_at`), or
// null when the routine runs on an interval.
export async function hostedWallCadence(
  ctx: { db: any },
  routine: { user_id: Id<"users">; hosted: boolean; schedule_type: string; interval_ms?: number; run_at?: number; weekdays?: number[]; kept?: StoredCadence },
): Promise<{ cadence: StoredCadence; run_at: number } | null> {
  if (!routine.hosted || routine.schedule_type !== "recurring" || !routine.run_at) return null;
  const daily = routine.interval_ms === DAY_MS;
  if (!routine.weekdays?.length && !daily && routine.interval_ms !== WEEK_MS) return null;
  const user = await ctx.db.get(routine.user_id);
  const zone = user?.timezone ?? routine.kept?.zone;
  const weekdays = routine.weekdays?.length
    ? routine.weekdays
    : daily
      ? routine.kept?.weekdays
      : [wallClockAt(routine.run_at, zone).weekday];
  const cadence = cadenceAt(routine.run_at, zone, weekdays);
  return { cadence, run_at: nextCadenceRun(cadence, routine.run_at - 1) };
}
