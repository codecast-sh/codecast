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

// The statuses that count as armed: a paused routine fires nothing.
const ARMED_STATUSES = ["scheduled", "running"] as const;

export const HOSTED_ROUTINE_NOT_OWNER = "Only the owner can set a routine on a hosted assistant conversation";

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
  const home = await ctx.db.get(routine.originating_conversation_id);
  if (!home || !isHostedAgentType(home.agent_type)) return null;
  if (String(home.user_id) !== String(routine.user_id)) return HOSTED_ROUTINE_NOT_OWNER;
  if (routine.status === "paused") return null;

  const plan = await walletPlan(ctx, routine.user_id);

  let armedOthers = 0;
  if (plan.routines.max !== null) {
    const hosted = new Map<string, boolean>([[String(home._id), true]]);
    for (const status of ARMED_STATUSES) {
      const rows = await ctx.db.query("agent_tasks")
        .withIndex("by_user_status", (q: any) => q.eq("user_id", routine.user_id).eq("status", status))
        .collect();
      for (const row of rows) {
        if (routine._id && String(row._id) === String(routine._id)) continue;
        if (opts.olderOnly && !olderThan(row, routine)) continue;
        const rowHome = row.originating_conversation_id;
        if (!rowHome) continue;
        let isHosted = hosted.get(String(rowHome));
        if (isHosted === undefined) {
          const conversation = await ctx.db.get(rowHome);
          isHosted = !!conversation && isHostedAgentType(conversation.agent_type);
          hosted.set(String(rowHome), isHosted);
        }
        if (isHosted) armedOthers++;
      }
    }
  }
  return routineRefusal(plan, routine, armedOthers);
}
