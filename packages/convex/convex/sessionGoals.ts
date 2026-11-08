// A session's goal loop (shared/contracts/sessionGoal.ts, task ct-87437).
//
// A person sets an objective on a session (/goal in the composer, `cast loop
// set`). Every backend already reports a turn end through
// managedSessions.applyAgentStatus (the Claude Stop hook, Codex's
// turn/completed, the hosted turn engine), and that is the loop's only
// trigger: scheduleGoalJudge there schedules judgeTurn, which reads the
// objective and what the session's tools showed since the goal was set, asks
// the judge, and applies the verdict. Continue delivers the next round
// through the ordinary pending-message rail; done and blocked stop the loop
// and pin the outcome on the session (blocked lands in needs input with what
// is needed); a cap or the person pauses it. An idle check pauses a goal no
// turn end has touched for its idle limit.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getAuthenticatedUserId, canSendProductMessage, cancelPendingMessageForUser, enqueuePendingMessage } from "./pendingMessages";
import { checkConversationAccess } from "./privacy";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { performSetThreadState } from "./conversations";
import { runModelCall, type CallScope } from "./modelCalls";
import { callModelMetered, parseJsonBlock } from "./lib/anthropic";
import { ACTIVE_AGENT_STATUSES, clearedThreadStateFields } from "@codecast/shared/contracts";
import {
  GOAL_IDLE_LIMIT_MS,
  GOAL_MAX_ROUNDS,
  GOAL_MAX_STALLS,
  buildGoalJudgePrompt,
  formatGoalMessage,
  goalObjectiveProblem,
  goalOutcomeState,
  goalPausedState,
  goalCanPause,
  goalCanResume,
  isGoalOutcomeState,
  GOAL_RESUME_RESET,
  isGoalMessage,
  parseGoalVerdict,
  renderGoalEvidence,
  stepGoal,
  usedToolsSinceLastGoalMessage,
  type GoalVerdict,
} from "@codecast/shared/contracts/sessionGoal";

/** The judge's model. Graded by packages/cli/scripts/goal-judge-eval.ts. */
export const GOAL_JUDGE_MODEL = "claude-haiku-5-5";
/** How long after a turn end the judge reads: the turn's last messages sync a moment after its status. */
export const GOAL_JUDGE_DELAY_MS = 8_000;
/** How many times a judge waits again for the turn's messages before judging what it has. */
const SYNC_RETRIES = 3;

type Goal = Doc<"session_goals">;

/** The session's goal: its newest row, whatever its status. */
export async function readSessionGoal(ctx: { db: any }, conversationId: Id<"conversations">): Promise<Goal | null> {
  return await ctx.db.query("session_goals").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId)).order("desc").first();
}

// ── Who may steer a goal ─────────────────────────────────────────────────────
// Whoever may send the session a message may set, pause, resume or clear its
// goal: a goal is a standing message to the session.

async function steerableConversation(ctx: { db: any }, userId: Id<"users">, conversationId: string): Promise<Doc<"conversations">> {
  const id = ctx.db.normalizeId("conversations", conversationId);
  const conv = id ? await ctx.db.get(id) : null;
  if (!conv || !(await canSendProductMessage(ctx, userId, conv))) throw new Error("Session not found, or you cannot send to it");
  return conv;
}

/** Arms the idle check, one chain per goal: a set or resume stamps a new chain and the older one stops at its next fire. */
async function startIdleWatch(ctx: MutationCtx, goal: Pick<Goal, "_id" | "idle_limit_ms">, armedAt: number) {
  await ctx.db.patch(goal._id, { idle_armed_at: armedAt });
  await ctx.scheduler.runAfter(goal.idle_limit_ms, internal.sessionGoals.idleCheck, { goal_id: goal._id, armed_at: armedAt });
}

// Every message the loop sends is named goal:<client_key>:<what>, so its
// queued ones can be found: a judge waits while one is still on its way, and
// pause, clear or a new goal takes them back.
const loopClientId = (clientKey: string, what: string) => `goal:${clientKey}:${what}`;

async function queuedLoopRows(ctx: { db: any }, conversationId: Id<"conversations">, clientKey: string): Promise<any[]> {
  const prefix = loopClientId(clientKey, "");
  const rows: any[] = [];
  for (const status of ["pending", "held"]) {
    const found = await ctx.db.query("pending_messages").withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", status)).collect();
    rows.push(...found.filter((m: any) => typeof m.client_id === "string" && m.client_id.startsWith(prefix)));
  }
  return rows;
}

/** Takes back the loop's messages that have not reached the agent; one already being delivered is left to land. */
async function cancelQueuedLoop(ctx: MutationCtx, goal: Goal) {
  for (const row of await queuedLoopRows(ctx, goal.conversation_id, goal.client_key)) {
    try {
      await cancelPendingMessageForUser(ctx, goal.set_by, goal.conversation_id, { clientId: row.client_id });
    } catch {}
  }
}

/** The pin the loop left (met, blocked, paused) comes down when the person resumes or clears the goal. */
async function takeDownGoalPin(ctx: MutationCtx, conv: Doc<"conversations">) {
  if (isGoalOutcomeState(conv.thread_state)) await ctx.db.patch(conv._id, clearedThreadStateFields());
}

/** Sets a goal on a session, replacing any it had, and sends the agent the start. */
export async function performSetGoal(ctx: MutationCtx, userId: Id<"users">, conversationId: string, objective: string, clientKey?: string) {
  const conv = await steerableConversation(ctx, userId, conversationId);
  const problem = goalObjectiveProblem(objective);
  if (problem) throw new Error(problem);
  const key = clientKey?.trim() || `goal-${conv._id}-${Date.now()}`;
  const already = await ctx.db.query("session_goals").withIndex("by_client_key", (q: any) => q.eq("client_key", key)).first();
  if (already) return already;
  const owner = await ctx.db.get(conv.user_id);
  if (owner?.encryption_enabled) throw new Error("A goal needs to read the session's transcript, and this session is end-to-end encrypted");
  const text = objective.trim();
  // The start is queued before any goal row is written, so a refused send leaves nothing behind.
  await enqueuePendingMessage(ctx, conv, userId, {
    content: formatGoalMessage({ kind: "start", round: 0, of: GOAL_MAX_ROUNDS, objective: text }),
    origin: "scheduler",
    client_id: loopClientId(key, "start"),
  });
  const previous = await readSessionGoal(ctx, conv._id);
  const now = Date.now();
  if (previous && previous.status !== "cleared") {
    await ctx.db.patch(previous._id, { status: "cleared", judged_status_ts: undefined, updated_at: now });
    await cancelQueuedLoop(ctx, previous);
  }
  await takeDownGoalPin(ctx, conv);
  const id = await ctx.db.insert("session_goals", {
    conversation_id: conv._id,
    set_by: userId,
    objective: text,
    status: "active",
    rounds: 0,
    max_rounds: GOAL_MAX_ROUNDS,
    stalls: 0,
    max_stalls: GOAL_MAX_STALLS,
    idle_limit_ms: GOAL_IDLE_LIMIT_MS,
    last_activity_at: now,
    client_key: key,
    created_at: now,
    updated_at: now,
  });
  await startIdleWatch(ctx, { _id: id, idle_limit_ms: GOAL_IDLE_LIMIT_MS }, now);
  return (await ctx.db.get(id))!;
}

export type GoalControl = "pause" | "resume" | "clear";

/**
 * A person pauses, resumes or clears a session's goal. Resume restarts a
 * paused or blocked goal with a fresh round budget. Every control forgets the
 * turn a judge may still be reading, so a verdict that lands after it changes
 * nothing.
 */
export async function performGoalControl(ctx: MutationCtx, userId: Id<"users">, conversationId: string, op: GoalControl) {
  const conv = await steerableConversation(ctx, userId, conversationId);
  const goal = await readSessionGoal(ctx, conv._id);
  if (!goal || goal.status === "cleared") throw new Error("This session has no goal");
  const now = Date.now();
  if (op === "clear") {
    await ctx.db.patch(goal._id, { status: "cleared", judged_status_ts: undefined, updated_at: now });
    await cancelQueuedLoop(ctx, goal);
    await takeDownGoalPin(ctx, conv);
  } else if (op === "pause") {
    if (!goalCanPause(goal)) throw new Error(`The goal is ${goal.status}, not running`);
    await ctx.db.patch(goal._id, { status: "paused", reason: "Paused by the person", judged_status_ts: undefined, updated_at: now });
    await cancelQueuedLoop(ctx, goal);
  } else {
    if (goal.status === "active") throw new Error("The goal is already running");
    if (!goalCanResume(goal)) throw new Error("The goal is met; set a new one instead");
    await enqueuePendingMessage(ctx, conv, userId, {
      content: formatGoalMessage({ kind: "resume", round: 0, of: goal.max_rounds, objective: goal.objective }),
      origin: "scheduler",
      client_id: loopClientId(goal.client_key, `resume:${now}`),
    });
    await ctx.db.patch(goal._id, { ...GOAL_RESUME_RESET, judged_status_ts: undefined, last_activity_at: now, updated_at: now });
    await takeDownGoalPin(ctx, conv);
    await startIdleWatch(ctx, goal, now);
  }
  return (await ctx.db.get(goal._id))!;
}

// ── The trigger: a turn ended ────────────────────────────────────────────────

/**
 * Called from applyAgentStatus whenever a turn ends, for any backend. `turnKey`
 * names the turn end (its stamp, else the status change time), so a turn end
 * reported twice is judged once. A session settling as `waiting` still has
 * background work that will wake it, and one at a permission prompt is mid
 * turn, so their goal waits for the turn to really end.
 */
const SAME_TURN_MS = 5_000;

export async function scheduleGoalJudge(ctx: MutationCtx, conversationId: Id<"conversations">, turnKey: number, agentStatus: string): Promise<void> {
  const goal = await readSessionGoal(ctx, conversationId);
  if (!goal || goal.status !== "active") return;
  const now = Date.now();
  // Two reports of one turn end (a settle, then its stamp) land seconds apart; a real next turn needs a delivery and work in between.
  const sameTurn = goal.judged_status_ts !== undefined && Math.abs(goal.judged_status_ts - turnKey) < SAME_TURN_MS;
  if (agentStatus === "waiting" || agentStatus === "permission_blocked" || sameTurn) {
    await ctx.db.patch(goal._id, { last_activity_at: now });
    return;
  }
  await ctx.db.patch(goal._id, { judged_status_ts: turnKey, last_activity_at: now });
  await ctx.scheduler.runAfter(GOAL_JUDGE_DELAY_MS, internal.sessionGoals.judgeTurn, { goal_id: goal._id, turn_key: turnKey, attempt: 0 });
}

// ── The judge ────────────────────────────────────────────────────────────────

// The newest rows since the goal was set: enough for a long turn, far under the read limit (the transcript clips each row).
const EVIDENCE_ROWS = 200;

export const judgeInputs = internalQuery({
  args: { goal_id: v.id("session_goals"), turn_key: v.number() },
  handler: async (ctx, args): Promise<JudgeInputs> => {
    const goal = await ctx.db.get(args.goal_id);
    if (!goal || goal.status !== "active") return { ok: false as const, why: "not_active" };
    if (goal.judged_status_ts !== args.turn_key) return { ok: false as const, why: "superseded" };
    const conv = await ctx.db.get(goal.conversation_id);
    if (!conv) return { ok: false as const, why: "no_session" };
    const session = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", goal.conversation_id)).first();
    // A new turn is running: its own end is judged.
    if (session?.agent_status && (ACTIVE_AGENT_STATUSES.has(session.agent_status) || session.agent_status === "permission_blocked")) return { ok: false as const, why: "working" };
    // The agent had the goal only once its start reached it: a turn that ended before then was not working toward it.
    // The agent has not yet received the loop's latest message (the start, a resume, a round): the turn it begins is judged.
    if ((await queuedLoopRows(ctx, goal.conversation_id, goal.client_key)).length) return { ok: false as const, why: "queued" };
    const newest = await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", goal.conversation_id).gte("timestamp", goal.created_at - 5_000)).order("desc").take(EVIDENCE_ROWS);
    const rows = newest.reverse().filter((m: any) => !m.is_encrypted);
    // The turn's reply has not synced yet while the newest row is still the loop's own message.
    const last = rows[rows.length - 1];
    const synced = !!last && !(last.role === "user" && isGoalMessage(last.content));
    const messages = rows.map((m: any) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_results: m.tool_results, timestamp: m.timestamp }));
    const scope: CallScope = conv.team_id && !conv.is_private ? { workspace: `team:${conv.team_id}`, team_id: conv.team_id } : { workspace: `user:${conv.user_id}` };
    const budgeted = ((await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", scope.workspace)).first())?.cap_usd ?? 0) > 0;
    return { ok: true as const, objective: goal.objective, messages, synced, scope, budgeted, conversation_id: goal.conversation_id };
  },
});

type JudgeInputs =
  | { ok: false; why: string }
  | { ok: true; objective: string; messages: any[]; synced: boolean; scope: CallScope; budgeted: boolean; conversation_id: Id<"conversations"> };

type Judged = { verdict: GoalVerdict } | { error: string };

async function askJudge(ctx: any, input: { objective: string; messages: any[]; scope: CallScope; budgeted: boolean; conversation_id: Id<"conversations"> }): Promise<Judged> {
  const prompt = buildGoalJudgePrompt(input.objective, renderGoalEvidence(input.messages));
  const spec = { model: GOAL_JUDGE_MODEL, max_tokens: 1_000, prompt, output: "json" as const };
  let json: unknown = null;
  if (input.budgeted) {
    // A workspace with a model budget pays for its judges out of it.
    const r = await runModelCall(ctx, input.scope, "judge", spec, "Goal judge");
    if (!r.ok) return { error: r.reason === "budget" ? "The team's model budget has no room for the goal review" : `The goal review failed: ${r.error}` };
    json = r.json;
  } else {
    // No budget set: the call is codecast's own, like the idle summary's.
    const r = await callModelMetered({ ...spec, label: "Goal judge", gate: { ctx, scope: { conversationId: input.conversation_id } }, timeout_ms: 60_000 });
    if (!r.reply) return { error: `The goal review failed: ${r.error ?? "no answer"}` };
    json = parseJsonBlock(r.reply.text);
  }
  const verdict = parseGoalVerdict(json);
  return verdict ? { verdict } : { error: "The goal review gave no usable verdict" };
}

export const judgeTurn = internalAction({
  args: { goal_id: v.id("session_goals"), turn_key: v.number(), attempt: v.number() },
  handler: async (ctx, args): Promise<{ skipped?: string; error?: string; verdict?: string }> => {
    const input: JudgeInputs = await ctx.runQuery(internal.sessionGoals.judgeInputs, { goal_id: args.goal_id, turn_key: args.turn_key });
    if (!input.ok) return { skipped: input.why };
    if (!input.synced && args.attempt < SYNC_RETRIES) {
      await ctx.scheduler.runAfter(GOAL_JUDGE_DELAY_MS * (args.attempt + 1), internal.sessionGoals.judgeTurn, { ...args, attempt: args.attempt + 1 });
      return { skipped: "not_synced" };
    }
    let judged = await askJudge(ctx, input);
    if ("error" in judged && !/budget/.test(judged.error)) judged = await askJudge(ctx, input);
    const used_tools = usedToolsSinceLastGoalMessage(input.messages);
    if ("error" in judged) {
      await ctx.runMutation(internal.sessionGoals.applyVerdict, { goal_id: args.goal_id, turn_key: args.turn_key, error: judged.error, used_tools });
      return { error: judged.error };
    }
    await ctx.runMutation(internal.sessionGoals.applyVerdict, { goal_id: args.goal_id, turn_key: args.turn_key, verdict: judged.verdict, used_tools });
    return { verdict: judged.verdict.verdict };
  },
});

const verdictValidator = v.object({
  verdict: v.union(v.literal("done"), v.literal("continue"), v.literal("blocked"), v.literal("paused")),
  reason: v.string(),
  next_step: v.optional(v.string()),
});

/** Surfaces a loop that stopped without the person asking: the session's pinned state says so, and blocked files it under needs input. */
async function surface(ctx: MutationCtx, conv: Doc<"conversations">, status: "done" | "blocked", reason: string) {
  await performSetThreadState(ctx, conv, goalOutcomeState(status, reason), status);
}

/** A loop that paused itself needs the person, so it lands in needs input with why. */
async function surfacePause(ctx: MutationCtx, conv: Doc<"conversations">, reason: string) {
  await performSetThreadState(ctx, conv, goalPausedState(reason), "blocked");
}

export const applyVerdict = internalMutation({
  args: { goal_id: v.id("session_goals"), turn_key: v.number(), verdict: v.optional(verdictValidator), error: v.optional(v.string()), used_tools: v.boolean() },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goal_id);
    // A person paused, resumed or replaced it while the judge ran, or a newer turn end owns the verdict.
    if (!goal || goal.status !== "active" || goal.judged_status_ts !== args.turn_key) return { applied: false };
    const conv = await ctx.db.get(goal.conversation_id);
    if (!conv) return { applied: false };
    // A new turn began while the judge read (a person wrote in): that turn's end is judged instead.
    const session = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", goal.conversation_id)).first();
    if (session?.agent_status && (ACTIVE_AGENT_STATUSES.has(session.agent_status) || session.agent_status === "permission_blocked")) return { applied: false };
    const now = Date.now();
    if (!args.verdict) {
      const reason = args.error ?? "The goal review failed";
      await ctx.db.patch(goal._id, { status: "paused", reason, updated_at: now });
      await surfacePause(ctx, conv, reason);
      return { applied: true, status: "paused" };
    }
    const step = stepGoal(goal, args.verdict, args.used_tools);
    if (step.status === "active") {
      // Queued first: a session that no longer takes this person's messages pauses the goal and says why.
      try {
        await enqueuePendingMessage(ctx, conv, goal.set_by, {
          content: formatGoalMessage(step.deliver),
          origin: "scheduler",
          client_id: loopClientId(goal.client_key, `r${step.rounds}:${args.turn_key}`),
        });
      } catch (e) {
        const reason = `The next round could not be sent: ${e instanceof Error ? e.message : String(e)}`;
        await ctx.db.patch(goal._id, { status: "paused", reason, judged_status_ts: undefined, updated_at: now });
        await surfacePause(ctx, conv, reason);
        return { applied: true, status: "paused" };
      }
    }
    await ctx.db.patch(goal._id, {
      status: step.status,
      reason: step.reason,
      next_step: step.status === "active" ? step.next_step : undefined,
      verdict: step.verdict,
      stalls: step.stalls,
      ...(step.status === "active" ? { rounds: step.rounds, last_activity_at: now } : {}),
      updated_at: now,
    });
    if (step.status === "done" || step.status === "blocked") {
      await surface(ctx, conv, step.status, step.reason);
    } else if (step.status === "paused" && args.verdict.verdict !== "paused") {
      // A cap paused it: the person decides whether to resume.
      await surfacePause(ctx, conv, step.reason);
    }
    return { applied: true, status: step.status };
  },
});

// ── The idle limit ───────────────────────────────────────────────────────────

/**
 * Pauses an active goal nothing has moved for its idle limit: no turn end, no
 * message. A turn still running keeps it alive (its messages move the
 * session). Reschedules itself for the rest of the window otherwise.
 */
export const idleCheck = internalMutation({
  args: { goal_id: v.id("session_goals"), armed_at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goal_id);
    if (!goal || goal.status !== "active" || (goal.idle_armed_at ?? 0) !== (args.armed_at ?? 0)) return { stopped: true };
    const conv = await ctx.db.get(goal.conversation_id);
    if (!conv) return { stopped: true };
    const now = Date.now();
    // A session at a permission prompt waits on the person, and one settled as waiting has background work that will wake it: neither is idle.
    const session = await ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", goal.conversation_id)).first();
    const held = session?.agent_status === "permission_blocked" || session?.agent_status === "waiting";
    const seen = held ? now : Math.max(goal.last_activity_at, conv.updated_at ?? 0);
    if (now - seen < goal.idle_limit_ms) {
      await ctx.scheduler.runAfter(seen + goal.idle_limit_ms - now + 1_000, internal.sessionGoals.idleCheck, args);
      return { rescheduled: true };
    }
    const reason = `Nothing happened for ${Math.round(goal.idle_limit_ms / 60_000)} minutes`;
    await ctx.db.patch(goal._id, { status: "paused", reason, judged_status_ts: undefined, updated_at: now });
    await cancelQueuedLoop(ctx, goal);
    await surfacePause(ctx, conv, reason);
    return { paused: true };
  },
});

// ── Reads ────────────────────────────────────────────────────────────────────

/** The web's feed for one session's goal (store key `sessionGoals`): its newest row, for whoever can read the session. */
export const forConversation = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    const conv = id ? await ctx.db.get(id) : null;
    if (!userId || !conv || (await checkConversationAccess(ctx, userId, conv)) === "denied") return [];
    const goal = await readSessionGoal(ctx, conv._id);
    return goal ? [goal] : [];
  },
});

// ── The CLI (`cast loop`, /cli/goals/*) ──────────────────────────────────────

async function cliConversation(ctx: { db: any }, apiToken: string, session: string) {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Not authenticated");
  const conv = await findConversationByAnyRefWhere(ctx, session, async (c: any) => await canSendProductMessage(ctx, userId, c));
  if (!conv) throw new Error(`No session found for "${session}" that you can send to`);
  return { userId, conv: conv as Doc<"conversations"> };
}

/**
 * The caps and the review bound the agent they drive, so a session may not
 * start or restart its own goal: that is the person's act (the composer's
 * review, or `cast loop` from their own terminal or another session). Pausing
 * and clearing stay open to it, since stopping is the safe direction.
 */
async function refuseSelfSteer(ctx: { db: any }, userId: Id<"users">, conv: Doc<"conversations">, fromSession: string | undefined) {
  if (!fromSession?.trim()) return;
  const caller = await findConversationByAnyRefWhere(ctx, fromSession, (c: any) => String(c.user_id) === String(userId));
  if (caller && String(caller._id) === String(conv._id)) throw new Error("A session cannot start or resume its own goal; the person does that from the goal bar or /goal");
}

const view = (goal: Goal | null, conv: Doc<"conversations">) => ({ short_id: conv.short_id ?? String(conv._id).slice(0, 7), goal });

export const cliSet = mutation({
  args: { api_token: v.string(), session: v.string(), objective: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, conv } = await cliConversation(ctx, args.api_token, args.session);
    await refuseSelfSteer(ctx, userId, conv, args.from_session);
    return view(await performSetGoal(ctx, userId, conv._id, args.objective), conv);
  },
});

export const cliControl = mutation({
  args: { api_token: v.string(), session: v.string(), op: v.union(v.literal("pause"), v.literal("resume"), v.literal("clear")), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, conv } = await cliConversation(ctx, args.api_token, args.session);
    if (args.op === "resume") await refuseSelfSteer(ctx, userId, conv, args.from_session);
    return view(await performGoalControl(ctx, userId, conv._id, args.op), conv);
  },
});

export const cliShow = query({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await findConversationByAnyRefWhere(ctx, args.session, async (c: any) => (await checkConversationAccess(ctx, userId, c)) !== "denied");
    if (!conv) throw new Error(`No session found for "${args.session}"`);
    return view(await readSessionGoal(ctx, conv._id), conv as Doc<"conversations">);
  },
});
