// The hosted assistant's turn engine (plan pl-840, build spec
// docs/architecture/hosted-assistant.md "The turn"). One turn is one run of
// the harness's loop (@platform/agent runAssistant) inside a Convex action:
//
//   lease    (leaseTurn, from entry.wake or the end of a turn) inserts the one
//            running turn of the conversation and reserves its ceiling from
//            the wallet in the same mutation, or queues it behind the
//            person's other running turns, or ends it at once for budget.
//   begin    (mutation) takes the person's queued input into the transcript,
//            reads an answered approval, and returns what the run needs.
//   run      (action) runs the loop: text streams into one assistant row,
//            each finished row is stored as it lands (record), and every
//            write call is recorded as started before it runs (toolStarted).
//   finish   (mutation) charges what the run cost and releases the rest, sets
//            the conversation's work state, asks the person when a call waits
//            on them, continues a run that ran out of time, and wakes the
//            conversation again when input arrived meanwhile.
//
// An approval is a blocking session_decisions row asked through askCore.
// Its answer (a pending message, or a dismissal's wake) wakes the next turn,
// which reads the decision row itself: the message only schedules, it never
// counts as consent. The row's answer runs, declines, or (Always allow) runs
// and writes an assistant_rules row the gate reads from then on.
import { v } from "convex/values";
import {
  declineText,
  notRunText as hostNotRunText,
  parseInput,
  runAssistant,
  type Gate,
  type MessageRow,
  type Resolution,
  type RunAssistantOptions,
  type ToolCallRequest,
} from "@platform/agent";
import {
  allowScopeIn,
  approvalContext,
  humanLabel,
  NEVER,
  scopeMatch,
  stepAsk,
  systemPrompt as assistantPrompt,
  withRules as withRulesIn,
  type AllowScope,
  type RuleView,
  type SystemPromptArgs,
} from "@platform/assistant";
import { TURN_DEADLINE_MS, planOf, type PlanSpec, type TurnReason } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType, type AgentStatus } from "@codecast/shared/contracts";
import { internalAction, internalMutation, type MutationCtx } from "../functions";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ensureWallet, money, reserve, settleTurn, walletPlan, walletRoom } from "../lib/wallet";
import { isConversationSafetyBlocked } from "../conversationSafety";
import { markPendingDelivered } from "../pendingMessages";
import { applyHostedAgentStatus } from "../managedSessions";
import { askCore, withdrawCore } from "../sessionDecisions";
import { messageValidator } from "../messages";
import { ALLOW_SCOPES, toolsFor, type ToolsForOptions } from "./tools";
import { normalizeTimezone } from "../lib/teamDay";
import { decisionAnswerOf, pendingInput, turnsIn, type Input, type Turn } from "./input";
import {
  isStorableRow,
  loadHistory,
  strandedCalls,
  toStoredRow,
  writeNotice,
  writeRows,
  type StoredRow,
} from "./history";

/** The answers an approval card offers, in order: the first is the yes. */
export const APPROVE = "Approve";
export const ALWAYS_ALLOW = "Always allow";
export const DECLINE = "Decline";

/** A turn smaller than this is not worth starting: the wallet is empty. */
export const MIN_TURN_USD = 0.01;
/** How many times in a row a run that ran out of time is continued. */
export const MAX_TIME_CONTINUATIONS = 3;

/**
 * What the engine reaches outside itself, as one object tests replace: the
 * model (a Claude id, or a test's faux model), the keys, the tool set, and
 * the clocks. Prod uses the defaults.
 */
export const turnDeps: {
  model: (id: string) => RunAssistantOptions["model"];
  apiKeys: () => RunAssistantOptions["apiKeys"];
  toolsFor: typeof toolsFor;
  toolOptions: ToolsForOptions;
  /** How long one run may take (TURN_DEADLINE_MS). */
  deadlineMs: number;
  /** How long after its deadline a running turn counts as dead: the action
   *  may still be storing its last rows. */
  leaseMarginMs: number;
  /** The least time between two streamed writes of one message. */
  streamEveryMs: number;
} = {
  model: (id) => id,
  apiKeys: () => ({ anthropic: process.env.ANTHROPIC_API_KEY }),
  toolsFor,
  toolOptions: {},
  deadlineMs: TURN_DEADLINE_MS,
  leaseMarginMs: 2 * 60_000,
  streamEveryMs: 250,
};

/** The model a plan's turns run on: a paid plan's strong model, the free plan's default. */
export function modelFor(plan: PlanSpec): string {
  return plan.price_usd > 0 ? plan.strong_model : plan.default_model;
}

// ---------------------------------------------------------------- the lease

/** A running turn whose action is past its deadline and the margin after it:
 *  the action died, and the turn is ended in its place. */
export function leaseExpired(turn: Pick<Turn, "status" | "started_at" | "_creationTime">, now: number): boolean {
  return turn.status === "running" && now - (turn.started_at ?? turn._creationTime) >= turnDeps.deadlineMs + turnDeps.leaseMarginMs;
}

export type LeaseOutcome = "started" | "busy" | "queued" | "idle" | "budget" | "blocked";

/**
 * The one door into a turn (entry.wake, and the end of every turn). Starts
 * the conversation's turn when it has input and none is running: inserts a
 * running turn, reserves its ceiling from the wallet in this same mutation,
 * and schedules the run. A running turn makes this a no-op: the input waits
 * and the turn's finish wakes the conversation again. Past the plan's
 * concurrent turns the turn waits as `queued` until one of the person's
 * turns ends. With no room in the wallet the turn ends at once for budget.
 * `continues` starts a turn with no new input: a run that ran out of time
 * carrying on.
 */
export async function leaseTurn(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  opts: { continues?: Id<"assistant_turns"> } = {},
): Promise<LeaseOutcome> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || !isHostedAgentType(conversation.agent_type)) return "idle";
  if (isConversationSafetyBlocked(conversation)) return "blocked";
  const now = Date.now();
  for (const turn of await turnsIn(ctx, conversationId, "running")) {
    if (!leaseExpired(turn, now)) return "busy";
    await expireTurn(ctx, turn);
  }

  const queued = (await turnsIn(ctx, conversationId, "queued")).sort((a, b) => a._creationTime - b._creationTime);
  const continues = opts.continues ?? queued.find((turn) => turn.continues)?.continues;
  const input = await pendingInput(ctx, conversationId);
  if (!input.ready && !continues) {
    // Answers to a decision that is not the open one change nothing.
    for (const row of input.answers) {
      if (!input.decision || decisionAnswerOf(row) !== String(input.decision._id)) await markPendingDelivered(ctx, row);
    }
    for (const turn of queued) await ctx.db.delete(turn._id);
    // The web sends an answer's message and its decision patch separately;
    // when the message lands first, look again shortly.
    if (input.answerAhead && input.answers.some((row) => now - row.created_at < 60_000)) {
      await ctx.scheduler.runAfter(2_000, internal.assistant.entry.wake, { conversation_id: conversationId, cause: "approval" });
    }
    return "idle";
  }

  const userId = conversation.user_id;
  const plan = await walletPlan(ctx, userId);
  const running = await ctx.db
    .query("assistant_turns")
    .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "running"))
    .collect();
  if (running.filter((turn) => !leaseExpired(turn, now)).length >= plan.concurrent_turns) {
    if (queued.length === 0) {
      await ctx.db.insert("assistant_turns", {
        conversation_id: conversationId,
        user_id: userId,
        status: "queued",
        cost_reserved_usd: 0,
        ...(continues ? { continues } : {}),
      });
    }
    return "queued";
  }

  const model = modelFor(plan);
  const fields = { status: "running" as const, started_at: now, model, cost_usd: 0, ...(continues ? { continues } : {}) };
  let turnId: Id<"assistant_turns">;
  if (queued[0]) {
    turnId = queued[0]._id;
    await ctx.db.patch(turnId, fields);
    for (const extra of queued.slice(1)) await ctx.db.delete(extra._id);
  } else {
    turnId = await ctx.db.insert("assistant_turns", { conversation_id: conversationId, user_id: userId, cost_reserved_usd: 0, ...fields });
  }

  // The full ceiling when the wallet has it (reserve frees leaked holds
  // before it refuses), else whatever room is left.
  let held = await reserve(ctx, userId, turnId, plan.turn_ceiling_usd);
  if (!held) {
    const room = walletRoom(await ensureWallet(ctx, userId));
    held = room >= MIN_TURN_USD && (await reserve(ctx, userId, turnId, room));
  }
  if (!held) {
    await refuseForBudget(ctx, (await ctx.db.get(turnId))!, input);
    return "budget";
  }
  await applyHostedAgentStatus(ctx, { conversation_id: conversationId, agent_status: "working" });
  await ctx.scheduler.runAfter(0, internal.assistant.turns.run, { turn_id: turnId });
  await ctx.scheduler.runAfter(turnDeps.deadlineMs + turnDeps.leaseMarginMs, internal.assistant.turns.expire, { turn_id: turnId });
  return "started";
}

/** No room in the wallet: the person's words go into the transcript (so a
 *  sweep never wakes the conversation for them again), a plain line says why
 *  nothing happened and what to do, and the turn ends with reason `budget`.
 *  A parked approval this turn took up ends as begin would end it (settleParked),
 *  and its call is answered as not run, right after the call's message and
 *  before any later row, so the transcript never holds a call with no result
 *  and a later turn never runs a call the person saw refused for usage. The
 *  result names the real reason: usage only when the person approved it. */
async function refuseForBudget(ctx: MutationCtx, turn: Turn, input: Input): Promise<void> {
  const parked = await settleParked(ctx, turn, input);
  if (parked?.call) {
    await writeRows(ctx, turn.conversation_id, [{
      role: "user",
      message_uuid: `not-run:${parked.call.tool_call_id}`,
      tool_results: [{ tool_use_id: parked.call.tool_call_id, content: notRunText(parked.call.tool, parked.answer), is_error: true }],
      timestamp: Date.now(),
    }]);
  }
  await takeTyped(ctx, turn.conversation_id, input.typed);
  for (const row of input.answers) await markPendingDelivered(ctx, row);
  await stopTurn(ctx, turn, { status: "done", reason: "budget", costUsd: 0 }, () => budgetLine(ctx, turn.user_id, true));
}

/** Ends a running turn whose action died: it charges what the turn recorded
 *  spending (record keeps cost_usd current) and gives back the rest. */
async function expireTurn(ctx: MutationCtx, turn: Turn): Promise<void> {
  await stopTurn(ctx, turn, { status: "failed", reason: "error", costUsd: turn.cost_usd ?? 0, error: "The run stopped without reporting back" }, ERROR_LINE);
}

/** The lease expiry sweep, scheduled with every lease. */
export const expire = internalMutation({
  args: { turn_id: v.id("assistant_turns") },
  handler: async (ctx, args): Promise<null> => {
    const turn = await ctx.db.get(args.turn_id);
    if (!turn || !leaseExpired(turn, Date.now())) return null;
    await expireTurn(ctx, turn);
    await afterTurn(ctx, turn);
    return null;
  },
});

// ------------------------------------------------------------ ending a turn

/** Moves a turn out of `running` and settles its wallet hold in the same
 *  mutation: charges its cost, gives back the rest (lib/wallet settleTurn). */
type TurnEnd = { status: Turn["status"]; reason: TurnReason; costUsd: number; error?: string; model?: string; usage?: { input: number; output: number } };

async function endTurn(ctx: MutationCtx, turn: Turn, end: TurnEnd): Promise<void> {
  await ctx.db.patch(turn._id, {
    status: end.status,
    reason: end.reason,
    ended_at: Date.now(),
    ...(end.error ? { error: end.error.slice(0, 2_000) } : {}),
    ...(end.model ? { model: end.model } : {}),
    ...(end.usage ? { input_tokens: end.usage.input, output_tokens: end.usage.output } : {}),
  });
  await settleTurn(ctx, turn._id, end.costUsd, end.model ?? turn.model);
}

async function setWorkState(ctx: MutationCtx, conversationId: Id<"conversations">, status: AgentStatus): Promise<void> {
  await applyHostedAgentStatus(ctx, {
    conversation_id: conversationId,
    agent_status: status,
    ...(status === "working" ? {} : { turn_completed_at: Date.now() }),
  });
}

/** A line saying why the turn stopped, and the conversation idle. Both are
 *  skipped for a conversation that is gone, so they never undo the mutation
 *  that ends the turn and settles its hold. A line built from the wallet is
 *  built after the turn settles, so it reads the room the person has left. */
async function tellStopped(ctx: MutationCtx, turn: Turn, line: string | (() => Promise<string>)): Promise<void> {
  await writeNotice(ctx, turn.conversation_id, String(turn._id), typeof line === "string" ? line : await line());
  await setWorkState(ctx, turn.conversation_id, "idle");
}

/** Every ending that stops short of an answer: ends the turn (settling its
 *  hold), then tells the person why. What runs next is the caller's. */
async function stopTurn(ctx: MutationCtx, turn: Turn, end: TurnEnd, line: string | (() => Promise<string>)): Promise<void> {
  await endTurn(ctx, turn, end);
  await tellStopped(ctx, turn, line);
}

/** After a turn ends: the conversation's next turn if input arrived while it
 *  ran, then the person's queued turns, oldest first, while slots are free. */
async function afterTurn(ctx: MutationCtx, turn: Turn): Promise<void> {
  await leaseTurn(ctx, turn.conversation_id);
  await promoteQueued(ctx, turn.user_id);
}

const ERROR_LINE = "Something went wrong on my side, so I stopped here. You can ask me to try again.";
const SAFETY_LINE = "This conversation was stopped by a safety check, so I can't continue here.";
const TIME_LINE = "This is taking longer than I can work in one go, so I stopped here. Tell me to keep going and I'll pick up where I left off.";

function dayIn(at: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: normalizeTimezone(timeZone) }).format(at);
}

/** Why a turn stopped for money, in the person's words, with what they can
 *  do. `atStart` is a turn refused before it ran. A run that stopped on its
 *  ceiling while the wallet still holds a whole turn's worth hit the per-turn
 *  limit; otherwise the wallet itself is running out. */
async function budgetLine(ctx: MutationCtx, userId: Id<"users">, atStart: boolean): Promise<string> {
  const wallet = await ensureWallet(ctx, userId);
  const plan = planOf(wallet.plan);
  if (!atStart && walletRoom(wallet) >= plan.turn_ceiling_usd) {
    return "I stopped here because this request reached the most I spend on one go. Tell me to keep going and I'll continue.";
  }
  const user = await ctx.db.get(userId);
  const reset = dayIn(wallet.period_end, user?.timezone);
  const more = plan.id === "pro" ? "add usage from Plan" : "upgrade or add usage from Plan";
  return `You've used ${atStart ? "all" : "nearly all"} the usage included in your ${plan.label} plan for now, so I can't ${atStart ? "work on this" : "go further"} yet. You can ${more}, or I'll be ready again on ${reset}.`;
}

// ----------------------------------------------------------------- the gate

export type { AllowScope, RuleView } from "@platform/assistant";

/** How an "Always allow" narrows for one call (@platform/assistant rules, over
 *  the tool set's ALLOW_SCOPES): the one place both the card (whether to
 *  offer it, and what it says it covers) and the gate (which rules apply)
 *  read. A tool the table does not list is always asked. */
export function allowScope(call: Pick<ToolCallRequest, "name" | "input">): AllowScope {
  return allowScopeIn(ALLOW_SCOPES, call);
}

/** The turn's gate (tools/index toolsFor), with the person's rules applied to
 *  a write call it would ask about (@platform/assistant withRules, over
 *  ALLOW_SCOPES). While `readOutside` says content the person did not write is
 *  in front of the model, an allow rule never waives a call that reaches
 *  other people. */
export function withRules(base: Gate, rules: readonly RuleView[], readOutside: () => boolean = () => false): Gate {
  return withRulesIn(base, rules, ALLOW_SCOPES, readOutside);
}

// -------------------------------------------------------------- approvals

export { approvalContext };

export interface PendingCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  risk: "read" | "write";
  label?: string;
}

/** What an "Always allow" would let run, in the words the card shows. A
 *  narrowed rule says what it matches; a whole-tool rule covers every later
 *  call of the tool, so it is named by the tool alone (the step's words with
 *  no input), never by this call's note or recipient. */
export function alwaysCovers(call: Pick<PendingCallView, "name" | "label">, scope: AllowScope): string {
  if (scope.kind === "match") return scope.covers;
  return stepAsk({ name: call.name, input: {} }) ?? call.label ?? humanLabel(call.name);
}

/** Asks the person about one call: a blocking decision on the conversation,
 *  only its owner asked (routeFor). Always allow is offered for a write call
 *  whose tool narrows (allowScope), and says what it would cover. */
async function askApproval(ctx: MutationCtx, conversation: Doc<"conversations">, call: PendingCallView): Promise<Id<"session_decisions">> {
  // The step's own words, so the card and the receipt name the action one way.
  const label = stepAsk(call) ?? call.label ?? humanLabel(call.name);
  const scope = call.risk === "write" ? allowScope(call) : NEVER;
  const options = [
    { label: APPROVE, description: "Do this once." },
    ...(scope.kind === "never" ? [] : [{ label: ALWAYS_ALLOW, description: `${alwaysCovers(call, scope)} from now on without asking.` }]),
    { label: DECLINE, description: "Don't do it." },
  ];
  const asked = await askCore(ctx, { userId: conversation.user_id }, {
    session_id: conversation.session_id,
    question: `${label}?`,
    options,
    // Times in the draft read on the person's own clock (their profile's zone).
    context_md: approvalContext(call.input, { timezone: (await ctx.db.get(conversation.user_id))?.timezone }),
    blocking: true,
  });
  if (!asked?.id) throw new Error(asked?.error ?? "The approval could not be asked");
  return asked.id;
}

/** The person's answer to a parked call, read from the decision row: only an
 *  answer the owner gave in person runs anything. A dismissal, a withdrawal,
 *  a missing row or anyone else's answer declines. */
function approvalOf(decision: Doc<"session_decisions"> | null, ownerId: Id<"users">): { decision: "approve" | "decline"; always: boolean; note?: string } {
  const decline = (note?: string) => ({ decision: "decline" as const, always: false, ...(note ? { note } : {}) });
  if (!decision || decision.status !== "answered") return decline();
  if (decision.answered_by?.kind !== "user" || String(decision.resolved_by) !== String(ownerId)) return decline();
  const label = decision.answer_index !== undefined ? decision.options[decision.answer_index]?.label : undefined;
  if (label === APPROVE) return { decision: "approve", always: false };
  if (label === ALWAYS_ALLOW) return { decision: "approve", always: true };
  return decline(decision.answer_text?.trim() || undefined);
}

// ------------------------------------------------------------------ begin

/** The person's queued words, into the transcript as their rows (which also
 *  settles each pending row through the writer's echo match), then every row
 *  marked delivered. */
async function takeTyped(ctx: MutationCtx, conversationId: Id<"conversations">, typed: Doc<"pending_messages">[]): Promise<void> {
  if (typed.length === 0) return;
  const now = Date.now();
  await writeRows(ctx, conversationId, typed.map((row, i) => ({
    role: "user" as const,
    message_uuid: `pending:${row._id}`,
    content: row.content,
    timestamp: now + i,
  })));
  for (const row of typed) {
    const fresh = await ctx.db.get(row._id);
    if (fresh?.status === "pending") await markPendingDelivered(ctx, fresh);
  }
}

const NOT_RUN_MOVED_ON = "The person wrote again instead of answering, so it did not run.";
const NOT_RUN_STRANDED = hostNotRunText("the conversation moved on before it could");
const NOT_RUN_BUDGET = hostNotRunText("the person's plan had no usage left to run it");

type ParkedCall = NonNullable<Turn["pending_call"]>;
type Answer = ReturnType<typeof approvalOf>;

/** The result of a parked call that cannot run now: a declined call reads as
 *  the run would answer it (declineText), so the model never mistakes a
 *  refusal for a usage limit and offers the same call again. */
function notRunText(tool: string, answer: Answer): string {
  return answer.decision === "approve" ? NOT_RUN_BUDGET : declineText(tool, answer.note);
}

/**
 * Closes the turn parked on an approval once a turn takes it up (the card was
 * answered, dismissed or withdrawn, or the person wrote again instead): reads
 * the answer from the decision row, takes a card that is still up down when
 * the person moved on, writes the Always allow rule an answer asked for, and
 * marks the parked turn done. The parked call itself is the caller's to run
 * or answer. Begin and a budget refusal both go through here, so the card,
 * the rule and the parked turn end the same way whether or not the call can
 * run now. Null when no turn is parked or its input is not ready.
 */
async function settleParked(ctx: MutationCtx, turn: Turn, input: Input): Promise<{ call?: ParkedCall; answer: Answer } | null> {
  if (!input.waiting || !input.ready) return null;
  let answer = approvalOf(input.decision, turn.user_id);
  if (!input.resolved && input.decision) {
    // The person moved on: the card comes down, and the call does not run.
    await withdrawCore(ctx, input.decision, Date.now());
    answer = { decision: "decline", always: false, note: NOT_RUN_MOVED_ON };
  }
  const call = input.waiting.pending_call;
  if (call && answer.always) await allowAlways(ctx, turn.user_id, call);
  await ctx.db.patch(input.waiting._id, { status: "done" });
  if (!turn.continues) await ctx.db.patch(turn._id, { continues: input.waiting._id });
  return { ...(call ? { call } : {}), answer };
}

/** Writes the allow rule an Always allow answer asked for, once: the same
 *  rule can be offered again (one call asked in two conversations before
 *  either answer lands), and the gate reads every rule on every turn. */
async function allowAlways(ctx: MutationCtx, userId: Id<"users">, call: ParkedCall): Promise<void> {
  const scope = allowScope({ name: call.tool, input: call.args ?? {} });
  if (scope.kind === "never") return;
  const match = scopeMatch(scope);
  const existing = await ctx.db
    .query("assistant_rules")
    .withIndex("by_user_tool", (q) => q.eq("user_id", userId).eq("tool", call.tool))
    .collect();
  if (existing.some((rule) => rule.decision === "allow" && rule.match === match)) return;
  await ctx.db.insert("assistant_rules", {
    user_id: userId,
    tool: call.tool,
    decision: "allow",
    ...(match ? { match } : {}),
    created_at: Date.now(),
  });
}

export interface Begun {
  conversation_id: Id<"conversations">;
  user_id: Id<"users">;
  model: string;
  ceiling_usd: number;
  history: MessageRow[];
  resume: Resolution[];
  started_calls: string[];
  rules: RuleView[];
  name?: string;
  timezone?: string;
}

/** Starts a leased turn's run: takes the queued input, resolves an answered
 *  approval, and returns what the run needs. Null when the turn is no longer
 *  running (a stale schedule). */
export const begin = internalMutation({
  args: { turn_id: v.id("assistant_turns") },
  handler: async (ctx, args): Promise<Begun | null> => {
    const turn = await ctx.db.get(args.turn_id);
    if (!turn || turn.status !== "running") return null;
    const conversation = await ctx.db.get(turn.conversation_id);
    // Deleted or safety-blocked after the lease: the run never starts, so no
    // tool acts, and the reservation goes back now rather than at lease
    // expiry. A blocked conversation takes no new input (wake answers
    // "blocked"), so its line promises no retry.
    if (!conversation || isConversationSafetyBlocked(conversation)) {
      const blocked = conversation !== null;
      const error = blocked ? "Safety stop" : "The conversation is gone";
      await stopTurn(ctx, turn, { status: "failed", reason: "error", costUsd: turn.cost_usd ?? 0, error }, blocked ? SAFETY_LINE : ERROR_LINE);
      await afterTurn(ctx, turn);
      return null;
    }
    const input = await pendingInput(ctx, turn.conversation_id);
    const resume: Resolution[] = [];

    const parked = await settleParked(ctx, turn, input);
    const call = parked?.call;
    if (call && parked) {
      resume.push({
        call: { id: call.tool_call_id, name: call.tool, input: call.args ?? {}, risk: "write" },
        decision: parked.answer.decision,
        ...(parked.answer.note ? { note: parked.answer.note } : {}),
      });
    }

    // A turn that carries out an answer takes no new input. The answered
    // call's result belongs right after its message, and the rest of its
    // batch, not asked yet, goes through the gate only while no word from the
    // person follows that message. Input that waited for the answer (sent
    // before the card, or a routine firing while it was open) goes to the
    // turn after this one, which this turn's end starts.
    if (!(call && input.resolved)) await takeTyped(ctx, turn.conversation_id, input.typed);
    for (const row of input.answers) {
      const fresh = await ctx.db.get(row._id);
      if (fresh?.status === "pending") await markPendingDelivered(ctx, fresh);
    }

    const history = await loadHistory(ctx, turn.conversation_id);
    const resolving = new Set(resume.map((r) => r.call.id));
    for (const call of strandedCalls(history)) {
      if (resolving.has(call.id)) continue;
      resume.push({ call: { id: call.id, name: call.name, input: parseInput(call.input), risk: "write" }, decision: "decline", note: NOT_RUN_STRANDED });
    }

    // Write calls earlier turns started; one whose result never landed is
    // most likely on the turn just before this one, ended or expired.
    const recent: Turn[] = [];
    for (const status of ["done", "failed"] as const) {
      recent.push(...(await ctx.db
        .query("assistant_turns")
        .withIndex("by_conversation_status", (q) => q.eq("conversation_id", turn.conversation_id).eq("status", status))
        .order("desc")
        .take(10)));
    }
    const started = [...new Set(recent.flatMap((t) => t.started_calls ?? []))];
    const rules = (await ctx.db
      .query("assistant_rules")
      .withIndex("by_user_tool", (q) => q.eq("user_id", conversation.user_id))
      .collect()).map((rule) => ({ tool: rule.tool, decision: rule.decision, ...(rule.match !== undefined ? { match: rule.match } : {}) }));
    const user = await ctx.db.get(conversation.user_id);

    return {
      conversation_id: turn.conversation_id,
      user_id: conversation.user_id,
      model: turn.model ?? modelFor(await walletPlan(ctx, conversation.user_id)),
      // The run may spend all its turn reserved: paid tools (search_web)
      // reserve their own spend through ctx.remainingUsd and ctx.charge.
      ceiling_usd: turn.cost_reserved_usd,
      history,
      resume,
      started_calls: started,
      rules,
      ...(user?.name ? { name: user.name } : {}),
      ...(user?.timezone ? { timezone: user.timezone } : {}),
    };
  },
});

// ----------------------------------------------------------- run helpers

/** Stores rows the run made, and keeps the turn's recorded cost current, so
 *  a turn whose action dies is charged what it spent. False when the turn is
 *  no longer running (its lease expired): the run then stops. */
export const record = internalMutation({
  args: {
    turn_id: v.id("assistant_turns"),
    messages: v.array(messageValidator),
    cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const turn = await ctx.db.get(args.turn_id);
    if (!turn || turn.status !== "running") return false;
    if (args.cost_usd !== undefined) await ctx.db.patch(turn._id, { cost_usd: money(args.cost_usd) });
    // A conversation deleted mid-run stops the run; its finish still ends the
    // turn and charges the cost just recorded.
    if (!(await writeRows(ctx, turn.conversation_id, args.messages))) return false;
    // A finished row is the run's sign of life: it keeps the turn reading live.
    if (args.cost_usd !== undefined) await setWorkState(ctx, turn.conversation_id, "working");
    return true;
  },
});

/** Records a write call as started before it runs (the harness's
 *  onToolStart). False when the turn is no longer running. */
export const toolStarted = internalMutation({
  args: { turn_id: v.id("assistant_turns"), call_id: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const turn = await ctx.db.get(args.turn_id);
    if (!turn || turn.status !== "running") return false;
    const started = turn.started_calls ?? [];
    if (!started.includes(args.call_id)) await ctx.db.patch(turn._id, { started_calls: [...started, args.call_id] });
    return true;
  },
});

/** The assistant's standing instructions (@platform/assistant systemPrompt),
 *  with the person's tasks, docs and notes in codecast. */
export function systemPrompt(args: Omit<SystemPromptArgs, "workspace">): string {
  return assistantPrompt({ ...args, workspace: "codecast" });
}

// --------------------------------------------------------------- the run

/** One turn's run of the loop. Scheduled by leaseTurn; ends in finish. */
export const run = internalAction({
  args: { turn_id: v.id("assistant_turns") },
  handler: async (ctx, args): Promise<null> => {
    const turnId = args.turn_id;
    const failure = (error: unknown) => ({
      turn_id: turnId,
      reason: "error" as const,
      error: error instanceof Error ? error.message : String(error),
      cost_usd: Number.NaN,
      pending: [],
    });
    let begun: Begun | null;
    try {
      begun = await ctx.runMutation(internal.assistant.turns.begin, { turn_id: turnId });
    } catch (error) {
      await ctx.runMutation(internal.assistant.turns.finish, failure(error));
      return null;
    }
    if (!begun) return null;
    const ready = begun;

    try {
      const set = await turnDeps.toolsFor(ctx, ready.user_id, ready.conversation_id, turnDeps.toolOptions);
      const labels = new Map(set.tools.map((tool) => [tool.name, tool.label]));
      // The gate reads every row the run works from: the history and each row it adds.
      const rows: MessageRow[] = [...ready.history];
      const controller = new AbortController();
      let cost = 0;
      // Each streamed message keeps the timestamp of its first write.
      const stamps = new Map<string, number>();
      const stamp = (uuid: string) => {
        if (!stamps.has(uuid)) stamps.set(uuid, Date.now());
        return stamps.get(uuid)!;
      };
      const write = async (messages: StoredRow[], costUsd?: number) => {
        const live = await ctx.runMutation(internal.assistant.turns.record, {
          turn_id: turnId,
          messages,
          ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
        });
        if (!live) controller.abort();
      };
      let lastStream = 0;

      const result = await runAssistant({
        model: turnDeps.model(ready.model),
        system: systemPrompt({ name: ready.name, timezone: ready.timezone, now: Date.now(), note: set.note }),
        history: ready.history,
        tools: set.tools,
        gate: withRules(set.gate(rows), ready.rules, () => set.readOutside(rows)),
        ceilingUsd: ready.ceiling_usd,
        deadlineMs: turnDeps.deadlineMs,
        apiKeys: turnDeps.apiKeys(),
        signal: controller.signal,
        resume: ready.resume,
        startedCalls: ready.started_calls,
        sessionId: String(ready.conversation_id),
        onText: async (text, { messageUuid }) => {
          const now = Date.now();
          if (now - lastStream < turnDeps.streamEveryMs) return;
          lastStream = now;
          await write([{ role: "assistant", message_uuid: messageUuid, content: text, timestamp: stamp(messageUuid) }]);
        },
        onMessage: async (row, { costUsd }) => {
          rows.push(row);
          cost += costUsd;
          const stored = isStorableRow(row)
            ? [{ ...toStoredRow(row), ...(row.message_uuid ? { timestamp: stamp(row.message_uuid) } : {}) }]
            : [];
          await write(stored, cost);
        },
        onToolStart: async (call) => {
          const live = await ctx.runMutation(internal.assistant.turns.toolStarted, { turn_id: turnId, call_id: call.id });
          if (!live) {
            controller.abort();
            throw new Error("the turn ended");
          }
        },
      });

      await ctx.runMutation(internal.assistant.turns.finish, {
        turn_id: turnId,
        reason: result.reason,
        ...(result.error ? { error: result.error } : {}),
        cost_usd: result.costUsd,
        model: result.model,
        input_tokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        output_tokens: result.usage.output,
        pending: result.pending.map((call) => ({
          id: call.id,
          name: call.name,
          input: call.input,
          risk: call.risk,
          ...(labels.get(call.name) ? { label: labels.get(call.name) } : {}),
        })),
      });
    } catch (error) {
      await ctx.runMutation(internal.assistant.turns.finish, failure(error));
    }
    return null;
  },
});

const pendingCallViewValidator = v.object({
  id: v.string(),
  name: v.string(),
  input: v.any(),
  risk: v.union(v.literal("read"), v.literal("write")),
  label: v.optional(v.string()),
});

/** How many turns in a row before this one stopped for time. */
async function timeChain(ctx: MutationCtx, turn: Turn): Promise<number> {
  let count = 0;
  let at: Turn | null = turn;
  while (at?.continues && count < MAX_TIME_CONTINUATIONS + 1) {
    const previous: Turn | null = await ctx.db.get(at.continues);
    if (!previous || previous.reason !== "time") break;
    count++;
    at = previous;
  }
  return count;
}

/**
 * The end of a run: settles the wallet (charge what it cost, release the
 * rest), records why it stopped, sets the work state, and decides what comes
 * next. `cost_usd` NaN (the action failed before the run could report) charges
 * the cost the turn recorded as it went.
 */
export const finish = internalMutation({
  args: {
    turn_id: v.id("assistant_turns"),
    reason: v.union(v.literal("done"), v.literal("approval"), v.literal("budget"), v.literal("time"), v.literal("error")),
    error: v.optional(v.string()),
    cost_usd: v.number(),
    model: v.optional(v.string()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    pending: v.array(pendingCallViewValidator),
  },
  handler: async (ctx, args): Promise<null> => {
    const turn = await ctx.db.get(args.turn_id);
    // Not running: its lease expired and the sweep already ended and settled it.
    if (!turn || turn.status !== "running") return null;
    const conversation = await ctx.db.get(turn.conversation_id);
    const costUsd = Number.isFinite(args.cost_usd) ? args.cost_usd : (turn.cost_usd ?? 0);
    const usage = args.input_tokens !== undefined ? { input: args.input_tokens, output: args.output_tokens ?? 0 } : undefined;
    const common = { costUsd, ...(args.model ? { model: args.model } : {}), ...(usage ? { usage } : {}) };

    if (args.reason === "approval" && conversation && args.pending[0]) {
      // One call is asked at a time. The rest of its batch go through the
      // gate again when the next turn starts, and wait their turn.
      const call = args.pending[0];
      let decisionId: Id<"session_decisions">;
      try {
        decisionId = await askApproval(ctx, conversation, call);
      } catch (error) {
        await stopTurn(ctx, turn, { ...common, status: "failed", reason: "error", error: error instanceof Error ? error.message : String(error) }, ERROR_LINE);
        await afterTurn(ctx, turn);
        return null;
      }
      await ctx.db.patch(turn._id, {
        pending_call: { tool_call_id: call.id, tool: call.name, args: call.input, decision_id: decisionId },
      });
      await endTurn(ctx, turn, { ...common, status: "waiting", reason: "approval" });
      await setWorkState(ctx, turn.conversation_id, "permission_blocked");
      // Input that came in meanwhile waits for the answer: the next turn
      // takes both. Other conversations' queued turns may start.
      await promoteQueued(ctx, turn.user_id);
      return null;
    }

    if (args.reason === "time") {
      await endTurn(ctx, turn, { ...common, status: "done", reason: "time" });
      if ((await timeChain(ctx, turn)) < MAX_TIME_CONTINUATIONS) {
        // The same conversation carries on with no new input. A budget refusal
        // writes its own line and work state; a safety stop or a conversation
        // that is gone falls through to the line below and goes idle.
        const next = await leaseTurn(ctx, turn.conversation_id, { continues: turn._id });
        if (next === "started" || next === "queued" || next === "busy" || next === "budget") {
          await promoteQueued(ctx, turn.user_id);
          return null;
        }
      }
      await tellStopped(ctx, turn, TIME_LINE);
      await afterTurn(ctx, turn);
      return null;
    }

    if (args.reason === "budget") {
      await stopTurn(ctx, turn, { ...common, status: "done", reason: "budget" }, () => budgetLine(ctx, turn.user_id, false));
      await afterTurn(ctx, turn);
      return null;
    }

    if (args.reason === "error" || args.reason === "approval") {
      await stopTurn(ctx, turn, { ...common, status: "failed", reason: "error", error: args.error ?? "The run stopped for approval with no call to ask about" }, ERROR_LINE);
      await afterTurn(ctx, turn);
      return null;
    }

    await endTurn(ctx, turn, { ...common, status: "done", reason: "done" });
    await setWorkState(ctx, turn.conversation_id, "done");
    await afterTurn(ctx, turn);
    return null;
  },
});

/** Starts the person's queued turns, oldest first, while their plan has slots. */
async function promoteQueued(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const queued = (await ctx.db
    .query("assistant_turns")
    .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "queued"))
    .collect()).sort((a, b) => a._creationTime - b._creationTime);
  for (const next of queued) {
    if ((await leaseTurn(ctx, next.conversation_id)) === "queued") break;
  }
}
