type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: string; media_type: string; data: string } };

export interface ClaudeSessionEntry {
  type: "user" | "assistant" | "summary" | "file-history-snapshot" | "system";
  subtype?: "local_command" | "stop_hook_summary" | "compact_boundary";
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  content?: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
    model?: string;
  };
  summary?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImageBlock {
  mediaType: string;
  data: string;
}

export interface ParsedMessage {
  uuid?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageBlock[];
  subtype?: string;
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
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

    if (entry.type === "system") {
      if (entry.content && entry.subtype) {
        messages.push({
          uuid: entry.uuid,
          role: "system",
          content: entry.content,
          timestamp,
          subtype: entry.subtype,
        });
      }
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message) continue;

    const role = entry.message.role;
    const content = entry.message.content;

    let textContent = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const images: ImageBlock[] = [];

    if (typeof content === "string") {
      textContent = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "thinking") {
          thinking += block.thinking;
        } else if (block.type === "tool_use") {
          toolCalls.push({ id: block.id, name: block.name, input: block.input });
        } else if (block.type === "tool_result") {
          let toolResultContent = block.content;
          if (Array.isArray(block.content)) {
            toolResultContent = (block.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("");
          }
          toolResults.push({
            toolUseId: block.tool_use_id,
            content: toolResultContent,
            isError: block.is_error,
          });
        } else if (block.type === "image") {
          images.push({
            mediaType: block.source.media_type,
            data: block.source.data,
          });
        }
      }
    }

    if (textContent || thinking || toolCalls.length > 0 || toolResults.length > 0 || images.length > 0) {
      messages.push({
        uuid: entry.uuid,
        role,
        content: textContent,
        timestamp,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        images: images.length > 0 ? images : undefined,
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

export function extractParentUuid(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.parentUuid) {
      return entry.parentUuid;
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
