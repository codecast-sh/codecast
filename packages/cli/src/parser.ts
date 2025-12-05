type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ClaudeSessionEntry {
  type: "user" | "assistant" | "summary" | "file-history-snapshot";
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
    model?: string;
  };
  summary?: string;
}

export interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

export function parseSessionLine(line: string): ClaudeSessionEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ClaudeSessionEntry;
  } catch {
    return null;
  }
}

export function extractMessages(entries: ClaudeSessionEntry[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message) continue;

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    const role = entry.message.role;
    const content = entry.message.content;

    let textContent = "";
    const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

    if (typeof content === "string") {
      textContent = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input });
        }
      }
    }

    if (textContent || toolCalls.length > 0) {
      messages.push({
        role,
        content: textContent,
        timestamp,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }

  return messages;
}

export function parseSessionFile(content: string): ParsedMessage[] {
  const lines = content.split("\n");
  const entries = lines
    .map(parseSessionLine)
    .filter((e): e is ClaudeSessionEntry => e !== null);
  return extractMessages(entries);
}

export function extractSlug(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.slug) {
      return entry.slug;
    }
  }
  return undefined;
}

export interface ClaudeMessage {
  type: "human" | "assistant" | "tool_use" | "tool_result";
  message?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  timestamp?: string;
}

export function parseLine(line: string): ClaudeMessage | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ClaudeMessage;
  } catch {
    return null;
  }
}

export function parseLines(content: string): ClaudeMessage[] {
  return content
    .split("\n")
    .map(parseLine)
    .filter((m): m is ClaudeMessage => m !== null);
}

export interface CodexMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function parseCodexLine(line: string): CodexMessage | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as CodexMessage;
  } catch {
    return null;
  }
}

export function parseCodexLines(content: string): CodexMessage[] {
  return content
    .split("\n")
    .map(parseCodexLine)
    .filter((m): m is CodexMessage => m !== null);
}
