import { ClaudeMessage, CodexMessage } from "./parser";

export interface ExtractedMessage {
  role: "human" | "assistant" | "tool_use" | "tool_result";
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  timestamp: number;
}

export function extractFromClaude(msg: ClaudeMessage): ExtractedMessage {
  const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();

  if (msg.type === "human") {
    return { role: "human", content: msg.message || "", timestamp };
  }
  if (msg.type === "assistant") {
    return { role: "assistant", content: msg.message || "", timestamp };
  }
  if (msg.type === "tool_use") {
    return {
      role: "tool_use",
      content: "",
      timestamp,
      toolName: msg.name,
      toolInput: JSON.stringify(msg.input),
    };
  }
  if (msg.type === "tool_result") {
    return {
      role: "tool_result",
      content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      timestamp,
    };
  }
  return { role: "assistant", content: "", timestamp };
}

export function extractFromCodex(msg: CodexMessage): ExtractedMessage {
  return {
    role: msg.role === "user" ? "human" : "assistant",
    content: msg.content,
    timestamp: Date.now(),
  };
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
