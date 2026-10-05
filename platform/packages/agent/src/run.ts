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
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { messagesToRows, prepareContext, rowsToMessages, type MessageRow, type RowMessage } from "./history";
import { affordableOutputTokens, messageCost, priceFor, projectInputCost } from "./meter";
import { resolveModel } from "./models";
import { streamModel } from "./stream";
import { runTool, toAgentTool, type Tool, type ToolRisk } from "./tool";

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
  /** The most this run may spend, in dollars. */
  ceilingUsd: number;
  /** Wall time this run may take, in milliseconds from the call. */
  deadlineMs: number;
  /** API keys by provider (`{ anthropic: "sk-ant-..." }`). Without one, pi reads the provider's env variable. */
  apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Cancels the run; it stops with reason `error`. */
  signal?: AbortSignal;
  /**
   * The assistant message being written, as its full text so far. Each model
   * message has its own `messageUuid`, the same one its finished row carries,
   * so a caller can stream into one stored row and finish it in place.
   */
  onText?: (text: string, info: { messageUuid: string; delta: string }) => void | Promise<void>;
  /** Each finished row (an assistant message, a tool result), in order, with the dollars its model call cost. */
  onMessage?: (row: MessageRow, info: { costUsd: number; message: Message }) => void | Promise<void>;
  /** Answers to calls an earlier run left pending. Approved calls run here, without the gate. */
  resume?: readonly Resolution[];
  /** The output token cap for a call, thinking included. Defaults to `DEFAULT_MAX_TOKENS` or the model's own cap. */
  maxTokens?: number;
  /** Asks for extended thinking on models that support it. Off by default. */
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
  /** Dollars this run spent, summed per model message. */
  costUsd: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The model id the run used. */
  model: string;
}

/** Room for an answer plus the thinking newer models do inside `max_tokens`. */
export const DEFAULT_MAX_TOKENS = 32_000;

/** A call that cannot afford this many output tokens is not made. */
export const MIN_OUTPUT_TOKENS = 1_024;

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

  const tools = options.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const agentTools = tools.map(toAgentTool);
  const gate = options.gate ?? gateByRisk;
  const price = priceFor(model.id, model);
  const maxTokens = options.maxTokens ?? Math.min(model.maxTokens || DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);

  // One controller carries both the caller's cancel and the deadline.
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
    controller.abort();
  };
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, options.deadlineMs));

  const emitRow = async (message: Message, uuid: string, costUsd: number) => {
    const [row] = messagesToRows([{ ...message, rowKey: uuid } as RowMessage]);
    if (message.role === "assistant") row.api_message_id ??= uuid;
    rows.push(row);
    await options.onMessage?.(row, { costUsd, message });
  };

  try {
    if (cancelled) return finish("error", "The run was cancelled.");
    const messages: Message[] = rowsToMessages(options.history);

    // Answers to calls the last run left pending become their results. Only a
    // call the history holds and nothing has answered yet runs, with the
    // arguments the model wrote, so a repeated resume never acts twice.
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
      const issuedCall = issued.get(resolution.call.id);
      if (!issuedCall || answeredBefore.has(issuedCall.id)) continue;
      answeredBefore.add(issuedCall.id);
      const call: ToolCallRequest = { ...resolution.call, name: issuedCall.name, input: issuedCall.arguments };
      let result: AgentToolResult<unknown>;
      let isError = false;
      const tool = byName.get(call.name);
      if (resolution.decision === "decline") {
        result = { content: [{ type: "text", text: declineText(call.name, resolution.note) }], details: undefined };
        isError = true;
      } else if (!tool) {
        result = { content: [{ type: "text", text: `${call.name} is no longer available, so it did not run.` }], details: undefined };
        isError = true;
      } else {
        try {
          const args = validateToolArguments(toAgentTool(tool), issuedCall);
          result = await runTool(tool, args, { callId: call.id, signal: controller.signal });
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
      await emitRow(message, newUuid(), 0);
    }

    // Calls of the model's last message that nothing has answered yet, with no
    // word from the person since, still wait on the person: report them again
    // rather than let the model read them as failed.
    const last = messages[messages.length - 1];
    if (!last) return finish("error", "There is no message to answer.");
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    const after = messages.slice(lastAssistant + 1);
    if (lastAssistant >= 0 && !after.some((message) => message.role === "user")) {
      const answered = new Set(after.map((message) => (message as ToolResultMessage).toolCallId));
      for (const block of (messages[lastAssistant] as AssistantMessage).content) {
        if (block.type !== "toolCall" || answered.has(block.id)) continue;
        pending.push({ id: block.id, name: block.name, input: block.arguments, risk: byName.get(block.name)?.risk ?? "write" });
      }
      if (pending.length > 0) return finish("approval");
    }
    // A history ending on the model's own finished message has nothing to answer.
    if (last.role === "assistant") return finish("done");

    const llmContext = (history: readonly Message[]): Context => ({
      systemPrompt: options.system,
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

    // Every model call goes out with an output cap the money left can pay for.
    const streamFn: StreamFn = (callModel, context, streamOptions) => {
      const room = outputRoom(context);
      const cap = Math.min(streamOptions?.maxTokens ?? maxTokens, room);
      clamped = cap < (streamOptions?.maxTokens ?? maxTokens);
      return streamModel(callModel, context, { ...streamOptions, maxTokens: Math.max(1, cap) });
    };

    const config: AgentLoopConfig = {
      model,
      maxTokens,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      convertToLlm: (history) => prepareContext(history as Message[]),
      getApiKey: (provider) => options.apiKeys?.[provider],
      toolExecution: "parallel",
      beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
        if (assistantMessage.stopReason === "length") return { block: true, reason: CUT_OFF_TEXT };
        const tool = byName.get(toolCall.name);
        const call: ToolCallRequest = {
          id: toolCall.id,
          name: toolCall.name,
          input: (args ?? toolCall.arguments) as Record<string, unknown>,
          risk: tool?.risk ?? "write",
        };
        let decision: { verdict: GateVerdict; reason?: string };
        try {
          decision = verdictOf(await gate(call));
        } catch {
          decision = { verdict: "ask" };
        }
        if (decision.verdict === "allow") return undefined;
        if (decision.verdict === "refuse") return { block: true, reason: decision.reason ?? refusalText(call.name) };
        pending.push(call);
        pendingIds.add(call.id);
        return { block: true, reason: WAITING_TEXT };
      },
      shouldStopAfterTurn: ({ message, context }) => {
        if (pending.length > 0 || timedOut || cancelled) return true;
        const assistant = message as AssistantMessage;
        const continues = assistant.content.some((block) => block.type === "toolCall");
        if (!continues) return false;
        if (assistant.stopReason === "length" && clamped) budgetStop = true;
        else if (outputRoom(llmContext(context.messages as Message[])) < MIN_OUTPUT_TOKENS) budgetStop = true;
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
        const cost = messageCost(message, model);
        spent += cost;
        usage.input += message.usage?.input ?? 0;
        usage.output += message.usage?.output ?? 0;
        usage.cacheRead += message.usage?.cacheRead ?? 0;
        usage.cacheWrite += message.usage?.cacheWrite ?? 0;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        if (failed) lastError = message.errorMessage ?? "The model call failed.";
        // A failed message's tool calls may be half written and never ran; keep only its text.
        const kept = failed ? { ...message, content: message.content.filter((block) => block.type === "text") } : message;
        if (kept.content.length > 0) await emitRow(kept, currentUuid, cost);
        return;
      }
      if (message.role === "toolResult" && !pendingIds.has(message.toolCallId)) {
        await emitRow(message, newUuid(), 0);
      }
    };

    await runAgentLoopContinue(
      { systemPrompt: options.system, messages, tools: agentTools },
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
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}
