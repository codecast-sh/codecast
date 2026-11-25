// Close is dormancy, not retirement: it may stop an agent only when nothing is
// in flight. The web decides at the click (lib/sessionClose); this is the
// server's own read of the row, so a close the client guessed wrong never cuts
// a turn off or drops a wake. Both sides only gather facts and ask the shared
// closeInFlightReason. Pure reads, no writes.
import { closeInFlightReason, deriveLiveAt, HEARTBEAT_ALIVE_MS, isLoopFresh, openTasksVouchForWaiting, rowHeartbeatAliveAt, type InFlightFacts } from "@codecast/shared/contracts";
import { cascadeTakesDownRow, NESTED_GROUP_SCAN, type HoldFacts } from "@codecast/shared/contracts/closeCascade";
import { isBlockedConversation, isCurrentBlock, nestParentIdOf } from "../ccAccountsShared";

// The nested group a hide of `lead` takes down with it (cleanup.ts
// cascadeHideToNestedChildren reads exactly this): Task subagents and
// agent-team teammates, newest first, the same bound on each index. The aside
// check reads the same list, so the two can never see different children.
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

/** Whether a hide of a lead takes this member of its nested group down (the
 *  cascade's own per-child rule, cleanup.ts cascadeHideToNestedChildren). The
 *  aside check scans exactly the members this admits, so a close is set aside
 *  for precisely the children it would otherwise stop. */
export function cascadeTakesDown(
  child: any,
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  opts?: { forceKill?: boolean; close?: boolean },
): boolean {
  return cascadeTakesDownRow(child, field, { ...opts, queued: !!child.has_pending_messages });
}

/** Why a close must set this conversation aside (stash) instead of stopping
 *  it: itself in flight, or "nested" when a member of its nested group the
 *  close would take down is. Null when stopping it and its group loses nothing.
 *  It runs inside the gesture's mutation, so a member is judged by what its
 *  row says before anything is read for it, and one that has finished costs no
 *  reads (a lead with hundreds of finished subagents once timed this out). */
export async function closeSetsAsideOnServer(ctx: { db: any }, conv: any, now: number, opts?: { forceKill?: boolean }): Promise<string | null> {
  const own = closeInFlightReason(await inFlightFactsOnServer(ctx, conv, now));
  if (own) return own;
  for (const child of await nestedGroupOf(ctx, conv)) {
    if (!cascadeTakesDown(child, "inbox_dismissed_at", { forceKill: opts?.forceKill, close: true })) continue;
    const row = rowInFlightFacts(child, now);
    if (row.queued || row.loopFresh || row.limitParked || row.fleetQueued) return "nested";
    // Finished, nothing queued, no loop: no process, no wake, nothing to read.
    if (child.status === "completed") continue;
    if (closeInFlightReason(await inFlightFactsOnServer(ctx, child, now))) return "nested";
  }
  return null;
}

// The facts a row carries itself: no reads.
function rowInFlightFacts(conv: any, now: number): Pick<InFlightFacts, "queued" | "loopFresh" | "limitParked" | "fleetQueued"> {
  return {
    queued: !!conv.has_pending_messages,
    loopFresh: !!conv.loop_state && isLoopFresh(conv.loop_state, now),
    // The pre-close row: a close is the dismissal isBlockedConversation would exclude.
    limitParked: isBlockedConversation({ ...conv, inbox_dismissed_at: undefined }) && isCurrentBlock(conv, now),
    fleetQueued: conv.subagent_slot === "queued",
  };
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

/** What a child its lead's close leaves up still holds (shared HoldFacts),
 *  from the database: its in-flight facts, its managed session's heartbeat,
 *  and its armed trigger. The web reads the same off the row (holdFactsOfRow).
 *  A finished child (completed) whose row says nothing waits for it costs no
 *  reads: the daemon marked its process gone, as closeSetsAsideOnServer assumes. */
export async function holdFactsOnServer(ctx: { db: any }, conv: any, now: number): Promise<HoldFacts> {
  const row = rowInFlightFacts(conv, now);
  const triggerArmed = (conv.armed_trigger_kind ?? "none") !== "none";
  if (finishedByRow(conv, now)) {
    return { ...row, inProcessRun: false, turnLive: false, awaitingInput: false, openBackgroundWork: false, processAlive: false, triggerArmed };
  }
  const managed = await managedOf(ctx, conv);
  return {
    ...(await inFlightFactsOnServer(ctx, conv, now, conv.message_count ? managed : null)),
    processAlive: !!managed && rowHeartbeatAliveAt(managed, now),
    triggerArmed,
  };
}

/** A finished child whose row says nothing waits for it: it holds nothing,
 *  and telling so costs no reads (holdFactsOnServer). */
export function finishedByRow(conv: any, now: number): boolean {
  const row = rowInFlightFacts(conv, now);
  return conv.status === "completed" && (conv.armed_trigger_kind ?? "none") === "none" && !row.queued && !row.loopFresh && !row.limitParked && !row.fleetQueued;
}

const managedOf = (ctx: { db: any }, conv: any) =>
  ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first();

/** The shared in-flight facts of one conversation, from the database.
 *  `preloaded`: its managed session, when the caller has read it already. */
export async function inFlightFactsOnServer(ctx: { db: any }, conv: any, now: number, preloaded?: any): Promise<InFlightFacts> {
  const { queued: flagged, loopFresh, limitParked, fleetQueued } = rowInFlightFacts(conv, now);
  const queued = flagged || await hasDeliverableMessage(ctx, conv._id);
  let inProcessRun = false;
  if (conv.workflow_run_id) {
    const run = await ctx.db.get(conv.workflow_run_id);
    inProcessRun = run?.run_kind === "workflow" && (run.status === "running" || run.status === "pending");
  }
  let turnLive = false;
  let awaitingInput = false;
  let openBackgroundWork = false;
  const managed = preloaded !== undefined ? preloaded : conv.message_count ? await managedOf(ctx, conv) : null;
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
    openBackgroundWork = openTasksVouchForWaiting(managed.open_tasks_at, managed.open_tasks?.length ?? 0, rowHeartbeatAliveAt(managed, now));
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
  return { queued, loopFresh, inProcessRun, turnLive, awaitingInput, limitParked, openBackgroundWork, fleetQueued };
}
