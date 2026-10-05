// The plan's routine limits for hosted conversations (plan pl-840, spec
// "Plans"). A routine bound to a hosted conversation fires from the server
// (agentTasks.cloudTriggerConversation) and every firing wakes a paid turn,
// so the plan bounds how many may be armed and how often one repeats. The
// numbers live in PLANS; routineRefusal holds the rule. This module only
// gathers the facts it needs, and is a leaf so agentTasks can import it.
import type { Id } from "../_generated/dataModel";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { planOf, routineRefusal, type RoutineShape } from "@codecast/shared/contracts/assistant";

// The statuses that count as armed: a paused routine fires nothing.
const ARMED_STATUSES = ["scheduled", "running"] as const;

export type HostedRoutine = RoutineShape & {
  _id?: Id<"agent_tasks">;
  user_id: Id<"users">;
  originating_conversation_id?: Id<"conversations"> | string | null;
  created_at?: number;
};

/** Why the owner's plan refuses this routine, or null when it fits or the
 *  routine is not bound to a hosted conversation. A routine not yet created
 *  (no created_at) counts every armed hosted routine before it. */
export async function hostedRoutineRefusal(ctx: { db: any }, routine: HostedRoutine): Promise<string | null> {
  if (!routine.originating_conversation_id) return null;
  const home = await ctx.db.get(routine.originating_conversation_id);
  if (!home || !isHostedAgentType(home.agent_type)) return null;
  const wallet = await ctx.db.query("wallets").withIndex("by_user", (q: any) => q.eq("user_id", routine.user_id)).first();
  const plan = planOf(wallet?.plan);

  let armedBefore = 0;
  if (plan.routines.max !== null) {
    const hosted = new Map<string, boolean>([[String(home._id), true]]);
    for (const status of ARMED_STATUSES) {
      const rows = await ctx.db.query("agent_tasks")
        .withIndex("by_user_status", (q: any) => q.eq("user_id", routine.user_id).eq("status", status))
        .collect();
      for (const row of rows) {
        if (routine._id && String(row._id) === String(routine._id)) continue;
        if (routine.created_at !== undefined && row.created_at >= routine.created_at) continue;
        const rowHome = row.originating_conversation_id;
        if (!rowHome) continue;
        let isHosted = hosted.get(String(rowHome));
        if (isHosted === undefined) {
          const conversation = await ctx.db.get(rowHome);
          isHosted = !!conversation && isHostedAgentType(conversation.agent_type);
          hosted.set(String(rowHome), isHosted);
        }
        if (isHosted) armedBefore++;
      }
    }
  }
  return routineRefusal(plan, routine, armedBefore);
}
