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

/** Declares a tool. The identity function, there so `args` is typed from `parameters`. */
export function defineTool<P extends TSchema>(tool: Tool<P>): Tool<P> {
  return tool;
}

/**
 * Runs a tool and shapes its output as pi's tool result, its text wrapped as
 * untrusted when the tool declares a `source`. Throws when the tool throws.
 */
export async function runTool(tool: Tool, args: unknown, ctx: ToolContext): Promise<AgentToolResult<unknown>> {
  const output = await tool.run(args as Static<TSchema>, ctx);
  const raw = typeof output === "string" ? output : output.content;
  const content: ToolContent[] = typeof raw === "string" ? [{ type: "text", text: raw }] : raw;
  const source = tool.source;
  return {
    content: source === undefined ? content : content.map((block) => (block.type === "text" ? { ...block, text: untrusted(source, block.text) } : block)),
    details: typeof output === "string" ? undefined : output.details,
  };
}

/** The pi-agent-core view of a tool, which the loop validates and executes. */
export function toAgentTool(tool: Tool): AgentTool {
  return {
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: (callId, params, signal) => runTool(tool, params, { callId, signal }),
  };
}
