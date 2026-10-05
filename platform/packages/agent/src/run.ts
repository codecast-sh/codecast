import {
  runAgentLoopContinue,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentToolResult,
  type StreamFn,
} from "@mariozechner/pi-agent-core";
import {
  validateToolArguments,
  type Api,
  type SimpleStreamOptions,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { messagesToRows, prepareContext, rowsToMessages, type MessageRow, type RowMessage } from "./history";
import { affordableOutputTokens, billedUsage, messageCost, priceFor, projectInputCost } from "./meter";
import { resolveModel } from "./models";
import { streamModel } from "./stream";
import { runTool, stoppedText, toAgentTool, type Tool, type ToolRisk } from "./tool";
import { UNTRUSTED_GUIDANCE } from "./untrusted";

/**
 * Why a run stopped.
 * - `done`: the model finished its answer.
 * - `approval`: a tool call waits on the person; see `pending`.
 * - `budget`: the next model call could cost more than the ceiling left.
 * - `time`: the deadline passed.
 * - `error`: the model call failed, the run was cancelled, or the history
 *   cannot be continued; see `error`.
 */
export type StopReason = "done" | "approval" | "budget" | "time" | "error";

/** A tool call the gate is asked about, and the shape of a call waiting on approval. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  risk: ToolRisk;
}

export type GateVerdict = "allow" | "ask" | "refuse";

/** A verdict, optionally with the reason a refusal gives the model. */
export type GateDecision = GateVerdict | { verdict: GateVerdict; reason?: string };

/**
 * Decides each tool call before it runs: `allow` runs it, `ask` stops the run
 * with the call pending, `refuse` answers the model with an error and goes on.
 * A gate that throws is treated as `ask`, so a failed rule lookup leaves the
 * decision to the person.
 */
export type Gate = (call: ToolCallRequest) => GateDecision | Promise<GateDecision>;

/** The default gate: reads run, writes ask. */
export const gateByRisk: Gate = (call) => (call.risk === "read" ? "allow" : "ask");

/** The person's answer to a pending call, handed to the next run. */
export interface Resolution {
  /** The pending call as the person saw it; an approval runs only when its `input` matches the history's. */
  call: ToolCallRequest;
  decision: "approve" | "decline";
  /** For a decline, what the model is told (the person's words, if any). */
  note?: string;
}

export interface RunAssistantOptions {
  /** A Claude model id (resolved with `resolveModel`) or a pi model. */
  model: string | Model<Api>;
  system: string;
  /** The conversation so far as codecast rows, oldest first. Must end with the person's turn, tool results, or a pending call that `resume` answers. */
  history: readonly MessageRow[];
  tools?: readonly Tool[];
  /** Defaults to `gateByRisk`. */
  gate?: Gate;
  /** The most this run may spend, in dollars. Zero or more; `Infinity` for no cap. NaN or a negative value stops with `error`. */
  ceilingUsd: number;
  /**
   * Wall time this run may take, in milliseconds from the call. `Infinity`
   * sets no deadline; a finite value is capped at `MAX_DEADLINE_MS`. NaN or a
   * negative value stops with `error`.
   */
  deadlineMs: number;
  /**
   * API keys by provider (`{ anthropic: "sk-ant-..." }`). When given, it must
   * hold the model's provider, or the run stops with `error`: it never falls
   * back to the process env key, so a run meant for one key cannot bill
   * another. Leave it out to use the provider's env variable.
   */
  apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Cancels the run; it stops with reason `error`. */
  signal?: AbortSignal;
  /**
   * The assistant message being written, as its full text so far. Each model
   * message has its own `messageUuid`, the same one its finished row carries,
   * so a caller can stream into one stored row and finish it in place.
   */
  onText?: (text: string, info: { messageUuid: string; delta: string }) => void | Promise<void>;
  /**
   * Each finished row (an assistant message, a tool result), in order, with
   * the dollars it cost: its model call, or what its tool charged. Every
   * metered model message gets a row, so the `costUsd` values always sum to
   * `RunResult.costUsd`, and this is the one per-event source for a ledger
   * that must survive a crash. A model call that failed or was cut off before
   * writing any text arrives as an assistant row with no content (its `usage`
   * says what it billed): store it, or at least charge it.
   */
  onMessage?: (row: MessageRow, info: { costUsd: number; message: Message }) => void | Promise<void>;
  /**
   * Answers to calls an earlier run left pending. An approved call runs here
   * unless the gate now refuses it; a call already answered or missing from
   * the history is skipped. An approval whose `call.input` differs from the
   * call's arguments in the history does not run: the call is pending again,
   * carrying the arguments that would run.
   */
  resume?: readonly Resolution[];
  /**
   * Called and awaited just before a write tool runs, with the call. Persist
   * the call id here (as started) before resolving: a run that dies between
   * the tool's side effect and its stored result leaves the call unanswered,
   * and the next run must not do it again. If this throws, the tool does not
   * run and the model is told so.
   */
  onToolStart?: (call: ToolCallRequest) => void | Promise<void>;
  /**
   * Ids of write calls an earlier run started (see `onToolStart`) that have no
   * result in the history. Such a call never runs again, whatever the gate or
   * a resolution says: the model is told it may or may not have happened.
   */
  startedCalls?: Iterable<string>;
  /** The output token cap for a call, thinking included. Defaults to `DEFAULT_MAX_TOKENS` or the model's own cap. */
  maxTokens?: number;
  /**
   * Asks for budgeted extended thinking on a model that declares `reasoning`
   * (pi's catalog models such as claude-haiku-4-5). Off by default. Its
   * thinking budget comes out of the same affordable output cap, so it never
   * lifts a call past the ceiling. It has no effect on models built from the
   * price table (claude-sonnet-5-5, claude-opus-5-5): they reject a thinking
   * budget and think by default inside `max_tokens`. Resuming a turn that
   * thought before its tool call needs the stored rows to keep
   * `thinking_signature`.
   */
  reasoning?: ThinkingLevel;
  /** Prompt cache affinity, such as the conversation id. */
  sessionId?: string;
}

export interface RunResult {
  reason: StopReason;
  error?: string;
  /** New rows, in order: assistant messages and tool results. A pending call's result is not among them. */
  messages: MessageRow[];
  /** Calls waiting on the person when `reason` is `approval`. */
  pending: ToolCallRequest[];
  /** Dollars this run spent: each model message, plus what tools charged through `ctx.charge`. */
  costUsd: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The model id the run used. */
  model: string;
}

/** Room for an answer plus the thinking newer models do inside `max_tokens`. */
export const DEFAULT_MAX_TOKENS = 32_000;

/** A call that cannot afford this many output tokens is not made. */
export const MIN_OUTPUT_TOKENS = 1_024;

/**
 * Thinking tokens per reasoning level, pi-ai's defaults. The run passes them
 * to pi explicitly, so the budget it adds on top of the answer's cap is the
 * one the run planned for.
 */
export const THINKING_BUDGETS: Readonly<Record<"minimal" | "low" | "medium" | "high", number>> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
};

/** The longest deadline a timer can hold (2^31 - 1 ms, about 24.8 days); a longer one would fire at once. */
export const MAX_DEADLINE_MS = 2_147_483_647;

/** The smallest thinking budget the Anthropic API accepts. */
const MIN_THINKING_TOKENS = 1_024;

/** How one call spends its affordable output: the cap pi is given, and the thinking budget it adds on top. */
export interface OutputPlan {
  /** The answer's cap handed to pi, before pi adds `thinkingBudget`. */
  maxTokens: number;
  /** The reasoning level sent, or undefined when the call goes without budgeted thinking. */
  reasoning?: ThinkingLevel;
  /** Thinking tokens, added by pi on top of `maxTokens`. 0 without reasoning. */
  thinkingBudget: number;
  /** True when the money left cut the call below what it asked for. */
  clamped: boolean;
}

/**
 * Splits the output tokens the money left buys (`room`) between thinking
 * and the answer, so that what goes out (`maxTokens + thinkingBudget`) never
 * exceeds `room`. pi adds the thinking budget on top of the cap it is given
 * for any model that is not adaptive, so the cap is lowered by the budget
 * first. A level the room cannot fit with `MIN_OUTPUT_TOKENS` of answer is
 * shrunk, and dropped when under the API's minimum budget.
 */
export function planOutput(requested: number, room: number, reasoning?: ThinkingLevel): OutputPlan {
  const level = reasoning === "xhigh" ? "high" : reasoning;
  const wanted = level ? THINKING_BUDGETS[level] : 0;
  const total = Math.min(requested + wanted, room);
  const clamped = total < requested + wanted;
  const thinkingBudget = Math.min(wanted, total - MIN_OUTPUT_TOKENS);
  if (!level || thinkingBudget < MIN_THINKING_TOKENS) {
    return { maxTokens: Math.max(1, Math.min(requested, room)), thinkingBudget: 0, clamped };
  }
  return { maxTokens: total - thinkingBudget, reasoning: level, thinkingBudget, clamped };
}

function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n\n");
}

/** JSON with object keys sorted, so two values compare by content rather than key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function verdictOf(decision: GateDecision): { verdict: GateVerdict; reason?: string } {
  return typeof decision === "string" ? { verdict: decision } : decision;
}

function refusalText(name: string): string {
  return `The person has not allowed ${name}. It did not run. Do not try it again; tell them what you would have done.`;
}

function declineText(name: string, note?: string): string {
  return note
    ? `The person declined ${name}. It did not run. They said: ${note}`
    : `The person declined ${name}. It did not run.`;
}

function startedText(name: string): string {
  return `${name} started in an earlier run that stopped before it reported back, so it may or may not have happened. It was not run again. Check whether it took effect before trying it again.`;
}

const WAITING_TEXT = "Waiting for the person's approval.";
const CUT_OFF_TEXT = "This call was cut off before its arguments were complete, so it did not run.";

/**
 * Runs the assistant over a conversation: the pi-agent-core loop, with a gate
 * in front of every tool call, a meter on every model message, a cost ceiling
 * and a deadline. Never throws; every failure comes back as reason `error`.
 */
export async function runAssistant(options: RunAssistantOptions): Promise<RunResult> {
  const rows: MessageRow[] = [];
  const pending: ToolCallRequest[] = [];
  const pendingIds = new Set<string>();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let spent = 0;
  let modelId = typeof options.model === "string" ? options.model : options.model.id;

  const finish = (reason: StopReason, error?: string): RunResult => ({
    reason,
    ...(error ? { error } : {}),
    messages: rows,
    pending,
    costUsd: spent,
    usage,
    model: modelId,
  });

  let model: Model<Api>;
  try {
    model = typeof options.model === "string" ? resolveModel(options.model) : options.model;
  } catch (error) {
    return finish("error", error instanceof Error ? error.message : String(error));
  }
  modelId = model.id;
  if (!(options.ceilingUsd >= 0)) return finish("error", `ceilingUsd must be zero or more, got ${options.ceilingUsd}`);
  if (!(options.deadlineMs >= 0)) return finish("error", `deadlineMs must be zero or more, got ${options.deadlineMs}`);
  if (options.apiKeys && !options.apiKeys[model.provider]) {
    return finish("error", `No API key for provider "${model.provider}" in apiKeys`);
  }

  const tools = options.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // What tools spent outside the model calls, by call id: counted in `spent`
  // at once, so the next model call's room sees it, and reported on the
  // call's result row.
  const charged = new Map<string, number>();
  const charge = (usd: number, callId: string) => {
    if (!Number.isFinite(usd) || usd <= 0) return;
    spent += usd;
    charged.set(callId, (charged.get(callId) ?? 0) + usd);
  };
  const agentTools = tools.map((tool) => toAgentTool(tool, charge));
  const gate = options.gate ?? gateByRisk;
  const price = priceFor(model.id, model);
  const maxTokens = options.maxTokens ?? Math.min(model.maxTokens || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  // One controller carries both the caller's cancel and the deadline.
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const stopped = () => cancelled || timedOut;
  const onCancel = () => {
    cancelled = true;
    controller.abort();
  };
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel);
  const timer =
    options.deadlineMs === Number.POSITIVE_INFINITY
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.min(options.deadlineMs, MAX_DEADLINE_MS));

  const emitRow = async (message: Message, uuid: string, costUsd: number) => {
    const [row] = messagesToRows([{ ...message, rowKey: uuid } as RowMessage]);
    if (message.role === "assistant") row.api_message_id ??= uuid;
    rows.push(row);
    await options.onMessage?.(row, { costUsd, message });
  };

  try {
    if (cancelled) return finish("error", "The run was cancelled.");
    const messages: Message[] = rowsToMessages(options.history);

    const requestFor = (call: ToolCall): ToolCallRequest => ({
      id: call.id,
      name: call.name,
      input: call.arguments,
      risk: byName.get(call.name)?.risk ?? "write",
    });
    const started = new Set(options.startedCalls ?? []);
    // Records a write call as started before it runs; the text the model gets
    // instead when it was started before, or could not be recorded.
    const markStarted = async (call: ToolCallRequest): Promise<string | undefined> => {
      if (started.has(call.id)) return startedText(call.name);
      if (call.risk !== "write" || !options.onToolStart) return undefined;
      try {
        await options.onToolStart(call);
        return undefined;
      } catch (error) {
        return `${call.name} did not run: its start could not be recorded (${error instanceof Error ? error.message : String(error)}).`;
      }
    };
    const decide = async (call: ToolCallRequest): Promise<{ verdict: GateVerdict; reason?: string }> => {
      try {
        return verdictOf(await gate(call));
      } catch {
        return { verdict: "ask" };
      }
    };
    // Answers a call outside the loop: runs it, or answers it with an error text.
    const answer = async (call: ToolCall, errorText?: string) => {
      let result: AgentToolResult<unknown>;
      let isError = errorText !== undefined;
      const tool = byName.get(call.name);
      if (errorText !== undefined) {
        result = { content: [{ type: "text", text: errorText }], details: undefined };
      } else if (!tool) {
        result = { content: [{ type: "text", text: `${call.name} is no longer available, so it did not run.` }], details: undefined };
        isError = true;
      } else if (stopped()) {
        // Checked before markStarted, so a stopped run records no start either.
        result = { content: [{ type: "text", text: stoppedText(call.name) }], details: undefined };
        isError = true;
      } else {
        try {
          const args = validateToolArguments(toAgentTool(tool), call);
          const blocked = await markStarted(requestFor(call));
          if (blocked !== undefined) throw new Error(blocked);
          result = await runTool(tool, args, { callId: call.id, signal: controller.signal, charge: (usd) => charge(usd, call.id) });
        } catch (error) {
          result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined };
          isError = true;
        }
      }
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        details: result.details,
        isError,
        timestamp: Date.now(),
      };
      messages.push(message);
      await emitRow(message, newUuid(), charged.get(call.id) ?? 0);
    };

    // Answers to calls the last run left pending become their results. Only a
    // call the history holds and nothing has answered yet runs, with the
    // arguments the model wrote, so a repeated resume never acts twice. The
    // gate is asked again: an approval cannot override a refusal.
    const issued = new Map<string, ToolCall>();
    const answeredBefore = new Set<string>();
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const block of message.content) if (block.type === "toolCall") issued.set(block.id, block);
      } else if (message.role === "toolResult") {
        answeredBefore.add(message.toolCallId);
      }
    }
    for (const resolution of options.resume ?? []) {
      const call = issued.get(resolution.call.id);
      if (!call || answeredBefore.has(call.id)) continue;
      answeredBefore.add(call.id);
      if (started.has(call.id)) {
        await answer(call, startedText(call.name));
        continue;
      }
      // A tool that is gone cannot run, so no one is asked about it.
      if (!byName.has(call.name)) {
        await answer(call);
        continue;
      }
      if (resolution.decision === "decline") {
        await answer(call, declineText(call.name, resolution.note));
        continue;
      }
      // The person approved the arguments they were shown; what runs is the
      // call as the history holds it. If the two differ, the approval covers
      // something else, so the call waits on them again with what would run.
      if (!sameJson(resolution.call.input, call.arguments)) {
        pending.push(requestFor(call));
        pendingIds.add(call.id);
        continue;
      }
      const decision = await decide(requestFor(call));
      await answer(call, decision.verdict === "refuse" ? (decision.reason ?? refusalText(call.name)) : undefined);
    }

    // Calls of the model's last message that nothing has answered, with no word
    // from the person since. They come from a run that stopped for approval, or
    // one that died before it stored their results, so each goes through the
    // gate as the loop would: allowed calls run, refused ones are answered, and
    // the rest wait on the person, without a model call.
    // A plain loop, not findLastIndex: the package targets ES2021, the lib codecast's convex program loads it with.
    let lastAssistant = messages.length - 1;
    while (lastAssistant >= 0 && messages[lastAssistant].role !== "assistant") lastAssistant--;
    const after = messages.slice(lastAssistant + 1);
    // A `tool` row's text reads as a user message, but it is tool output, not the person.
    const fromPerson = (message: Message) => message.role === "user" && (message as RowMessage).rowOrigin?.role !== "tool";
    if (lastAssistant >= 0 && !after.some(fromPerson)) {
      const answered = new Set(after.map((message) => (message as ToolResultMessage).toolCallId));
      for (const block of (messages[lastAssistant] as AssistantMessage).content) {
        if (block.type !== "toolCall" || answered.has(block.id) || pendingIds.has(block.id)) continue;
        if (started.has(block.id)) {
          await answer(block, startedText(block.name));
          continue;
        }
        if (!byName.has(block.name)) {
          await answer(block);
          continue;
        }
        const request = requestFor(block);
        const decision = await decide(request);
        if (decision.verdict === "ask") pending.push(request);
        else await answer(block, decision.verdict === "refuse" ? (decision.reason ?? refusalText(block.name)) : undefined);
      }
    }
    if (cancelled) return finish("error", "The run was cancelled.");
    if (timedOut) return finish("time");
    if (pending.length > 0) return finish("approval");

    const last = messages[messages.length - 1];
    if (!last) return finish("error", "There is no message to answer.");
    // A history ending on the model's own finished message has nothing to answer.
    if (last.role === "assistant") return finish("done");

    // Outside content reaches the model wrapped as untrusted; the system prompt says what that means.
    const wrapsOutside = tools.some((tool) => tool.source !== undefined) || options.history.some((row) => row.role === "tool");
    const system = wrapsOutside && !options.system.includes(UNTRUSTED_GUIDANCE) ? `${options.system}\n\n${UNTRUSTED_GUIDANCE}` : options.system;
    const llmContext = (history: readonly Message[]): Context => ({
      systemPrompt: system,
      messages: prepareContext(history),
      tools: agentTools,
    });
    const outputRoom = (context: Context) =>
      affordableOutputTokens(options.ceilingUsd - spent, projectInputCost(context, price), price);

    if (outputRoom(llmContext(messages)) < MIN_OUTPUT_TOKENS) return finish("budget");

    let budgetStop = false;
    let clamped = false;
    let lastError: string | undefined;
    let currentUuid = newUuid();

    // Every model call goes out with an output cap, thinking included, that the money left can pay for.
    const streamFn: StreamFn = (callModel, context, streamOptions) => {
      const plan = planOutput(
        streamOptions?.maxTokens ?? maxTokens,
        outputRoom(context),
        callModel.reasoning ? streamOptions?.reasoning : undefined,
      );
      clamped = plan.clamped;
      const sent: SimpleStreamOptions = { ...streamOptions, maxTokens: plan.maxTokens, reasoning: plan.reasoning };
      if (plan.reasoning) {
        const budget = plan.thinkingBudget;
        sent.thinkingBudgets = { minimal: budget, low: budget, medium: budget, high: budget };
      }
      return streamModel(callModel, context, sent);
    };

    const config: AgentLoopConfig = {
      model,
      maxTokens,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      convertToLlm: (history) => prepareContext(history as Message[]),
      getApiKey: (provider) => options.apiKeys?.[provider],
      toolExecution: "parallel",
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        if (assistantMessage.stopReason === "length") return { block: true, reason: CUT_OFF_TEXT };
        // The gate and the person see the arguments as the history stores them,
        // not pi's coerced copy, so an approval matches on resume. Coercion
        // happens once, when the call runs.
        // pi prepares every call of a message before it runs any and never
        // reads the signal itself, so a stop during a gate's decision must
        // block here; runTool checks again when the call executes.
        if (stopped()) return { block: true, reason: stoppedText(toolCall.name) };
        const call = requestFor(toolCall);
        const decision = await decide(call);
        if (stopped()) return { block: true, reason: stoppedText(call.name) };
        if (decision.verdict === "allow") {
          const blocked = await markStarted(call);
          return blocked === undefined ? undefined : { block: true, reason: blocked };
        }
        if (decision.verdict === "refuse") return { block: true, reason: decision.reason ?? refusalText(call.name) };
        pending.push(call);
        pendingIds.add(call.id);
        return { block: true, reason: WAITING_TEXT };
      },
      shouldStopAfterTurn: ({ message, context }) => {
        if (pending.length > 0 || stopped() || budgetStop) return true;
        const continues = (message as AssistantMessage).content.some((block) => block.type === "toolCall");
        if (!continues) return false;
        if (outputRoom(llmContext(context.messages as Message[])) < MIN_OUTPUT_TOKENS) budgetStop = true;
        return budgetStop;
      },
    };

    const emit = async (event: AgentEvent) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        currentUuid = newUuid();
        return;
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        await options.onText?.(textOf(event.message as AssistantMessage), {
          messageUuid: currentUuid,
          delta: event.assistantMessageEvent.delta,
        });
        return;
      }
      if (event.type !== "message_end") return;
      const message = event.message as Message;
      if (message.role === "assistant") {
        // A cut-off message is billed for what streamed, and its row says so.
        const cost = messageCost(message, model);
        const billed = message.usage ? billedUsage(message) : undefined;
        spent += cost;
        usage.input += billed?.input ?? 0;
        usage.output += billed?.output ?? 0;
        usage.cacheRead += billed?.cacheRead ?? 0;
        usage.cacheWrite += billed?.cacheWrite ?? 0;
        // An answer cut short by the cap the money left set is a budget stop, not a finished answer.
        if (message.stopReason === "length" && clamped) budgetStop = true;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        if (failed) lastError = message.errorMessage ?? "The model call failed.";
        // A failed message's tool calls may be half written and never ran; keep
        // only its text. Its row is emitted even when nothing is left, so the
        // rows' costs always sum to the run's model spend; an empty assistant
        // row never reaches the model (prepareContext drops it).
        const kept = failed
          ? { ...message, usage: billed ?? message.usage, content: message.content.filter((block) => block.type === "text") }
          : message;
        await emitRow(kept, currentUuid, cost);
        return;
      }
      if (message.role === "toolResult" && !pendingIds.has(message.toolCallId)) {
        await emitRow(message, newUuid(), charged.get(message.toolCallId) ?? 0);
      }
    };

    await runAgentLoopContinue(
      { systemPrompt: system, messages, tools: agentTools },
      config,
      emit,
      controller.signal,
      streamFn,
    );

    if (cancelled) return finish("error", "The run was cancelled.");
    if (timedOut) return finish("time");
    if (pending.length > 0) return finish("approval");
    if (budgetStop) return finish("budget");
    if (lastError) return finish("error", lastError);
    return finish("done");
  } catch (error) {
    if (cancelled) return finish("error", "The run was cancelled.");
    if (timedOut) return finish("time");
    return finish("error", error instanceof Error ? error.message : String(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}
