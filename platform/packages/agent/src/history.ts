import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";

/** A tool call on an assistant row. `input` is the arguments as JSON text (an object is accepted on read). */
export interface ToolCallRow {
  id: string;
  name: string;
  input: string | Record<string, unknown>;
}

/** A tool result on a row, answering the call with the same id. */
export interface ToolResultRow {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** An inline image. With `tool_use_id` it belongs to that call's result; without, to the person's message. */
export interface ImageRow {
  media_type: string;
  data?: string;
  tool_use_id?: string;
}

export interface UsageRow {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * The fields of a codecast `messages` row that carry the conversation. Tool
 * results ride on `user` rows (the shape Claude transcripts sync as); a
 * `tool` row or tool results on an `assistant` row read the same way. `system`
 * rows are notices for people and never reach the model.
 */
export interface MessageRow {
  role: "user" | "assistant" | "tool" | "system";
  content?: string;
  thinking?: string;
  tool_calls?: ToolCallRow[];
  tool_results?: ToolResultRow[];
  images?: ImageRow[];
  model?: string;
  timestamp?: number;
  usage?: UsageRow;
  message_uuid?: string;
  api_message_id?: string;
}

/**
 * A pi message that remembers the row it came from, so converting back puts
 * the pieces of one row (several tool results, a result and its postscript)
 * into one row again.
 */
export type RowMessage = Message & { rowKey?: string };

/** Row keys minted for rows without a `message_uuid`; never written back as a uuid. */
const SYNTHETIC_KEY = "row#";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** The api and provider an assistant row's model ran on, for pi's same-model checks. */
function apiOf(model: string | undefined): { api: string; provider: string } {
  if (model?.startsWith("claude-")) return { api: "anthropic-messages", provider: "anthropic" };
  return { api: "codecast", provider: "codecast" };
}

function parseInput(input: ToolCallRow["input"]): Record<string, unknown> {
  if (typeof input !== "string") return input;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: input };
  }
}

function usageFromRow(usage: UsageRow | undefined): Usage {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...ZERO_COST } };
}

function imageBlock(image: ImageRow): ImageContent | null {
  return image.data ? { type: "image", data: image.data, mimeType: image.media_type } : null;
}

/**
 * Converts codecast rows to pi messages, in order. Images stored only by
 * storage id carry no bytes and are skipped; fetch them into `data` first.
 */
export function rowsToMessages(rows: readonly MessageRow[]): RowMessage[] {
  const out: RowMessage[] = [];
  const callNames = new Map<string, string>();

  rows.forEach((row, index) => {
    if (row.role === "system") return;
    const rowKey = row.message_uuid ?? `${SYNTHETIC_KEY}${index}`;
    const timestamp = row.timestamp ?? 0;

    const pushResults = () => {
      for (const result of row.tool_results ?? []) {
        const images = (row.images ?? [])
          .filter((image) => image.tool_use_id === result.tool_use_id)
          .map(imageBlock)
          .filter((block): block is ImageContent => block !== null);
        const message: ToolResultMessage & { rowKey: string } = {
          role: "toolResult",
          toolCallId: result.tool_use_id,
          toolName: callNames.get(result.tool_use_id) ?? "unknown",
          content: [{ type: "text", text: result.content }, ...images],
          isError: result.is_error === true,
          timestamp,
          rowKey,
        };
        out.push(message);
      }
    };

    if (row.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (row.thinking) content.push({ type: "thinking", thinking: row.thinking });
      if (row.content) content.push({ type: "text", text: row.content });
      for (const call of row.tool_calls ?? []) {
        callNames.set(call.id, call.name);
        content.push({ type: "toolCall", id: call.id, name: call.name, arguments: parseInput(call.input) });
      }
      if (content.length > 0) {
        const message: AssistantMessage & { rowKey: string } = {
          role: "assistant",
          content,
          ...apiOf(row.model),
          model: row.model ?? "",
          ...(row.api_message_id ? { responseId: row.api_message_id } : {}),
          usage: usageFromRow(row.usage),
          stopReason: row.tool_calls?.length ? "toolUse" : "stop",
          timestamp,
          rowKey,
        };
        out.push(message);
      }
      pushResults();
      return;
    }

    pushResults();
    const images = (row.images ?? [])
      .filter((image) => !image.tool_use_id)
      .map(imageBlock)
      .filter((block): block is ImageContent => block !== null);
    if (!row.content && images.length === 0) return;
    const message: UserMessage & { rowKey: string } = {
      role: "user",
      content: images.length > 0 ? [...(row.content ? [{ type: "text" as const, text: row.content }] : []), ...images] : row.content!,
      timestamp,
      rowKey,
    };
    out.push(message);
  });

  return out;
}

function textOf(blocks: readonly (TextContent | ImageContent | ThinkingContent | ToolCall)[]): string {
  return blocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function imagesOf(blocks: readonly (TextContent | ImageContent)[], toolUseId?: string): ImageRow[] {
  return blocks
    .filter((block): block is ImageContent => block.type === "image")
    .map((block) => ({ media_type: block.mimeType, data: block.data, ...(toolUseId ? { tool_use_id: toolUseId } : {}) }));
}

/** One message as the row it would be stored as (before merging with its row siblings). */
function messageToRow(message: RowMessage): MessageRow {
  const uuid = message.rowKey && !message.rowKey.startsWith(SYNTHETIC_KEY) ? { message_uuid: message.rowKey } : {};
  if (message.role === "assistant") {
    const thinking = message.content
      .filter((block): block is ThinkingContent => block.type === "thinking")
      .map((block) => block.thinking)
      .filter((text) => text.length > 0)
      .join("\n\n");
    const text = textOf(message.content);
    const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
    return {
      role: "assistant",
      ...(text ? { content: text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(calls.length > 0
        ? { tool_calls: calls.map((call) => ({ id: call.id, name: call.name, input: JSON.stringify(call.arguments) })) }
        : {}),
      ...(message.model ? { model: message.model } : {}),
      timestamp: message.timestamp,
      usage: {
        input_tokens: message.usage.input,
        output_tokens: message.usage.output,
        cache_creation_input_tokens: message.usage.cacheWrite,
        cache_read_input_tokens: message.usage.cacheRead,
      },
      ...uuid,
      ...(message.responseId ? { api_message_id: message.responseId } : {}),
    };
  }
  if (message.role === "toolResult") {
    const images = imagesOf(message.content, message.toolCallId);
    return {
      role: "user",
      tool_results: [{ tool_use_id: message.toolCallId, content: textOf(message.content), is_error: message.isError }],
      ...(images.length > 0 ? { images } : {}),
      timestamp: message.timestamp,
      ...uuid,
    };
  }
  if (typeof message.content === "string") return { role: "user", content: message.content, timestamp: message.timestamp, ...uuid };
  const text = textOf(message.content);
  const images = imagesOf(message.content);
  return {
    role: "user",
    ...(text ? { content: text } : {}),
    ...(images.length > 0 ? { images } : {}),
    timestamp: message.timestamp,
    ...uuid,
  };
}

/** Folds a row into the row before it when both came from one stored row. */
function mergeRows(into: MessageRow, row: MessageRow): void {
  if (row.role === "assistant") into.role = "assistant";
  if (row.content) into.content = into.content ? `${into.content}\n\n${row.content}` : row.content;
  if (row.thinking) into.thinking = into.thinking ? `${into.thinking}\n\n${row.thinking}` : row.thinking;
  if (row.tool_calls) into.tool_calls = [...(into.tool_calls ?? []), ...row.tool_calls];
  if (row.tool_results) into.tool_results = [...(into.tool_results ?? []), ...row.tool_results];
  if (row.images) into.images = [...(into.images ?? []), ...row.images];
  for (const key of ["model", "usage", "api_message_id"] as const) {
    if (row[key] !== undefined && into[key] === undefined) (into as unknown as Record<string, unknown>)[key] = row[key];
  }
}

/**
 * Converts pi messages to codecast rows. Messages that came from one row
 * (same `rowKey`) and sit next to each other become that one row again, so
 * rows -> messages -> rows returns what went in. Cost is not kept on rows;
 * the wallet ledger holds it.
 */
export function messagesToRows(messages: readonly RowMessage[]): MessageRow[] {
  const rows: MessageRow[] = [];
  let lastKey: string | undefined;
  for (const message of messages) {
    const row = messageToRow(message);
    if (message.rowKey !== undefined && message.rowKey === lastKey && rows.length > 0) {
      mergeRows(rows[rows.length - 1], row);
    } else {
      rows.push(row);
    }
    lastKey = message.rowKey;
  }
  return rows;
}

/**
 * Shapes history for the model without changing the stored transcript.
 *
 * - Thinking without a signature is dropped. Rows keep thinking text but not
 *   its signature, and the API cannot verify unsigned thinking, so replaying it
 *   would only resend the model's notes as if it had said them.
 * - An assistant message left with nothing in it is dropped.
 * - A tool result moves to sit right after the call it answers. An approval
 *   answered after the person typed again lands later in time than their
 *   message, and the API wants every result directly after its call.
 * - A result whose call never appears, or a second result for one call, is
 *   dropped, since the API refuses both.
 */
export function prepareContext(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  const owners = new Map<string, Message>();
  const answered = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type !== "thinking" || !!block.thinkingSignature);
      if (content.length === 0) continue;
      const kept = content.length === message.content.length ? message : { ...message, content };
      out.push(kept);
      for (const block of content) if (block.type === "toolCall") owners.set(block.id, kept);
      continue;
    }
    if (message.role === "toolResult") {
      const owner = owners.get(message.toolCallId);
      if (!owner || answered.has(message.toolCallId)) continue;
      answered.add(message.toolCallId);
      let at = out.indexOf(owner) + 1;
      while (at < out.length && out[at].role === "toolResult") at++;
      out.splice(at, 0, message);
      continue;
    }
    out.push(message);
  }
  return out;
}
