type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: string; media_type: string; data: string } };

export interface ClaudeSessionEntry {
  type: "user" | "assistant" | "human" | "summary" | "file-history-snapshot" | "system" | "queue-operation";
  subtype?: "local_command" | "stop_hook_summary" | "compact_boundary";
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  slug?: string;
  timestamp?: string;
  content?: string;
  cwd?: string;
  message?: string | {
    role: "user" | "assistant";
    content: string | ContentBlock[];
    model?: string;
    stop_reason?: string | null;
  };
  summary?: string;
  operation?: "enqueue" | "remove";
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
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
  toolUseId?: string;
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
  stopReason?: string;
}

export function parseSessionLine(line: string): ClaudeSessionEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as ClaudeSessionEntry;
  } catch (err) {
    const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
    console.warn(`[parser] Failed to parse session line: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`[parser] Line content: ${preview}`);
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

    if (entry.type === "queue-operation" && entry.operation === "enqueue" && entry.content) {
      messages.push({
        uuid: entry.uuid,
        role: "user",
        content: entry.content,
        timestamp,
      });
      continue;
    }

    if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) continue;

    // Handle old format: type is "human" instead of "user"
    const normalizedType = entry.type === "human" ? "user" : entry.type;
    if (normalizedType !== "user" && normalizedType !== "assistant") continue;
    if (!entry.message) continue;

    let role: "user" | "assistant";
    let textContent = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    const images: ImageBlock[] = [];

    // Handle old format: message is a string directly
    if (typeof entry.message === "string") {
      role = normalizedType;
      textContent = entry.message;
    } else {
      // New format: message is an object with role and content
      role = entry.message.role;
      const content = entry.message.content;

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
              const contentArray = block.content as Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
              toolResultContent = contentArray
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("");
              for (const item of contentArray) {
                if (item.type === "image" && item.source) {
                  images.push({
                    mediaType: item.source.media_type,
                    data: item.source.data,
                    toolUseId: block.tool_use_id,
                  });
                }
              }
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
    }

    if (textContent || thinking || toolCalls.length > 0 || toolResults.length > 0 || images.length > 0) {
      const stopReason = typeof entry.message === "object" && entry.message.stop_reason
        ? entry.message.stop_reason
        : undefined;
      messages.push({
        uuid: entry.uuid,
        role,
        content: textContent,
        timestamp,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        images: images.length > 0 ? images : undefined,
        stopReason,
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
    if (entry?.type === "user") {
      return entry.parentUuid || undefined;
    }
  }
  return undefined;
}

export function extractSummaryTitle(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.type === "summary" && entry?.summary) {
      return entry.summary;
    }
  }
  return undefined;
}

export function extractCwd(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.cwd) {
      return entry.cwd;
    }
  }
  return undefined;
}

export function detectCliFlags(content: string): string | null {
  const flags: string[] = [];
  const firstUserLine = content.split("\n").find(l => l.includes('"type":"user"'));
  if (firstUserLine) {
    try {
      const parsed = JSON.parse(firstUserLine);
      if (parsed.permissionMode === "bypassPermissions") {
        flags.push("--dangerously-skip-permissions");
      }
    } catch {}
  }
  if (content.includes("mcp__claude-in-chrome__") || content.includes('"claude-in-chrome"')) {
    flags.push("--chrome");
  }
  return flags.length > 0 ? flags.join(" ") : null;
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
  } catch (err) {
    const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
    console.warn(`[parser] Failed to parse line: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`[parser] Line content: ${preview}`);
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
  } catch (err) {
    const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
    console.warn(`[parser] Failed to parse codex line: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`[parser] Line content: ${preview}`);
    return null;
  }
}

export function parseCodexLines(content: string): CodexMessage[] {
  return content
    .split("\n")
    .map(parseCodexLine)
    .filter((m): m is CodexMessage => m !== null);
}

interface CodexSessionEntry {
  timestamp: string;
  type: "session_meta" | "response_item" | "event_msg" | "turn_context";
  payload: {
    id?: string;
    cwd?: string;
    type?: string;
    status?: string;
    role?: "developer" | "user" | "assistant" | "system";
    content?: Array<{
      type: string;
      text?: string;
      image_url?: string;
      image_data?: string;
      media_type?: string;
      url?: string;
    }> | string;
    summary?: Array<{ type: string; text?: string }> | string;
    name?: string;
    call_id?: string;
    arguments?: string;
    output?: Array<{
      type: string;
      text?: string;
      image_url?: string;
      image_data?: string;
      media_type?: string;
      url?: string;
    }> | string;
    input?: string;
  };
}

function sanitizeCodexText(content: string): string {
  return content
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/\n{3,}/g, "\n\n");
}

function parseCodexImageItem(item: {
  image_url?: string;
  image_data?: string;
  media_type?: string;
  url?: string;
}): ImageBlock | null {
  if (typeof item.image_data === "string" && typeof item.media_type === "string") {
    return {
      mediaType: item.media_type,
      data: item.image_data,
    };
  }

  const imageUrl = typeof item.image_url === "string"
    ? item.image_url
    : typeof item.url === "string"
      ? item.url
      : undefined;

  if (!imageUrl) return null;
  const match = imageUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;

  return {
    mediaType: match[1],
    data: match[2],
  };
}

function extractCodexTextAndImages(
  content: Array<{
    type: string;
    text?: string;
    image_url?: string;
    image_data?: string;
    media_type?: string;
    url?: string;
  }> | string | undefined,
): { text: string; images: ImageBlock[] } {
  if (typeof content === "string") {
    return { text: sanitizeCodexText(content), images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }

  const textParts: string[] = [];
  const images: ImageBlock[] = [];

  for (const item of content) {
    if (item.type === "input_text" || item.type === "output_text" || item.type === "text") {
      if (typeof item.text === "string" && item.text.length > 0) {
        textParts.push(item.text);
      }
      continue;
    }

    if (item.type === "input_image" || item.type === "output_image" || item.type === "image") {
      const parsedImage = parseCodexImageItem(item);
      if (parsedImage) {
        images.push(parsedImage);
      }
    }
  }

  return {
    text: sanitizeCodexText(textParts.join("\n")),
    images,
  };
}

export function parseCodexSessionFile(content: string): ParsedMessage[] {
  const lines = content.split("\n");
  const messages: ParsedMessage[] = [];
  let currentAssistantContent = "";
  let currentAssistantThinking = "";
  let currentToolCalls: ToolCall[] = [];
  let currentToolResults: ToolResult[] = [];
  let currentAssistantImages: ImageBlock[] = [];
  let lastTimestamp = Date.now();

  const flushAssistantMessage = () => {
    if (
      currentAssistantContent ||
      currentAssistantThinking ||
      currentToolCalls.length > 0 ||
      currentToolResults.length > 0 ||
      currentAssistantImages.length > 0
    ) {
      messages.push({
        role: "assistant",
        content: currentAssistantContent.trim(),
        timestamp: lastTimestamp,
        thinking: currentAssistantThinking.trim() || undefined,
        toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
        toolResults: currentToolResults.length > 0 ? [...currentToolResults] : undefined,
        images: currentAssistantImages.length > 0 ? [...currentAssistantImages] : undefined,
      });
      currentAssistantContent = "";
      currentAssistantThinking = "";
      currentToolCalls = [];
      currentToolResults = [];
      currentAssistantImages = [];
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: CodexSessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "response_item") continue;

    const payload = entry.payload;
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    lastTimestamp = timestamp;

    if (payload.type === "message") {
      const role = payload.role;
      if (role === "developer" || role === "system") continue;

      const { text, images } = extractCodexTextAndImages(payload.content);
      const trimmedText = text.trim();

      if (role === "user") {
        flushAssistantMessage();
        const isSystemContext =
          trimmedText.startsWith("<environment_context>") ||
          trimmedText.startsWith("<INSTRUCTIONS>") ||
          trimmedText.startsWith("# AGENTS.md instructions") ||
          trimmedText.startsWith("<permissions") ||
          trimmedText.startsWith("<collaboration_mode>") ||
          trimmedText.startsWith("<app-context>");
        if ((trimmedText || images.length > 0) && !isSystemContext) {
          messages.push({
            role: "user",
            content: trimmedText,
            timestamp,
            images: images.length > 0 ? images : undefined,
          });
        }
      } else if (role === "assistant") {
        if (trimmedText) {
          currentAssistantContent += (currentAssistantContent ? "\n" : "") + trimmedText;
        }
        if (images.length > 0) {
          currentAssistantImages.push(...images);
        }
      }
    } else if (payload.type === "reasoning") {
      const contentArray = Array.isArray(payload.content) ? payload.content : [];
      const summaryArray = Array.isArray(payload.summary) ? payload.summary : [];
      const thinkingText = contentArray.length > 0
        ? contentArray.map((c) => c.text || "").join("\n")
        : summaryArray.map((c) => c.text || "").join("\n");
      if (thinkingText) {
        currentAssistantThinking += (currentAssistantThinking ? "\n" : "") + thinkingText;
      }
    } else if (payload.type === "function_call") {
      let args: Record<string, unknown> = {};
      if (payload.arguments) {
        try {
          const parsed = JSON.parse(payload.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          } else if (typeof parsed === "string" && parsed.trim()) {
            args = { input: parsed };
          } else if (payload.arguments.trim()) {
            args = { input: payload.arguments };
          }
        } catch {
          if (payload.arguments.trim()) {
            args = { input: payload.arguments };
          }
        }
      }
      currentToolCalls.push({
        id: payload.call_id || "",
        name: payload.name || "",
        input: args,
      });
    } else if (payload.type === "function_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      currentToolResults.push({
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string"
          ? payload.output
          : outputParsed.text,
      });
      if (outputParsed.images.length > 0) {
        currentAssistantImages.push(
          ...outputParsed.images.map((img) => ({
            mediaType: img.mediaType,
            data: img.data,
            toolUseId: payload.call_id || undefined,
          })),
        );
      }
    } else if (payload.type === "custom_tool_call") {
      currentToolCalls.push({
        id: payload.call_id || "",
        name: payload.name || "",
        input: payload.input ? { input: payload.input } : {},
      });
    } else if (payload.type === "custom_tool_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      currentToolResults.push({
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string"
          ? payload.output
          : outputParsed.text,
      });
      if (outputParsed.images.length > 0) {
        currentAssistantImages.push(
          ...outputParsed.images.map((img) => ({
            mediaType: img.mediaType,
            data: img.data,
            toolUseId: payload.call_id || undefined,
          })),
        );
      }
    }
  }

  flushAssistantMessage();
  return messages;
}

export function extractCodexCwd(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload?.cwd) {
        return entry.payload.cwd;
      }
    } catch {}
  }
  return undefined;
}

export function extractCodexSessionId(content: string): string | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload?.id) {
        return entry.payload.id;
      }
    } catch {}
  }
  return undefined;
}

export interface CursorPrompt {
  id: string;
  timestamp: number;
  text: string;
  role: "user" | "assistant";
}

function parseTimestamp(value: unknown): number {
  if (!value) return Date.now();

  // If it's a number, could be Unix seconds or milliseconds
  if (typeof value === "number") {
    // Unix timestamps in seconds are ~10 digits, milliseconds are ~13
    if (value < 10000000000) {
      return value * 1000; // Convert seconds to ms
    }
    return value;
  }

  // If it's a string, try parsing
  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    if (!isNaN(parsed)) {
      return parsed;
    }
    // Try parsing as number string
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      return num < 10000000000 ? num * 1000 : num;
    }
  }

  return Date.now();
}

export function parseCursorPrompts(dbValue: string): ParsedMessage[] {
  try {
    const data = JSON.parse(dbValue);
    const messages: ParsedMessage[] = [];

    if (!Array.isArray(data)) {
      return messages;
    }

    for (const item of data) {
      if (!item || typeof item !== "object") continue;

      const timestamp = parseTimestamp(item.timestamp || item.createdAt || item.created_at);

      const role = item.role === "user" ? "user" : "assistant";
      const content = typeof item.text === "string" ? item.text : "";

      if (content) {
        messages.push({
          role,
          content,
          timestamp,
        });
      }
    }

    return messages;
  } catch {
    return [];
  }
}

export function parseCursorTranscriptFile(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const lines = content.split("\n");
  let currentRole: "user" | "assistant" | "system" | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentRole) {
      buffer = [];
      return;
    }
    const raw = buffer.join("\n").trim();
    buffer = [];
    if (!raw) {
      return;
    }

    let contentText = raw;
    let thinking: string | undefined;

    if (currentRole === "user") {
      const match = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
      if (match) {
        contentText = match[1].trim();
      }
    }

    if (currentRole === "assistant") {
      const thinkMatches = raw.match(/<think>([\s\S]*?)<\/think>/gi);
      if (thinkMatches) {
        const extracted = thinkMatches
          .map((m) => m.replace(/<\/?think>/gi, "").trim())
          .filter(Boolean)
          .join("\n");
        thinking = extracted || undefined;
        contentText = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      }
    }

    if (!contentText) {
      return;
    }

    messages.push({
      role: currentRole,
      content: contentText,
      thinking,
      timestamp: Date.now(),
    });
  };

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed === "user:" || trimmed === "assistant:" || trimmed === "system:") {
      flush();
      currentRole = trimmed.slice(0, -1) as "user" | "assistant" | "system";
      continue;
    }
    buffer.push(line);
  }

  flush();
  return messages;
}

interface GeminiSessionMessage {
  id: string;
  timestamp: string;
  type: "user" | "gemini" | "info";
  content: Array<{ text: string }> | string;
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>;
  tokens?: { input: number; output: number; cached: number; thoughts: number; tool: number; total: number };
  model?: string;
}

interface GeminiSessionFile {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiSessionMessage[];
}

export function parseGeminiSessionFile(content: string): ParsedMessage[] {
  let session: GeminiSessionFile;
  try {
    session = JSON.parse(content);
  } catch {
    return [];
  }

  if (!session.messages || !Array.isArray(session.messages)) {
    return [];
  }

  const messages: ParsedMessage[] = [];

  for (const msg of session.messages) {
    if (msg.type === "info") continue;

    const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    let role: "user" | "assistant";
    let textContent = "";

    if (msg.type === "user") {
      role = "user";
      if (Array.isArray(msg.content)) {
        textContent = msg.content.map((c) => c.text).join("\n");
      } else if (typeof msg.content === "string") {
        textContent = msg.content;
      }
    } else if (msg.type === "gemini") {
      role = "assistant";
      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        textContent = msg.content.map((c) => c.text).join("\n");
      }
    } else {
      continue;
    }

    let thinking: string | undefined;
    if (msg.thoughts && msg.thoughts.length > 0) {
      thinking = msg.thoughts
        .map((t) => (t.subject ? `${t.subject}: ${t.description}` : t.description))
        .join("\n\n");
    }

    if (textContent || thinking) {
      messages.push({
        uuid: msg.id,
        role,
        content: textContent,
        timestamp,
        thinking: thinking || undefined,
      });
    }
  }

  return messages;
}

export function extractGeminiSessionId(content: string): string | undefined {
  try {
    const session = JSON.parse(content);
    return session.sessionId;
  } catch {
    return undefined;
  }
}

export function extractGeminiProjectHash(content: string): string | undefined {
  try {
    const session = JSON.parse(content);
    return session.projectHash;
  } catch {
    return undefined;
  }
}

export function extractGeminiStartTime(content: string): number | undefined {
  try {
    const session = JSON.parse(content);
    if (session.startTime) {
      return new Date(session.startTime).getTime();
    }
  } catch {}
  return undefined;
}
