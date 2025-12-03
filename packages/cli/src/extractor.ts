import { ClaudeMessage, CodexMessage } from "./parser";

export interface ExtractedMessage {
  role: "human" | "assistant" | "tool_use" | "tool_result";
  content: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
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
