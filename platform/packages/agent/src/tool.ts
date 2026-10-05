import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@mariozechner/pi-ai";
import { untrusted, type UntrustedSource } from "./untrusted";

/**
 * How much a tool can change. A `read` tool only looks (list mail, read a
 * calendar); a `write` tool acts in the world (send, create, delete). The gate
 * reads this to decide whether a call runs, waits for the person, or is refused.
 */
export type ToolRisk = "read" | "write";

/** What a running tool gets besides its arguments. */
export interface ToolContext {
  /**
   * The model's id for this call, the same id its result answers. A write
   * tool passes it to the outside service as its idempotency key wherever
   * the service takes one. The run's `onToolStart` and `startedCalls` keep a
   * started write from running twice; the key covers a crash after the
   * service accepted the call and before it answered.
   */
  callId: string;
  /** Aborts when the run is cancelled or passes its deadline. */
  signal?: AbortSignal;
  /**
   * Adds dollars the tool spent outside the run's model calls (a paid search,
   * a model call of its own) to the run's cost. The run counts it at once, so
   * `remainingUsd` here and in sibling calls sees it, checks it against
   * `ceilingUsd` before the next model call, and includes it in `costUsd`.
   * Calls run in parallel and the ceiling is only enforced before model
   * calls, so a paid tool reserves its estimate before it spends: check
   * `remainingUsd()`, charge the estimate, then charge the difference once the
   * real cost is known. A negative amount gives back part of what this call
   * charged, never more. Ignores amounts that are not finite.
   */
  charge(usd: number): void;
  /** Dollars the run has left under `ceilingUsd`, after everything charged so far, sibling calls included. Never negative. */
  remainingUsd(): number;
}

/**
 * What `runTool` takes: a `ToolContext` whose `charge` defaults to dropping
 * the amount and whose `remainingUsd` defaults to no limit.
 */
export type RunToolContext = Omit<ToolContext, "charge" | "remainingUsd"> & Partial<Pick<ToolContext, "charge" | "remainingUsd">>;

/** How a run meters its tools: what each call charges, by call id, and what is left. */
export interface ToolMeter {
  charge(usd: number, callId: string): void;
  remainingUsd(): number;
}

/** A block a tool may hand back: text, or an image the model can look at. */
export type ToolContent = TextContent | ImageContent;

/**
 * What `run` returns: plain text, or content blocks with optional `details`
 * (structured data for logs or the UI that the model never sees). A failure
 * is a thrown error; the loop turns it into an error result for the model.
 */
export type ToolOutput = string | { content: string | ToolContent[]; details?: unknown };

/** A tool the assistant can call. Build one with `defineTool`. */
export interface Tool<P extends TSchema = TSchema> {
  /** The name the model calls it by. Letters, digits, `_` and `-`. */
  name: string;
  /** What it does and when to use it, written for the model. */
  description: string;
  /** Its arguments as a typebox schema (`Type` is re-exported here). */
  parameters: P;
  risk: ToolRisk;
  /**
   * Where the content this tool returns comes from, for a tool that fetches
   * outside content (mail, web, calendar). Every tool that does must set it:
   * the harness then wraps each text block it returns with `untrusted(source,
   * ...)`, and adds `UNTRUSTED_GUIDANCE` to the system prompt. Such a tool
   * returns raw text and does not wrap it itself.
   */
  source?: UntrustedSource;
  /** A short human label for UI; defaults to the name. */
  label?: string;
  run(args: Static<P>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/** What the model gets for a call the run did not start because it was cancelled or passed its deadline. */
export function stoppedText(name: string): string {
  return `${name} did not run: the run stopped before it could.`;
}

/** Declares a tool. The identity function, there so `args` is typed from `parameters`. */
export function defineTool<P extends TSchema>(tool: Tool<P>): Tool<P> {
  return tool;
}

/**
 * Runs a tool and shapes its output as pi's tool result, its text wrapped as
 * untrusted when the tool declares a `source`. Throws when the tool throws;
 * a sourced tool's error message is wrapped too, since fetch and mail clients
 * put the page body or the subject in their errors. A call whose signal has
 * already aborted throws `stoppedText` without starting: an outside service
 * may ignore the signal, so a stopped run starts nothing.
 */
export async function runTool(tool: Tool, args: unknown, ctx: RunToolContext): Promise<AgentToolResult<unknown>> {
  if (ctx.signal?.aborted) throw new Error(stoppedText(tool.name));
  const source = tool.source;
  let output: ToolOutput;
  try {
    output = await tool.run(args as Static<TSchema>, {
      ...ctx,
      charge: ctx.charge ?? (() => {}),
      remainingUsd: ctx.remainingUsd ?? (() => Number.POSITIVE_INFINITY),
    });
  } catch (error) {
    if (source === undefined) throw error;
    throw new Error(untrusted(source, error instanceof Error ? error.message : String(error), { label: `${tool.name} failed` }));
  }
  const raw = typeof output === "string" ? output : output.content;
  const content: ToolContent[] = typeof raw === "string" ? [{ type: "text", text: raw }] : raw;
  return {
    content: source === undefined ? content : content.map((block) => (block.type === "text" ? { ...block, text: untrusted(source, block.text) } : block)),
    details: typeof output === "string" ? undefined : output.details,
  };
}

/**
 * The pi-agent-core view of a tool, which the loop validates and executes.
 * `meter` receives what the tool spends, with the call's id, and tells it what is left.
 */
export function toAgentTool(tool: Tool, meter?: ToolMeter): AgentTool {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (callId, params, signal) => runTool(tool, params, meteredContext(callId, signal, meter)),
  };
}

/** The context a metered call runs with: `meter`'s charge bound to the call's id. */
export function meteredContext(callId: string, signal: AbortSignal | undefined, meter?: ToolMeter): RunToolContext {
  return meter
    ? { callId, signal, charge: (usd) => meter.charge(usd, callId), remainingUsd: meter.remainingUsd }
    : { callId, signal };
}
