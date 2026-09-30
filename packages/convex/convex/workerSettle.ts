import { internalMutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { ACTIVE_AGENT_STATUSES, WORKER_SETTLE_WORDS, formatScheduledTask, threadStateFreshness, threadStateHeadline } from "@codecast/shared/contracts";
import { enqueuePendingMessage } from "./pendingMessages";
import { NEEDS_INPUT_IDLE_CHECK_DELAY_MS } from "./inboxFilters";
import { internal } from "./_generated/api";

// A worker started with `cast spawn --subagent` reports to the session it
// nests under. Its settle wakes that parent with what it settled on, so a
// parent that parks on "waiting for my worker" is parked on a wake the system
// delivers (and the inbox can trust: a producing child keeps a dormant claim
// alive in placeProjectableRow). Trigger runs report through wakeRunOwner, and
// sessions under a role through the role's route up, so both stay out.
//
// The check runs one idle grace after the settle, so a worker's closing
// `cast state` has landed. Every sibling worker that settled and has not yet
// told the parent rides the same message: a fan-out that finishes together
// reads as one turn, not five.

const SIBLING_SCAN_LIMIT = 100;

type WorkerRow = {
  _id: Id<"conversations">;
  user_id: Id<"users">;
  parent_conversation_id?: Id<"conversations">;
  is_subagent?: boolean;
  is_workflow_sub?: boolean;
  agent_task_id?: unknown;
  org_role_id?: unknown;
  standing_role_id?: unknown;
  agent_team_name?: string;
  message_count?: number;
  short_id?: string;
  title?: string;
  thread_state?: string;
  thread_state_status?: string;
  thread_state_at?: number;
  thread_state_msg_count?: number;
  last_message_preview?: string;
  hand_wake_notified_key?: string;
};

export function isSpawnedWorker(c: WorkerRow): boolean {
  return c.is_subagent === true && !!c.parent_conversation_id && !c.agent_task_id && !c.is_workflow_sub &&
    !c.org_role_id && !c.standing_role_id && !c.agent_team_name;
}

/** What the worker settled on (a WORKER_SETTLE_WORDS key); null while it is
 *  still its own business (producing, or parked on a wake of its own). The
 *  daemon re-derives dormant, done and waiting from the declaration at every
 *  turn end, so the status alone decides; the pinned line only words a plain
 *  settle. */
export function workerSettleWhy(w: WorkerRow, agentStatus: string | undefined, now: number): string | null {
  if (!agentStatus || ACTIVE_AGENT_STATUSES.has(agentStatus)) return null;
  if (agentStatus === "dormant" || agentStatus === "waiting") return null;
  if (agentStatus === "stopped" || agentStatus === "permission_blocked" || agentStatus === "done") return agentStatus;
  const blocked = w.thread_state_status === "blocked" && !!w.thread_state &&
    threadStateFreshness(w, w.message_count ?? 0, now).freshness !== "stale";
  return blocked ? "blocked" : "ended";
}

function episodeOf(w: WorkerRow): string {
  return `${w.message_count ?? 0}:${threadStateHeadline(w.thread_state ?? "").slice(0, 200)}`;
}

function refOf(w: WorkerRow): string {
  return w.short_id ?? String(w._id).slice(0, 7);
}

/** The frame the parent reads: one `<worker-report>` per worker (the web draws
 *  each as a live session row), a title for previews, and the ask. */
export function workerSettleFrame(told: Array<{ worker: WorkerRow; why: string }>, now: number) {
  const workers = told.map(({ worker, why }) => ({
    short_id: refOf(worker),
    title: (worker.title ?? "").slice(0, 80),
    why,
    since: now,
    state: threadStateHeadline(worker.thread_state ?? "") || (worker.last_message_preview ?? "").replace(/\s+/g, " ").slice(0, 200),
  }));
  const title = told.length === 1
    ? `Worker ${workers[0].short_id} ${WORKER_SETTLE_WORDS[told[0].why]}`
    : `${told.length} workers settled`;
  const read = told.length === 1 ? `cast read ${workers[0].short_id}` : "cast read <id>";
  return { title, workers, body: `Read the result with ${read} and act on it.` };
}

async function statusOf(ctx: any, conversationId: Id<"conversations">) {
  return await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .first();
}

export async function performTellParent(
  ctx: any,
  args: { conversation_id: Id<"conversations">; status_ts?: number },
): Promise<{ told: number; reason?: string }> {
  const worker: WorkerRow | null = await ctx.db.get(args.conversation_id);
  if (!worker || !worker.message_count || !isSpawnedWorker(worker)) return { told: 0, reason: "not_worker" };
  const session = await statusOf(ctx, worker._id);
  // A newer status change owns its own check.
  if (args.status_ts !== undefined && session?.agent_status_updated_at !== args.status_ts) return { told: 0, reason: "superseded" };
  const parent = await ctx.db.get(worker.parent_conversation_id!);
  if (!parent || String(parent.user_id) !== String(worker.user_id) || parent.inbox_killed_at) return { told: 0, reason: "no_parent" };

  const now = Date.now();
  const siblings: WorkerRow[] = await ctx.db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", parent._id))
    .order("desc")
    .take(SIBLING_SCAN_LIMIT);
  const candidates = [worker, ...siblings.filter((s) => String(s._id) !== String(worker._id))];
  const told: Array<{ worker: WorkerRow; why: string }> = [];
  for (const c of candidates) {
    if (!c.message_count || !isSpawnedWorker(c) || c.hand_wake_notified_key === episodeOf(c)) continue;
    const status = c === worker ? session : await statusOf(ctx, c._id);
    const why = workerSettleWhy(c, status?.agent_status, now);
    if (why) told.push({ worker: c, why });
  }
  if (told.length === 0) return { told: 0, reason: "already" };

  await enqueuePendingMessage(ctx, parent, worker.user_id, {
    content: formatScheduledTask(workerSettleFrame(told, now)),
    origin: "scheduler",
    client_id: `worker-settled:${told.map(({ worker: w }) => `${w._id}@${episodeOf(w)}`).join(",")}`,
  });
  for (const { worker: w } of told) await ctx.db.patch(w._id, { hand_wake_notified_key: episodeOf(w) });
  return { told: told.length };
}

/** Called on every status change into a settled status: schedules the check
 *  for spawned workers only, one idle grace out. */
export async function scheduleWorkerSettle(ctx: any, conversationId: Id<"conversations">, statusTs: number): Promise<void> {
  const conv = await ctx.db.get(conversationId);
  if (!conv || !isSpawnedWorker(conv)) return;
  await ctx.scheduler.runAfter(NEEDS_INPUT_IDLE_CHECK_DELAY_MS, internal.workerSettle.tellParent, {
    conversation_id: conversationId,
    status_ts: statusTs,
  });
}

export const tellParent = internalMutation({
  args: { conversation_id: v.id("conversations"), status_ts: v.optional(v.number()) },
  handler: (ctx, args) => performTellParent(ctx, args),
});
