// Close is dormancy, not retirement: it may stop an agent only when nothing is
// in flight. The web decides at the click (lib/sessionClose); this is the
// server's own read of the row, so a close the client guessed wrong never cuts
// a turn off or drops a wake. Both sides only gather facts and ask the shared
// closeInFlightReason. Pure reads, no writes.
import { closeInFlightReason, deriveLiveAt, HEARTBEAT_ALIVE_MS, isLoopFresh, type InFlightFacts } from "@codecast/shared/contracts";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "../ccAccountsShared";

// The nested group a hide of `lead` takes down with it (cleanup.ts
// cascadeHideToNestedChildren reads exactly this): Task subagents and
// agent-team teammates, newest first, the same bound on each index. The aside
// check reads the same list, so the two can never see different children.
export const NESTED_GROUP_SCAN = 200;
export async function nestedGroupOf(ctx: { db: any }, lead: any): Promise<any[]> {
  const leadId = String(lead._id);
  const [taskSubs, spawned] = await Promise.all([
    ctx.db.query("conversations").withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", lead._id)).order("desc").take(NESTED_GROUP_SCAN),
    ctx.db.query("conversations").withIndex("by_spawned_by", (q: any) => q.eq("spawned_by_conversation_id", lead._id)).order("desc").take(NESTED_GROUP_SCAN),
  ]);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const child of [...taskSubs, ...spawned]) {
    const id = String(child._id);
    if (id === leadId || seen.has(id)) continue;
    seen.add(id);
    if (nestParentIdOf(child) === leadId) out.push(child);
  }
  return out;
}

/** Why a close must set this conversation aside (stash) instead of stopping
 *  it: itself in flight, or "nested" when a member of its nested group is.
 *  Null when stopping it and its group loses nothing. */
export async function closeSetsAsideOnServer(ctx: { db: any }, conv: any, now: number): Promise<string | null> {
  const own = closeInFlightReason(await inFlightFactsOnServer(ctx, conv, now));
  if (own) return own;
  for (const child of await nestedGroupOf(ctx, conv)) {
    if (closeInFlightReason(await inFlightFactsOnServer(ctx, child, now))) return "nested";
  }
  return null;
}

/** A message still waiting to reach this session: a wake a close never holds
 *  back (getConversationLifecycle's `closed` reads it too). */
export async function hasDeliverableMessage(ctx: { db: any }, convId: any): Promise<boolean> {
  for (const status of ["pending", "injected", "failed"] as const) {
    const row = await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", convId).eq("status", status)).first();
    if (row) return true;
  }
  return false;
}

/** The shared in-flight facts of one conversation, from the database. */
export async function inFlightFactsOnServer(ctx: { db: any }, conv: any, now: number): Promise<InFlightFacts> {
  const queued = !!conv.has_pending_messages || await hasDeliverableMessage(ctx, conv._id);
  const loopFresh = !!conv.loop_state && isLoopFresh(conv.loop_state, now);
  let inProcessRun = false;
  if (conv.workflow_run_id) {
    const run = await ctx.db.get(conv.workflow_run_id);
    inProcessRun = run?.run_kind === "workflow" && (run.status === "running" || run.status === "pending");
  }
  // The pre-close row: a close is the dismissal isBlockedConversation would exclude.
  const limitParked = isBlockedConversation({ ...conv, inbox_dismissed_at: undefined }) && isCurrentBlock(conv, now);
  let turnLive = false;
  let awaitingInput = false;
  const managed = conv.message_count
    ? await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first()
    : null;
  // No process behind it: nothing to cut off mid-turn.
  if (managed) {
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
    turnLive = !live.is_idle;
    awaitingInput = live.awaiting_input || managed.agent_status === "permission_blocked";
    if (!turnLive && !awaitingInput) {
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
        .order("desc")
        .first();
      awaitingInput = !!newest && newest.role === "assistant" && !!newest.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion");
    }
  }
  return { queued, loopFresh, inProcessRun, turnLive, awaitingInput, limitParked };
}
