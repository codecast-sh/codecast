// The server-side view of "which of this user's sessions is the home of an
// armed inject trigger" — the structural dormancy source that classifyWorkState
// cannot see from the conversation row alone. One indexed read per armed
// status per user, cached by the caller for the life of a query, so a 200-row
// inbox pays three small reads rather than one per row.
//
// The rule mirrors the web's partitionTriggerInbox absorption (triggerTasks.ts):
// a recurring or event trigger that injects into a session (has an
// originating_conversation_id), armed (scheduled / running / paused), whose last
// run neither failed nor flagged attention. A `once` follow-up never counts —
// its single fire is a nudge, not a standing wake. Failed / flagged runs are
// exactly the "parked but something warrants input" case, so they surface the
// home instead of parking it.
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const ARMED_TRIGGER_STATUSES = ["scheduled", "running", "paused"] as const;

export function isStandingInjectTrigger(task: {
  originating_conversation_id?: Id<"conversations"> | null;
  schedule_type: string;
  status: string;
  last_run_failed?: boolean | null;
  last_run_needs_attention?: boolean | null;
}): boolean {
  if (!task.originating_conversation_id) return false;
  if (task.schedule_type !== "recurring" && task.schedule_type !== "event") return false;
  if (!(ARMED_TRIGGER_STATUSES as readonly string[]).includes(task.status)) return false;
  if (task.last_run_failed || task.last_run_needs_attention) return false;
  return true;
}

export async function loadArmedTriggerHomes(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<Set<string>> {
  const homes = new Set<string>();
  for (const status of ARMED_TRIGGER_STATUSES) {
    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", status))
      .collect();
    for (const task of tasks) {
      if (isStandingInjectTrigger(task)) homes.add(task.originating_conversation_id!.toString());
    }
  }
  return homes;
}

// Per-query memo over loadArmedTriggerHomes for callers that classify rows
// belonging to several users (the team feed).
export function armedTriggerHomeLoader(ctx: Pick<QueryCtx, "db">) {
  const cache = new Map<string, Promise<Set<string>>>();
  return (userId: Id<"users">): Promise<Set<string>> => {
    const key = userId.toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = loadArmedTriggerHomes(ctx, userId);
      cache.set(key, hit);
    }
    return hit;
  };
}
