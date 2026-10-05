import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@mariozechner/pi-ai";

/**
 * How much a tool can change. A `read` tool only looks (list mail, read a
 * calendar); a `write` tool acts in the world (send, create, delete). The gate
 * reads this to decide whether a call runs, waits for the person, or is refused.
 */
export type ToolRisk = "read" | "write";

/** What a running tool gets besides its arguments. */
export interface ToolContext {
  /** The model's id for this call, the same id its result answers. */
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
  /** A short human label for UI; defaults to the name. */
  label?: string;
  run(args: Static<P>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/** Declares a tool. The identity function, there so `args` is typed from `parameters`. */
export function defineTool<P extends TSchema>(tool: Tool<P>): Tool<P> {
  return tool;
}

/** Runs a tool and shapes its output as pi's tool result. Throws when the tool throws. */
export async function runTool(tool: Tool, args: unknown, ctx: ToolContext): Promise<AgentToolResult<unknown>> {
  const output = await tool.run(args as Static<TSchema>, ctx);
  if (typeof output === "string") return { content: [{ type: "text", text: output }], details: undefined };
  const content = typeof output.content === "string" ? [{ type: "text" as const, text: output.content }] : output.content;
  return { content, details: output.details };
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
