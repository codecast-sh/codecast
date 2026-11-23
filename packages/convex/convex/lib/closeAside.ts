// Close is dormancy, not retirement: it may stop an agent only when nothing is
// in flight. The web decides at the click (lib/sessionClose); this is the
// server's own read of the row, so a close the client guessed wrong never cuts
// a turn off or drops a wake. Pure reads, no writes.
import { deriveLiveAt, HEARTBEAT_ALIVE_MS, isLoopFresh } from "@codecast/shared/contracts";
import { nestParentIdOf } from "../ccAccountsShared";

const NESTED_SCAN = 50;

/** Why a close must set this conversation aside (stash) instead of stopping
 *  it, or null when stopping loses nothing. */
export async function closeSetsAsideOnServer(ctx: { db: any }, conv: any, now: number): Promise<string | null> {
  // A queued message is about to run.
  if (conv.has_pending_messages) return "queued";
  // An armed /loop is a ScheduleWakeup inside the agent process.
  if (conv.loop_state && isLoopFresh(conv.loop_state, now)) return "loop";
  // A Workflow-tool run (run_kind "workflow") runs inside the host agent
  // process; a codecast flow run has station sessions of its own and reports back.
  if (conv.workflow_run_id) {
    const run = await ctx.db.get(conv.workflow_run_id);
    if (run?.run_kind === "workflow" && (run.status === "running" || run.status === "pending")) return "workflow";
  }
  if (await turnInFlight(ctx, conv, now)) return "live";
  // The nested group comes down with the card (cascadeHideToNestedChildren).
  const id = String(conv._id);
  const [subs, spawned] = await Promise.all([
    ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conv._id)).take(NESTED_SCAN),
    ctx.db.query("conversations").withIndex("by_spawned_by", (q: any) => q.eq("spawned_by_conversation_id", conv._id)).take(NESTED_SCAN),
  ]);
  for (const child of [...subs, ...spawned]) {
    if (nestParentIdOf(child) === id && await turnInFlight(ctx, child, now)) return "nested";
  }
  return null;
}

// Mid-turn by the server's own facts: the shared live rule over the managed
// session, or a turn blocked on a question (an open AskUserQuestion poll or a
// permission prompt), which stopping would lose just the same.
async function turnInFlight(ctx: { db: any }, conv: any, now: number): Promise<boolean> {
  if (!conv.message_count) return false;
  const managed = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first();
  // No process behind it: stopping it stops nothing.
  if (!managed) return false;
  {
    const live = deriveLiveAt({
      status: conv.status,
      agent_type: conv.agent_type,
      updated_at: conv.updated_at ?? 0,
      message_count: conv.message_count,
      has_pending_messages: !!conv.has_pending_messages,
      agent_status: managed.agent_status ?? null,
      agent_status_updated_at: managed.agent_status_updated_at ?? null,
      last_heartbeat: managed.last_heartbeat ?? null,
      daemon_alive_until: managed.last_heartbeat != null ? managed.last_heartbeat + HEARTBEAT_ALIVE_MS : null,
      last_role_is_user: conv.last_message_role === "user",
      open_tasks: managed.open_tasks ?? null,
      open_tasks_at: managed.open_tasks_at ?? null,
    }, now);
    if (!live.is_idle || live.awaiting_input || managed.agent_status === "permission_blocked") return true;
  }
  const newest = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
    .order("desc")
    .first();
  return !!newest && newest.role === "assistant" && !!newest.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion");
}
