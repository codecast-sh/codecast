import type { ClaudeMessage } from "./parser";

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  timestamp: number;
}

export function extractToolCalls(messages: ClaudeMessage[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const pendingCalls: Map<string, ToolCall> = new Map();

  for (const msg of messages) {
    if (msg.type === "tool_use" && msg.name) {
      const call: ToolCall = {
        name: msg.name,
        input: msg.input || {},
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      };
      if (msg.tool_use_id) {
        pendingCalls.set(msg.tool_use_id, call);
      }
      toolCalls.push(call);
    }
    if (msg.type === "tool_result" && msg.tool_use_id) {
      const pending = pendingCalls.get(msg.tool_use_id);
      if (pending) {
        pending.output =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
      }
    }
  }
  return toolCalls;
}
