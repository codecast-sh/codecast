import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { untrusted } from "./untrusted";

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
 * `tool` row or tool results on an `assistant` row read the same way, and a
 * `tool` row's own text reaches the model labelled as tool output, never as
 * the person's words. `system` rows are notices for people and never reach
 * the model.
 */
export interface MessageRow {
  role: "user" | "assistant" | "tool" | "system";
  content?: string;
  thinking?: string;
  /**
   * The signature of the message's thinking, which the API needs to continue
   * a turn that thought before calling a tool (resuming after an approval).
   * Kept when the message had one thinking block, the shape a tool call stop
   * has; a message with several keeps none, and its thinking is not replayed.
   */
  thinking_signature?: string;
  /** The thinking was redacted; its encrypted payload is `thinking_signature`. */
  thinking_redacted?: boolean;
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
 * Every field a `MessageRow` can carry. codecast's batch message writer
 * accepts each one (a convex test checks this list against its validator), so
 * a row the harness emits is stored as it is, signature included.
 */
export const MESSAGE_ROW_FIELDS = [
  "role",
  "content",
  "thinking",
  "thinking_signature",
  "thinking_redacted",
  "tool_calls",
  "tool_results",
  "images",
  "model",
  "timestamp",
  "usage",
  "message_uuid",
  "api_message_id",
] as const satisfies readonly (keyof MessageRow)[];

// Fails to compile when MessageRow gains a field the list above lacks.
const everyRowField: Exclude<keyof MessageRow, (typeof MESSAGE_ROW_FIELDS)[number]> extends never ? true : never = true;
void everyRowField;

/** A row field that reading fills with a default when the row lacks it. */
export type AbsentField = "timestamp" | "usage" | "is_error";

/** What a message read from a row remembers about it, so it is written back as it was. */
export interface RowOrigin {
  /** Set for a message read from a `tool` row. */
  role?: "tool";
  /** Fields the row lacked, which reading filled with defaults pi requires. */
  absent?: readonly AbsentField[];
  /** A `tool` row's own text, which the model sees wrapped as tool output. */
  content?: string;
}

/**
 * A pi message that remembers the row it came from, so converting back puts
 * the pieces of one row (several tool results, a result and its postscript)
 * into one row again, in the row's own role and without fields it lacked.
 */
export type RowMessage = Message & { rowKey?: string; rowOrigin?: RowOrigin };

/** Row keys minted for rows without a `message_uuid`; never written back as a uuid. */
const SYNTHETIC_KEY = "row#";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** The api and provider an assistant row's model ran on, for pi's same-model checks. */
function apiOf(model: string | undefined): { api: string; provider: string } {
  if (model?.startsWith("claude-")) return { api: "anthropic-messages", provider: "anthropic" };
  return { api: "codecast", provider: "codecast" };
}

/** A stored tool call's input as the arguments a tool runs with: JSON text is
 *  parsed, a non-object value is wrapped as `{ value }`, and text that is not
 *  JSON is kept as `{ raw }`. Every replay of a stored call goes through this. */
export function parseInput(input: ToolCallRow["input"]): Record<string, unknown> {
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
    const fromTool = row.role === "tool";
    const origin = (absent: readonly AbsentField[], extra: RowOrigin = {}): { rowOrigin?: RowOrigin } => {
      const rowOrigin: RowOrigin = {
        ...(fromTool ? { role: "tool" as const } : {}),
        ...(absent.length > 0 ? { absent } : {}),
        ...extra,
      };
      return Object.keys(rowOrigin).length > 0 ? { rowOrigin } : {};
    };
    const noTimestamp: AbsentField[] = row.timestamp === undefined ? ["timestamp"] : [];

    const pushResults = () => {
      for (const result of row.tool_results ?? []) {
        const images = (row.images ?? [])
          .filter((image) => image.tool_use_id === result.tool_use_id)
          .map(imageBlock)
          .filter((block): block is ImageContent => block !== null);
        const message: RowMessage = {
          role: "toolResult",
          toolCallId: result.tool_use_id,
          toolName: callNames.get(result.tool_use_id) ?? "unknown",
          content: [{ type: "text", text: result.content }, ...images],
          isError: result.is_error === true,
          timestamp,
          rowKey,
          ...origin(result.is_error === undefined ? [...noTimestamp, "is_error"] : noTimestamp),
        };
        out.push(message);
      }
    };

    if (row.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (row.thinking || row.thinking_signature) {
        content.push({
          type: "thinking",
          thinking: row.thinking ?? "",
          ...(row.thinking_signature ? { thinkingSignature: row.thinking_signature } : {}),
          ...(row.thinking_redacted ? { redacted: true } : {}),
        });
      }
      if (row.content) content.push({ type: "text", text: row.content });
      for (const call of row.tool_calls ?? []) {
        callNames.set(call.id, call.name);
        content.push({ type: "toolCall", id: call.id, name: call.name, arguments: parseInput(call.input) });
      }
      if (content.length > 0) {
        const message: RowMessage = {
          role: "assistant",
          content,
          ...apiOf(row.model),
          model: row.model ?? "",
          ...(row.api_message_id ? { responseId: row.api_message_id } : {}),
          usage: usageFromRow(row.usage),
          stopReason: row.tool_calls?.length ? "toolUse" : "stop",
          timestamp,
          rowKey,
          ...origin(row.usage === undefined ? [...noTimestamp, "usage"] : noTimestamp),
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
    // A tool row's text is the tool's output, not the person speaking. It is
    // wrapped again on every conversion, so its tag takes a nonce from the
    // row's own id: the same bytes each turn keep the prompt cache warm, and the
    // id is not something the tool's output could see or choose.
    const text = row.content ? (fromTool ? untrusted("tool output", row.content, { nonce: rowNonce(row) }) : row.content) : undefined;
    const message: RowMessage = {
      role: "user",
      content: images.length > 0 || fromTool ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text!,
      timestamp,
      rowKey,
      ...origin(noTimestamp, fromTool && row.content ? { content: row.content } : {}),
    };
    out.push(message);
  });

  return out;
}

/** 8 hex characters of the row's uuid, or undefined (a fresh nonce) when it has none to give. */
function rowNonce(row: MessageRow): string | undefined {
  const hex = (row.message_uuid ?? "").replace(/[^0-9a-f]/gi, "");
  return hex.length >= 8 ? hex.slice(-8).toLowerCase() : undefined;
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
  const absent = new Set(message.rowOrigin?.absent ?? []);
  const timestamp = absent.has("timestamp") ? {} : { timestamp: message.timestamp };
  const role = message.rowOrigin?.role ?? "user";
  if (message.role === "assistant") {
    const blocks = message.content.filter((block): block is ThinkingContent => block.type === "thinking");
    const thinking = blocks
      .map((block) => block.thinking)
      .filter((text) => text.length > 0)
      .join("\n\n");
    const signed = blocks.length === 1 && blocks[0].thinkingSignature ? blocks[0] : undefined;
    const text = textOf(message.content);
    const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
    return {
      role: "assistant",
      ...(text ? { content: text } : {}),
      ...(thinking ? { thinking } : {}),
      ...(signed ? { thinking_signature: signed.thinkingSignature } : {}),
      ...(signed?.redacted ? { thinking_redacted: true } : {}),
      ...(calls.length > 0
        ? { tool_calls: calls.map((call) => ({ id: call.id, name: call.name, input: JSON.stringify(call.arguments) })) }
        : {}),
      ...(message.model ? { model: message.model } : {}),
      ...timestamp,
      ...(absent.has("usage")
        ? {}
        : {
            usage: {
              input_tokens: message.usage.input,
              output_tokens: message.usage.output,
              cache_creation_input_tokens: message.usage.cacheWrite,
              cache_read_input_tokens: message.usage.cacheRead,
            },
          }),
      ...uuid,
      ...(message.responseId ? { api_message_id: message.responseId } : {}),
    };
  }
  if (message.role === "toolResult") {
    const images = imagesOf(message.content, message.toolCallId);
    return {
      role,
      tool_results: [
        {
          tool_use_id: message.toolCallId,
          content: textOf(message.content),
          ...(absent.has("is_error") ? {} : { is_error: message.isError }),
        },
      ],
      ...(images.length > 0 ? { images } : {}),
      ...timestamp,
      ...uuid,
    };
  }
  if (typeof message.content === "string") return { role, content: message.content, ...timestamp, ...uuid };
  const text = message.rowOrigin?.role === "tool" ? message.rowOrigin.content : textOf(message.content);
  const images = imagesOf(message.content);
  return {
    role,
    ...(text ? { content: text } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...timestamp,
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
  for (const key of ["model", "usage", "api_message_id", "thinking_signature", "thinking_redacted", "timestamp"] as const) {
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
 * - Thinking without a signature is dropped. A row keeps the signature only
 *   when its message had one thinking block, and the API cannot verify
 *   unsigned thinking, so replaying it would only resend the model's notes as
 *   if it had said them.
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
