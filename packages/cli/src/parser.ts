import type { AgentClientId } from "@codecast/shared/contracts";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "image"; source: { type: string; media_type: string; data: string } };

export interface ClaudeSessionEntry {
  type: "user" | "assistant" | "human" | "summary" | "file-history-snapshot" | "system" | "queue-operation" | "attachment";
  subtype?: "local_command" | "stop_hook_summary" | "compact_boundary";
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  // Agent-team stamps: Claude Code writes these on every line of a TEAMMATE
  // session's transcript (the lead's transcript is never stamped). teamName is
  // the team dir under ~/.claude/teams/; agentName is this member's name.
  teamName?: string;
  agentName?: string;
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
  // A message the user queues with Ctrl+Enter (or that codecast's daemon injects
  // while the agent is mid-turn) is written as type:"attachment" with this shape —
  // the prompt lives in `attachment.prompt`, NOT in `message.content`. A text-only
  // queued turn stores it as a bare string; a queued turn that also carries an image
  // stores it as a content-block array (same shape as message.content).
  attachment?: {
    type?: string;
    prompt?: string | ContentBlock[];
    commandMode?: string;
    origin?: { kind?: string };
  };
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
  model?: string;
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

// Synthetic truncation notice injected by jsonlGenerator on cross-agent/truncated
// imports. It exists for the model's context only — never show it to users.
// New imports mark it isMeta (skipped by the generic meta-skip below); this prefix
// guard also drops it from older JSONL files written before the flag existed.
export const CODECAST_IMPORT_NOTICE_PREFIX = "[Codecast import]";

// Queued prompts sometimes carry leading terminal control bytes (e.g. \x01\x0b,
// bracketed-paste markers) captured with the keystrokes. Strip a leading run of
// control chars — keeping tab/newline — so the synced content is clean and still
// content-matches its pending-message row on the server. Coerce defensively: a
// non-string slipping in here used to throw and wedge the WHOLE transcript's sync
// forever (one bad queued-command line froze the file at its byte offset), so this
// must never throw regardless of what shape the prompt field holds.
function stripControlPrefix(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/^[\x00-\x08\x0b-\x1f]+/, "");
}

export function extractMessages(entries: ClaudeSessionEntry[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // A slash command's expansion (the command's .md body) is flagged isMeta by Claude Code,
  // so the generic meta-skip below drops it. Keep it when it directly follows the command
  // invocation — the UI folds it into the command block as an expandable "Show command".
  let prevWasCommandInvocation = false;

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

    if (entry.type === "queue-operation") continue;

    // A user turn the agent received while busy is recorded as type:"attachment"
    // with attachment.type:"queued_command" (text in attachment.prompt) instead of a
    // normal type:"user" entry. Idle turns land as type:"user" and sync fine; queued
    // ones used to fall through the user/assistant skip below and get silently dropped
    // — losing real user prompts (e.g. anything sent with Ctrl+Enter). Emit them as
    // user messages. The server's addMessages dedups by uuid, then by content+timestamp,
    // then against the pending-message row, so a queued turn that ALSO arrived as a
    // normal echo (idle redelivery) never double-syncs.
    if (entry.type === "attachment") {
      if (entry.attachment?.type === "queued_command") {
        // A text-only queued turn stores prompt as a string; a queued turn with an
        // image stores it as a content-block array. Pull the text out and keep any
        // images so the synced turn matches what the user actually sent.
        const raw = entry.attachment.prompt;
        const promptImages: ImageBlock[] = [];
        let promptText = "";
        if (Array.isArray(raw)) {
          for (const block of raw) {
            if (block.type === "text") {
              promptText += block.text;
            } else if (block.type === "image" && block.source) {
              promptImages.push({ mediaType: block.source.media_type, data: block.source.data });
            }
          }
        } else {
          promptText = raw ?? "";
        }
        const prompt = stripControlPrefix(promptText);
        if (prompt.trim() || promptImages.length > 0) {
          messages.push({
            uuid: entry.uuid,
            role: "user",
            content: prompt,
            timestamp,
            images: promptImages.length > 0 ? promptImages : undefined,
          });
        }
      }
      continue;
    }

    const isUserEntry = entry.type === "user" || entry.type === "human";
    const isCommandExpansion = isUserEntry && entry.isMeta === true && prevWasCommandInvocation;
    if (!isCommandExpansion && (entry.isMeta || (entry.isVisibleInTranscriptOnly && !entry.isCompactSummary))) continue;

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
      // Use entry.type (normalizedType) as authoritative role, not message.role.
      // message.role can differ from entry.type for subagent instructions
      // (entry.type="assistant" but message.role="user" for instructions sent to subagents).
      role = normalizedType;
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

    const isImportNotice = role === "user" && textContent.trimStart().startsWith(CODECAST_IMPORT_NOTICE_PREFIX);

    if (!isImportNotice && (textContent || thinking || toolCalls.length > 0 || toolResults.length > 0 || images.length > 0)) {
      const stopReason = typeof entry.message === "object" && entry.message.stop_reason
        ? entry.message.stop_reason
        : undefined;
      // "<synthetic>" marks system-generated assistant entries (error banners,
      // interrupts) — not a real generation, so don't report a model for it.
      const rawModel = typeof entry.message === "object" ? entry.message.model : undefined;
      const model = rawModel && !rawModel.startsWith("<") ? rawModel : undefined;
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
        model,
      });
    }

    // Remember whether this was a slash-command invocation so the next entry (its isMeta
    // .md expansion) is kept rather than skipped.
    prevWasCommandInvocation =
      normalizedType === "user" && entry.isMeta !== true &&
      (textContent.trimStart().startsWith("<command-name>") || textContent.trimStart().startsWith("<command-message>"));
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

// Agent-team stamps from a TEAMMATE session's transcript (see
// ClaudeSessionEntry.teamName). Any stamped line identifies the session's team
// and member name; the lead's transcript carries no stamps, so undefined here
// means "not a teammate" (or the stamped lines haven't been written yet).
export function extractTeamInfo(content: string): { teamName: string; agentName: string } | undefined {
  const lines = content.split("\n");
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.teamName && entry?.agentName) {
      return { teamName: entry.teamName, agentName: entry.agentName };
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

function stableCodexHash(input: unknown): string {
  const text = JSON.stringify(input);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function codexItemUuid(entry: CodexSessionEntry, kind: string): string {
  const payload = entry.payload;
  if (payload.id) return `codex-${kind}-${payload.id}`;
  if (payload.call_id) return `codex-${kind}-${payload.call_id}`;
  return `codex-${kind}-${stableCodexHash({
    timestamp: entry.timestamp,
    type: payload.type,
    role: payload.role,
    name: payload.name,
    content: payload.content,
    summary: payload.summary,
    arguments: payload.arguments,
    output: payload.output,
    input: payload.input,
  })}`;
}

export function parseCodexSessionFile(content: string): ParsedMessage[] {
  const lines = content.split("\n");
  const messages: ParsedMessage[] = [];
  let pendingAssistantThinking = "";
  let pendingAssistantThinkingUuid: string | undefined;
  let lastTimestamp = Date.now();

  const takePendingThinking = () => {
    const thinking = pendingAssistantThinking.trim();
    const uuid = pendingAssistantThinkingUuid;
    pendingAssistantThinking = "";
    pendingAssistantThinkingUuid = undefined;
    return { thinking: thinking || undefined, uuid };
  };

  const pushAssistantMessage = (message: {
    uuid?: string;
    timestamp: number;
    content?: string;
    toolCalls?: ToolCall[];
    images?: ImageBlock[];
  }) => {
    const contentText = message.content?.trim() || "";
    const { thinking, uuid: thinkingUuid } = takePendingThinking();
    if (!contentText && !thinking && !(message.toolCalls && message.toolCalls.length > 0) && !(message.images && message.images.length > 0)) {
      return;
    }
    messages.push({
      uuid: message.uuid || thinkingUuid,
      role: "assistant",
      content: contentText,
      timestamp: message.timestamp,
      thinking,
      toolCalls: message.toolCalls && message.toolCalls.length > 0 ? message.toolCalls : undefined,
      images: message.images && message.images.length > 0 ? message.images : undefined,
    });
  };

  const pushToolResultMessage = (message: {
    uuid?: string;
    timestamp: number;
    toolUseId: string;
    content: string;
    isError?: boolean;
    images?: ImageBlock[];
  }) => {
    messages.push({
      uuid: message.uuid,
      role: "assistant",
      content: "",
      timestamp: message.timestamp,
      toolResults: [{
        toolUseId: message.toolUseId,
        content: message.content,
        isError: message.isError,
      }],
      images: message.images && message.images.length > 0 ? message.images : undefined,
    });
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
      const uuid = codexItemUuid(entry, "message");

      const { text, images } = extractCodexTextAndImages(payload.content);
      const trimmedText = text.trim();

      if (role === "user") {
        const isSystemContext =
          trimmedText.startsWith("<environment_context>") ||
          trimmedText.startsWith("<INSTRUCTIONS>") ||
          trimmedText.startsWith("# AGENTS.md instructions") ||
          trimmedText.startsWith("<permissions") ||
          trimmedText.startsWith("<collaboration_mode>") ||
          trimmedText.startsWith("<app-context>");
        if ((trimmedText || images.length > 0) && !isSystemContext) {
          messages.push({
            uuid,
            role: "user",
            content: trimmedText,
            timestamp,
            images: images.length > 0 ? images : undefined,
          });
        }
      } else if (role === "assistant") {
        pushAssistantMessage({
          uuid,
          timestamp,
          content: trimmedText,
          images,
        });
      }
    } else if (payload.type === "reasoning") {
      const contentArray = Array.isArray(payload.content) ? payload.content : [];
      const summaryArray = Array.isArray(payload.summary) ? payload.summary : [];
      const thinkingText = contentArray.length > 0
        ? contentArray.map((c) => c.text || "").join("\n")
        : summaryArray.map((c) => c.text || "").join("\n");
      if (thinkingText) {
        pendingAssistantThinking += (pendingAssistantThinking ? "\n" : "") + thinkingText;
        pendingAssistantThinkingUuid = pendingAssistantThinkingUuid || codexItemUuid(entry, "reasoning");
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
      pushAssistantMessage({
        uuid: codexItemUuid(entry, "function-call"),
        timestamp,
        toolCalls: [{
          id: payload.call_id || "",
          name: payload.name || "",
          input: args,
        }],
      });
    } else if (payload.type === "function_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      pushToolResultMessage({
        uuid: codexItemUuid(entry, "function-output"),
        timestamp,
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string"
          ? payload.output
          : outputParsed.text,
        images: outputParsed.images.map((img) => ({
          mediaType: img.mediaType,
          data: img.data,
          toolUseId: payload.call_id || undefined,
        })),
      });
    } else if (payload.type === "custom_tool_call") {
      pushAssistantMessage({
        uuid: codexItemUuid(entry, "custom-tool-call"),
        timestamp,
        toolCalls: [{
          id: payload.call_id || "",
          name: payload.name || "",
          input: payload.input ? { input: payload.input } : {},
        }],
      });
    } else if (payload.type === "custom_tool_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      pushToolResultMessage({
        uuid: codexItemUuid(entry, "custom-tool-output"),
        timestamp,
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string"
          ? payload.output
          : outputParsed.text,
        images: outputParsed.images.map((img) => ({
          mediaType: img.mediaType,
          data: img.data,
          toolUseId: payload.call_id || undefined,
        })),
      });
    }
  }

  const { thinking: trailingThinking, uuid: trailingThinkingUuid } = takePendingThinking();
  if (trailingThinking) {
    messages.push({
      uuid: trailingThinkingUuid,
      role: "assistant",
      content: "",
      timestamp: lastTimestamp,
      thinking: trailingThinking,
    });
  }
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

export interface CodexSessionMetadata {
  id?: string;
  parentThreadId?: string;
  originator?: string;
  source?: string | { subagent?: string; custom?: string };
}

export function extractCodexSessionMetadata(content: string): CodexSessionMetadata | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_meta") continue;
      return {
        id: entry.payload?.id,
        parentThreadId: entry.payload?.parent_thread_id,
        originator: entry.payload?.originator,
        source: entry.payload?.source,
      };
    } catch {}
  }
  return undefined;
}

export function isCompletedStandaloneCodexReview(
  metadata: CodexSessionMetadata | undefined,
  content: string,
): boolean {
  if (metadata?.originator !== "codex_exec" || metadata.source !== "exec") return false;

  let exitedReviewMode = false;
  let taskComplete = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "event_msg") continue;
      if (entry.payload?.type === "exited_review_mode") exitedReviewMode = true;
      if (entry.payload?.type === "task_complete") taskComplete = true;
    } catch {}
  }
  return exitedReviewMode && taskComplete;
}

export function isCompletedNativeCodexReviewChild(
  metadata: CodexSessionMetadata | undefined,
  content: string,
): boolean {
  if (
    metadata?.originator !== "codex_exec" ||
    typeof metadata.source !== "object" ||
    metadata.source.subagent !== "review"
  ) return false;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "event_msg" && entry.payload?.type === "task_complete") return true;
    } catch {}
  }
  return false;
}

// Codex Desktop forks a rollout on every resume/reopen: it writes a new file with a
// fresh UUID, copies the prior history forward, and stacks one more session_meta record
// at the top whose `forked_from_id` points at the parent. The whole ancestry is therefore
// embedded as the leading run of session_meta records (newest first), back to the original
// session that was forked from nothing. That original is the stable identity for the entire
// lineage — resolving to it lets the daemon collapse every resume/fork of one logical
// session into a single conversation instead of minting a duplicate per rollout file.
//
// Pass the leading session_meta block (see readCodexSessionMetaHead in the daemon); a file
// whose head was truncated still resolves consistently because every fork embeds the same
// ancestry. Returns the file's own id when there is no fork lineage, or undefined when no
// session_meta is present at all.
export function extractCodexForkRoot(content: string): string | undefined {
  const parent = new Map<string, string | undefined>();
  let ownId: string | undefined;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_meta") continue;
      const id: string | undefined = entry.payload?.id;
      if (!id) continue;
      if (!ownId) ownId = id; // the file's own session_meta is always first
      if (!parent.has(id)) parent.set(id, entry.payload?.forked_from_id ?? undefined);
    } catch {}
  }
  if (!ownId) return undefined;
  // Walk forked_from links to the deepest ancestor recorded in this file.
  let root = ownId;
  const seen = new Set<string>();
  while (parent.get(root) && !seen.has(root)) {
    seen.add(root);
    root = parent.get(root)!;
  }
  return root;
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

// ── OpenCode json-store parser ────────────────────────────────────────────────
// OpenCode stores a session across many small JSON files: session meta, one file
// per message, and one file per content "part" (keyed by MESSAGE id). The daemon's
// OpencodeStorageWatcher assembles that tree into a single JSON blob shaped exactly
// like `opencode export <id>` — { info, messages: [{ info, parts }] } — and feeds
// it here, so this parser reads a whole-session snapshot the same way the gemini
// parser reads a whole-session file. One ParsedMessage is emitted per opencode
// message: text parts become `content`, reasoning parts become `thinking`, and each
// tool part contributes both a toolCall (its input) and, once it has run, a
// toolResult (its output) — the shared renderer pairs the two by tool id across
// messages, so co-locating them on one message is fine.

interface OpencodePart {
  id?: string;
  type?: string;
  text?: string;
  // file parts (opencode's attachment/image mechanism): `url` is a data URL for
  // pasted/attached images, `mime` its media type. Remote/path urls carry no bytes.
  mime?: string;
  filename?: string;
  url?: string;
  // tool parts
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
  };
}

interface OpencodeMessageInfo {
  id?: string;
  role?: "user" | "assistant";
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
}

interface OpencodeAssembledSession {
  info?: { id?: string };
  messages?: { info?: OpencodeMessageInfo; parts?: OpencodePart[] }[];
}

/** Extract an ImageBlock from a base64 data URL (`data:<mime>;base64,<data>`).
 *  Returns null for non-data urls (a remote http/file path carries no inline
 *  bytes) or a non-image mime — matching the image-only `images` field every
 *  other client populates. */
function parseDataUrlImage(url: string | undefined, mime: string | undefined): ImageBlock | null {
  if (typeof url !== "string") return null;
  const match = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  const mediaType = mime || match[1];
  if (!mediaType.startsWith("image/")) return null;
  return { mediaType, data: match[2] };
}

/** Ordered content of one opencode message, folded from its parts. */
function foldOpencodeParts(parts: OpencodePart[]): {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  images: ImageBlock[];
} {
  // Part ids are monotonic within a message; sort by id so streaming/interleaved
  // writes read back in author order regardless of directory listing order.
  const ordered = [...parts].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const images: ImageBlock[] = [];

  for (const part of ordered) {
    if (part.type === "text") {
      if (part.text) textChunks.push(part.text);
    } else if (part.type === "reasoning") {
      if (part.text) thinkingChunks.push(part.text);
    } else if (part.type === "file") {
      // An attached image rides in `url` as a base64 data URL; map it to the same
      // ImageBlock shape every other client emits. Non-image files and remote/path
      // urls (no inline bytes) have nothing renderable, so they're skipped.
      const img = parseDataUrlImage(part.url, part.mime);
      if (img) images.push(img);
    } else if (part.type === "tool") {
      const id = part.callID || part.id || "";
      const input =
        part.state?.input && typeof part.state.input === "object"
          ? (part.state.input as Record<string, unknown>)
          : {};
      toolCalls.push({ id, name: part.tool || "", input });
      const status = part.state?.status;
      // A tool that has finished (or errored) carries its output; a still-running
      // tool has none yet — emit the call now, the result lands on a later sync.
      if (status === "completed" || status === "error") {
        toolResults.push({
          toolUseId: id,
          content: part.state?.output ?? part.state?.error ?? "",
          isError: status === "error" ? true : undefined,
        });
      }
    }
    // step-start / step-finish carry no user-visible content — skip.
  }

  return {
    content: textChunks.join("\n\n"),
    thinking: thinkingChunks.join("\n\n"),
    toolCalls,
    toolResults,
    images,
  };
}

/**
 * Parse an assembled opencode session snapshot (the `opencode export` shape) into
 * ParsedMessage[] — one message per opencode message, stable uuid = message id so
 * the daemon's upsert-by-uuid sync patches a message in place as its parts stream
 * in. System/tool-role and empty messages are dropped, matching the other parsers.
 */
export function parseOpencodeSessionFile(content: string): ParsedMessage[] {
  let session: OpencodeAssembledSession;
  try {
    session = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(session.messages)) return [];

  const messages: ParsedMessage[] = [];
  for (const entry of session.messages) {
    const info = entry.info ?? {};
    const role = info.role;
    if (role !== "user" && role !== "assistant") continue;

    const { content: text, thinking, toolCalls, toolResults, images } = foldOpencodeParts(entry.parts ?? []);
    const hasBody =
      text.trim().length > 0 || thinking.length > 0 || toolCalls.length > 0 || toolResults.length > 0 || images.length > 0;
    if (!hasBody) continue;

    messages.push({
      uuid: info.id,
      role,
      content: text,
      timestamp: info.time?.created ?? Date.now(),
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      images: images.length > 0 ? images : undefined,
      model: role === "assistant" ? info.modelID : undefined,
    });
  }

  return messages;
}

// ── pi (@mariozechner/pi-coding-agent) ──────────────────────────────────────
// pi stores each session as a JSONL TREE: the first line is a header
// ({type:"session",version,id,cwd}) and every line after it is an entry with an
// 8-char `id` and a `parentId`, so in-file branching (pi's /tree) can fork the
// conversation without opening a new file. The header is metadata, not part of the
// tree. On load, pi sets its leaf to the LAST non-session entry in file order
// (session-manager `_buildIndex`) and builds LLM context by walking parentId from
// that leaf back to the root — so the "active branch" is exactly the parentId chain
// ending at the final line. We reproduce that: resolve the active branch, then emit
// its entries as ParsedMessage[] in root->leaf order.
//
// FORK LINEAGE (deferred): codecast's transcript model is linear-per-conversation, so
// we render the ACTIVE branch only. Alternate in-file branches (other /tree paths)
// and cross-file forks (a header's `parentSession` pointer, written by /fork) are NOT
// yet mapped onto codecast fork lineage — that mapping is a later phase. This matches
// how the daemon already renders one linear path per conversation.
interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // toolCall
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  // image
  data?: string;
  mimeType?: string;
}

interface PiMessage {
  role: string; // "user" | "assistant" | "toolResult" (+ extended roles we skip)
  content?: string | PiContentBlock[];
  model?: string;
  stopReason?: string;
  // toolResult
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface PiEntry {
  type: string; // "session" | "message" | "model_change" | "thinking_level_change" | ...
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  // model_change
  modelId?: string;
  // session header
  cwd?: string;
}

// One pass over a pi message's content blocks — works for every role (user carries
// text+images, assistant adds thinking+toolCalls, toolResult carries text+images).
function extractPiBlocks(content: string | PiContentBlock[] | undefined): {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  images: ImageBlock[];
} {
  const out = { text: "", thinking: "", toolCalls: [] as ToolCall[], images: [] as ImageBlock[] };
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b.type === "text" && typeof b.text === "string") {
      out.text += b.text;
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      out.thinking += b.thinking;
    } else if (b.type === "toolCall") {
      out.toolCalls.push({ id: b.id ?? "", name: b.name ?? "", input: b.arguments ?? {} });
    } else if (b.type === "image" && typeof b.data === "string") {
      out.images.push({ mediaType: b.mimeType ?? "image/png", data: b.data });
    }
  }
  return out;
}

export function parsePiSessionFile(content: string): ParsedMessage[] {
  const entries: PiEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PiEntry);
    } catch {
      // partial/corrupt line (e.g. a mid-write tail) -> skip
    }
  }
  if (entries.length === 0) return [];

  // Index the tree (every non-session entry carries id/parentId). pi's leaf is the
  // last non-session entry in file order, so the active branch is the parentId chain
  // ending there.
  const byId = new Map<string, PiEntry>();
  let leafId: string | undefined;
  for (const e of entries) {
    if (e.type === "session" || !e.id) continue;
    byId.set(e.id, e);
    leafId = e.id;
  }
  if (!leafId) return [];

  // Walk leaf -> root, then reverse to root -> leaf (chronological).
  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const e = byId.get(cursor);
    if (!e) break;
    branch.push(e);
    cursor = e.parentId;
  }
  branch.reverse();

  const messages: ParsedMessage[] = [];
  // pi records the model both as a per-turn `model_change` entry and on each
  // assistant message; the message's own model wins, model_change is the fallback.
  let currentModel: string | undefined;
  for (const entry of branch) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

    if (entry.type === "model_change") {
      if (entry.modelId) currentModel = entry.modelId;
      continue;
    }
    // thinking_level_change / compaction / branch_summary / custom / label /
    // session_info / bashExecution carry no user-visible conversation turn we map yet
    // (compaction only trims pi's LLM view — the full history stays in the tree and is
    // rendered above), so only `message` entries produce ParsedMessages.
    if (entry.type !== "message" || !entry.message) continue;

    const m = entry.message;
    const { text, thinking, toolCalls, images } = extractPiBlocks(m.content);

    if (m.role === "user") {
      if (text.trim() || images.length > 0) {
        messages.push({
          uuid: entry.id,
          role: "user",
          content: text,
          timestamp,
          images: images.length > 0 ? images : undefined,
        });
      }
    } else if (m.role === "assistant") {
      if (text || thinking || toolCalls.length > 0 || images.length > 0) {
        const model = m.model && !m.model.startsWith("<") ? m.model : currentModel;
        messages.push({
          uuid: entry.id,
          role: "assistant",
          content: text,
          timestamp,
          thinking: thinking || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          images: images.length > 0 ? images : undefined,
          stopReason: m.stopReason,
          model,
        });
      }
    } else if (m.role === "toolResult") {
      messages.push({
        uuid: entry.id,
        role: "assistant",
        content: "",
        timestamp,
        toolResults: [{
          toolUseId: m.toolCallId ?? "",
          content: text,
          isError: m.isError,
        }],
        images: images.length > 0
          ? images.map((img) => ({ ...img, toolUseId: m.toolCallId }))
          : undefined,
      });
    }
  }

  return messages;
}

export function extractPiCwd(content: string): string | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && entry.cwd) return entry.cwd;
    } catch {}
  }
  return undefined;
}

export function extractPiSessionId(content: string): string | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && entry.id) return entry.id;
    } catch {}
  }
  return undefined;
}

/**
 * Parse a transcript blob into the daemon's ParsedMessage[] using the parser for
 * `clientId`. The per-client parsers above stay the transcript-format authorities;
 * this is the single client → parser mapping the daemon's per-client processors
 * dispatch through, so a new client wires up by adding one case here (and its
 * descriptor) rather than a fresh branch at each call site. Cursor maps to the
 * text-transcript parser (the sync path that reads a transcript FILE); the SQLite
 * blob path uses parseCursorPrompts directly. OpenCode reads an assembled
 * multi-file snapshot (see parseOpencodeSessionFile).
 */
export function parseTranscriptFor(clientId: AgentClientId, content: string): ParsedMessage[] {
  switch (clientId) {
    case "codex":
      return parseCodexSessionFile(content);
    case "gemini":
      return parseGeminiSessionFile(content);
    case "cursor":
      return parseCursorTranscriptFile(content);
    case "opencode":
      return parseOpencodeSessionFile(content);
    case "pi":
      return parsePiSessionFile(content);
    default:
      return parseSessionFile(content);
  }
}
