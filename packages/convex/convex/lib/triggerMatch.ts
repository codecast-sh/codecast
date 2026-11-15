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

/** The standing triggers watching one chat channel, in one status. A chat
 *  line reads only these, so a channel nobody watches costs one empty range. */
export function channelTriggers(ctx: { db: any }, status: "scheduled" | "running", channelId: string) {
  return ctx.db
    .query("agent_tasks")
    .withIndex("by_channel_status", (q: any) => q.eq("event_filter.channel_id", channelId).eq("status", status));
}

export type TriggerMatchArgs = {
  event_type: string;
  action?: string;
  repository?: string;
  pr_number?: number;
  team_id?: Id<"teams">;
  source?: string;
  workspace?: string;
  call_id?: Id<"transcripts">;
  channel_id?: Id<"chat_channels">;
  origin_conversation_id?: string;
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
 * only for an event that carries a ref, matching what the firing reads. A
 * chat line asks by its channel, so a busy team whose one channel has a source
 * schedules nothing for lines in its other channels.
 */
export async function scheduleTriggerMatch(
  ctx: { db: any; scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  args: TriggerMatchArgs,
): Promise<void> {
  const range = (status: "scheduled" | "running") =>
    args.channel_id ? channelTriggers(ctx, status, String(args.channel_id)) : armedTriggers(ctx, status, args.event_type);
  const armed =
    (await range("scheduled").first()) ??
    (args.event_ref ? await range("running").first() : null);
  if (!armed) return;
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, args);
}
