import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * The standing triggers armed on one event name, in one status. A firing reads
 * only these (agentTasks.matchTaskTriggers), and a producer asks the same
 * question before it schedules one.
 */
export function armedTriggers(ctx: { db: any }, status: "scheduled" | "running", eventType: string) {
  return ctx.db
    .query("agent_tasks")
    .withIndex("by_status_event_type", (q: any) => q.eq("status", status).eq("event_filter.event_type", eventType));
}

export type TriggerMatchArgs = {
  event_type: string;
  action?: string;
  repository?: string;
  pr_number?: number;
  team_id?: Id<"teams">;
  source?: string;
  workspace?: string;
  event_ref?: {
    external_event_id?: Id<"external_events">;
    group_short_id?: string;
    title: string;
    url?: string;
  };
};

/**
 * Schedule a trigger match for an event, only when some trigger is armed on its
 * name. Every GitHub delivery fires one (check_run alone is thousands an hour)
 * and almost none have a trigger waiting, so an unconditional job per event
 * spent a scheduler slot to read an empty index range. A running trigger counts
 * only for an event that carries a ref, matching what the firing reads.
 */
export async function scheduleTriggerMatch(
  ctx: { db: any; scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  args: TriggerMatchArgs,
): Promise<void> {
  const armed =
    (await armedTriggers(ctx, "scheduled", args.event_type).first()) ??
    (args.event_ref ? await armedTriggers(ctx, "running", args.event_type).first() : null);
  if (!armed) return;
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, args);
}
