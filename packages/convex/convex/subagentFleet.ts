// The subagent fleet (shared/contracts/subagentFleet.ts): how many workers a
// session and a machine run at once, the queue a spawn joins when either is
// full, and the merge of an isolated worker's changes into its parent's
// checkout when it finishes done.
//
// A worker's slot lives on its own row (`subagent_slot`). Three things move it:
//   spawn    spawn.createSessionFromCli files the row queued, then drains the
//            queue, which starts it at once when its limits have room
//   end      a done or blocked declaration (cast state, cast task done,
//            cast task handoff) or a kill frees the slot and drains again
//   drain    starts every queued row the limits now admit, first in first out
// The merge rides the same end: a done worker with merge_back_on_done and a
// worktree gets a merge_back command on the machine that holds the worktree,
// which reports back here; blocked and killed workers keep their worktree, and
// the parent is told either way.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage, formatSessionMessage } from "./pendingMessages";
import {
  drainQueue,
  mergeBackNote,
  normalizeSubagentCaps,
  type AgentClientId,
  type AgentDefinitionSpec,
  type MergeBackStatus,
  type SlotRow,
  type SubagentCaps,
  type SubagentOutcome,
} from "@codecast/shared/contracts";

/** Everything a queued row needs to start later exactly as it would have now. */
export interface QueuedStart {
  agentType: AgentClientId;
  projectPath?: string;
  sessionId: string;
  isolated?: boolean;
  worktreeName?: string;
  model?: string;
  effort?: string;
  ccAccount?: string;
  targetDeviceId?: string | null;
  definition?: AgentDefinitionSpec;
  callerUserId?: string;
  prompt?: string;
  createdAt: number;
}

/** Start a spawned row: the start_session command and its seeded first turn. */
export async function startSpawnedSession(ctx: any, runnerUserId: Id<"users">, conversationId: Id<"conversations">, start: QueuedStart): Promise<void> {
  await enqueueStartSession(ctx, runnerUserId, {
    conversationId,
    agentType: start.agentType,
    projectPath: start.projectPath,
    sessionId: start.sessionId,
    isolated: start.isolated,
    worktreeName: start.worktreeName,
    model: start.model,
    effort: start.effort,
    ccAccount: start.ccAccount,
    createdAt: start.createdAt,
    targetDeviceId: start.targetDeviceId ?? null,
    definition: start.definition,
    callerUserId: (start.callerUserId as Id<"users"> | undefined) ?? null,
  });
  // Seed the first turn as a plain user message (raw, not wrapped as a
  // session-message) over the pending-message rail the UI uses for a new
  // session's first message: delivered once the daemon spawns and the agent
  // is ready. Never before the start: a pending message on a row nobody runs
  // yet would bring the session up and walk past the queue.
  const prompt = (start.prompt ?? "").trim();
  if (prompt) {
    const conversation = await ctx.db.get(conversationId);
    const author = start.callerUserId ? (start.callerUserId as Id<"users">) : runnerUserId;
    await enqueuePendingMessage(ctx, conversation, author, { content: prompt });
  }
}

const SLOT_SCAN = 500;

function slotRowOf(doc: any): SlotRow {
  return {
    id: String(doc._id),
    parent: doc.parent_conversation_id ? String(doc.parent_conversation_id) : null,
    device: doc.subagent_slot_device ?? null,
    slot: doc.subagent_slot,
    at: doc.subagent_slot_at ?? doc._creationTime ?? 0,
    caps: normalizeSubagentCaps(doc.subagent_caps),
  };
}

/** One user's running and queued workers. */
export async function fleetRowsOf(ctx: { db: any }, userId: Id<"users">): Promise<any[]> {
  const read = (slot: "running" | "queued") =>
    ctx.db.query("conversations")
      .withIndex("by_user_subagent_slot", (q: any) => q.eq("user_id", userId).eq("subagent_slot", slot))
      .take(SLOT_SCAN);
  return [...(await read("running")), ...(await read("queued"))];
}

/**
 * The caller's running and queued workers, for `cast queue`: queued ones in
 * the order the drain will start them, each with the caps it was queued under.
 */
export const queueStatus = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Authentication required");
    const docs = await fleetRowsOf(ctx, auth.userId);
    return docs
      .map((doc) => ({ ...slotRowOf(doc), title: typeof doc.title === "string" ? doc.title : null }))
      .sort((a, b) => (a.slot === b.slot ? a.at - b.at : a.slot === "running" ? -1 : 1));
  },
});

/** Start every queued worker the limits now admit. Returns the started ids. */
export async function drainFleet(ctx: any, userId: Id<"users">): Promise<string[]> {
  const docs = await fleetRowsOf(ctx, userId);
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const started = drainQueue(docs.map(slotRowOf));
  for (const id of started) {
    const doc = byId.get(id)!;
    const start = doc.subagent_queued_start as QueuedStart | undefined;
    await ctx.db.patch(doc._id, { subagent_slot: "running", subagent_slot_at: Date.now(), subagent_queued_start: undefined });
    // A row queued before this code knew how to start it has nothing to run;
    // it still takes the slot it was given, and its owner sees it idle.
    if (start) await startSpawnedSession(ctx, doc.user_id, doc._id, start);
  }
  return started;
}

/**
 * File a new worker in the fleet and start it if its limits allow, else leave
 * it queued. The start runs here or later from drainFleet, never both.
 */
export async function admitSubagent(
  ctx: any,
  conversationId: Id<"conversations">,
  runnerUserId: Id<"users">,
  opts: { device: string | null; caps: SubagentCaps; start: QueuedStart },
): Promise<{ queued: boolean }> {
  await ctx.db.patch(conversationId, {
    subagent_slot: "queued",
    subagent_slot_at: Date.now(),
    subagent_caps: opts.caps,
    ...(opts.device ? { subagent_slot_device: opts.device } : {}),
    subagent_queued_start: opts.start,
  });
  const started = await drainFleet(ctx, runnerUserId);
  return { queued: !started.includes(String(conversationId)) };
}

/**
 * A worker ended: free its slot, start what the queue now admits, and settle
 * its worktree. Idempotent: a second declaration of the same end finds no
 * slot and no pending merge, and does nothing.
 */
export async function subagentEnded(ctx: any, conv: any, outcome: SubagentOutcome): Promise<void> {
  if (!conv?.parent_conversation_id) return;
  const fresh = await ctx.db.get(conv._id);
  if (!fresh) return;
  if (fresh.subagent_slot) {
    await ctx.db.patch(fresh._id, { subagent_slot: undefined, subagent_queued_start: undefined });
    await drainFleet(ctx, fresh.user_id);
  }
  await settleWorktree(ctx, fresh, outcome);
}

/** A row's fleet facts as the inbox carries them: its slot, what it counts
 *  against (the web derives its place in the queue from these), and what
 *  became of its worktree's changes. */
export function fleetRowFields(conv: any) {
  return {
    subagent_slot: conv.subagent_slot ?? null,
    subagent_slot_at: conv.subagent_slot_at ?? null,
    subagent_slot_device: conv.subagent_slot_device ?? null,
    subagent_caps: conv.subagent_caps ?? null,
    merge_back: conv.merge_back ?? null,
  };
}

/** The thread-state and task statuses that end a worker's turn at its slot. */
export function outcomeOfDeclaration(status: string | null | undefined): SubagentOutcome | null {
  if (status === "done") return "done";
  if (status === "blocked" || status === "needs_context") return "blocked";
  return null;
}

async function settleWorktree(ctx: any, worker: any, outcome: SubagentOutcome): Promise<void> {
  if (!worker.merge_back_on_done || !worker.worktree_path) return;
  // A merge already running or finished for this worktree stays as it is.
  if (worker.merge_back?.state === "pending" || worker.merge_back?.state === "merged") return;
  const parent = await ctx.db.get(worker.parent_conversation_id);
  if (outcome !== "done") {
    await recordMergeBack(ctx, worker, parent, { state: "kept", at: Date.now() }, outcome);
    return;
  }
  const target = parent?.git_root || parent?.project_path;
  const sameMachine = !!parent && !!worker.owner_device_id && parent.owner_device_id === worker.owner_device_id;
  if (!target || !sameMachine) {
    const reason = !target ? "the parent session has no checkout" : "the worktree is on another machine than the parent";
    await recordMergeBack(ctx, worker, parent, { state: "failed", at: Date.now(), reason }, outcome);
    return;
  }
  await ctx.db.patch(worker._id, { merge_back: { state: "pending", at: Date.now() } });
  await ctx.db.insert("daemon_commands", {
    user_id: worker.user_id,
    command: "merge_back",
    args: JSON.stringify({ conversation_id: worker._id, worktree_path: worker.worktree_path, target_path: target }),
    created_at: Date.now(),
    target_device_id: worker.owner_device_id,
  });
}

async function recordMergeBack(ctx: any, worker: any, parent: any, status: MergeBackStatus, outcome: SubagentOutcome): Promise<void> {
  await ctx.db.patch(worker._id, { merge_back: status });
  const note = mergeBackNote({ short_id: worker.short_id ?? String(worker._id).slice(0, 7), worktree_path: worker.worktree_path }, status, outcome);
  // A parent that is gone or killed is not woken to read about its workers:
  // the message would bring back a session someone retired.
  if (!note || !parent || parent.inbox_killed_at || parent.status === "completed") return;
  await enqueuePendingMessage(ctx, parent, parent.user_id, {
    content: formatSessionMessage(worker.short_id ?? String(worker._id).slice(0, 7), note),
    from_conversation_id: worker._id,
  });
}

// The machine that ran a merge_back command reports what it did.
export async function applyMergeBackReport(
  ctx: any,
  userId: Id<"users">,
  args: { conversation_id: Id<"conversations">; state: "merged" | "empty" | "conflict" | "failed"; files?: string[]; reason?: string },
): Promise<void> {
  const worker = await ctx.db.get(args.conversation_id);
  if (!worker || String(worker.user_id) !== String(userId)) throw new Error("Conversation not found");
  const parent = worker.parent_conversation_id ? await ctx.db.get(worker.parent_conversation_id) : null;
  const status: MergeBackStatus = {
    state: args.state,
    at: Date.now(),
    ...(args.files?.length ? { files: args.files.slice(0, 200) } : {}),
    ...(args.reason ? { reason: args.reason.slice(0, 500) } : {}),
  };
  await recordMergeBack(ctx, worker, parent, status, "done");
}

export const reportMergeBack = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.id("conversations"),
    state: v.union(v.literal("merged"), v.literal("empty"), v.literal("conflict"), v.literal("failed")),
    files: v.optional(v.array(v.string())),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => {
    const auth = await verifyApiToken(ctx, api_token);
    if (!auth) throw new Error("Unauthorized");
    await applyMergeBackReport(ctx, auth.userId, args);
    return { ok: true };
  },
});
