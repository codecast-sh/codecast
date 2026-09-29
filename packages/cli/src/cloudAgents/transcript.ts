/**
 * The mirror format every cloud agent renders into, and its one reader.
 *
 * The transcript is cursor-agent's JSONL record shape (role +
 * message.content parts, `turn_ended` markers) plus a stable `id` and a fixed
 * `timestamp` per record. MirrorTranscript writes it, parseMirrorTranscript
 * reads it; Cursor's own local JSONL parser (parser.ts) is the same reader
 * with Cursor's text rewrites on top. meta.json beside it (mirrorMetaJson,
 * readMirrorMeta) places the session and links a forked worker to its parent.
 *
 * Two rules keep a re-rendered mirror from duplicating rows on the server:
 * - Every record names a stable id (what it renders from), never a position,
 *   so a row keeps its identity when a turn gains detail.
 * - A record is dated by its first event, never by when it was flushed: a
 *   row's timestamp is fixed at its first sync.
 */
import * as fs from "fs";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX, CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { codecastPath } from "../codecastDir.js";
import type { ParsedMessage, ToolCall, ToolResult } from "../parser.js";

export interface MirrorToolUse { id: string; name: string; input: Record<string, unknown> }

export class MirrorTranscript {
  private readonly lines: string[] = [];
  /** Calls already shown: a call that completes turns later keeps its one row. */
  private readonly opened = new Set<string>();
  private pending = "";
  private pendingId: string | undefined;
  private pendingAt = 0;
  /** The time new records take when nothing dates them. */
  clock: number;

  /** `linkify` rewrites text before it is stored (e.g. a vendor's bare agent links). */
  constructor(createdAt: number, private readonly linkify: (t: string) => string = (t) => t) {
    this.clock = createdAt;
  }

  private text(t: string) {
    return { type: "text", text: this.linkify(t) };
  }

  private push(rec: Record<string, unknown>): void {
    this.lines.push(JSON.stringify(rec));
  }

  /** Move the clock forward to a turn's start. */
  advanceTo(ms: number | undefined): void {
    if (ms) this.clock = Math.max(this.clock, ms);
  }

  user(id: string | undefined, text: string): void {
    this.push({ role: "user", id, timestamp: this.clock, message: { content: [this.text(text)] } });
  }

  assistant(id: string | undefined, text: string, at = this.clock): void {
    this.push({ role: "assistant", id, timestamp: at, message: { content: [this.text(text)] } });
  }

  /** The line codecast adds under the first prompt. */
  notice(text: string): void {
    this.assistant("notice-start", `ℹ ${text}`);
  }

  /** A failure banner the session shows as a stopped turn. */
  error(id: string, text: string, at?: number): void {
    this.assistant(id, `${CLIENT_ERROR_BANNER_PREFIX} ${text}`, at || this.clock);
  }

  /** Streamed assistant text: consecutive pieces join one record, id'd and dated by the first. */
  appendText(eventId: string | undefined, text: string): void {
    if (!this.pendingId) { this.pendingId = eventId; this.pendingAt = this.clock; }
    this.pending += text;
  }

  /** Close the text record in progress (a step boundary, a turn's end). */
  breakSegment(): void {
    this.flush();
  }

  private flush(extra: unknown[] = [], id?: string): void {
    const content = [...(this.pending.trim() ? [this.text(this.pending.trim())] : []), ...extra];
    const recordId = id ?? (this.pendingId ? `seg-${this.pendingId}` : undefined);
    const at = this.pendingId ? this.pendingAt : this.clock;
    this.pending = "";
    this.pendingId = undefined;
    if (content.length) this.push({ role: "assistant", id: recordId, timestamp: at, message: { content } });
  }

  /** A tool call: its row once (with any text before it), however many times it is seen. */
  toolUse(use: MirrorToolUse): void {
    if (this.opened.has(use.id)) { this.flush(); return; }
    this.opened.add(use.id);
    this.flush([{ type: "tool_use", ...use }], `use-${use.id}`);
  }

  toolResult(toolUseId: string, content: string, isError: boolean): void {
    this.push({ role: "user", id: `result-${toolUseId}`, timestamp: this.clock, message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } });
  }

  turnEnded(): void {
    this.push({ type: "turn_ended", status: "success" });
  }

  toString(): string {
    return this.lines.length ? `${this.lines.join("\n")}\n` : "";
  }
}

/** What a reader makes of a record's joined text. `whole`: the text stands for the entire record (kept as is, its tool blocks dropped). */
export interface MirrorTextRewrite { text: string; clock?: number; whole?: boolean }

export interface MirrorReadOptions {
  /** Message uuids are `<sessionId>:<record id>` (or the record's ordinal when it names none). */
  sessionId?: string;
  /** The clock for records before any dated one. */
  fallbackClock?: number;
  /** A client's rewrite of a record's text (Cursor's query and notification wrappers). */
  rewrite?: (role: "user" | "assistant", text: string) => MirrorTextRewrite;
  /** Prefix of the id given a tool call that names none. */
  toolIdPrefix?: string;
}

/**
 * Read a mirror transcript. A record's identity is its own `id`, else its
 * ordinal over every role record (counted even when it renders nothing, so a
 * record that fills in later never shifts the ones after it). A record's
 * clock is its own `timestamp`, else the one before it.
 */
export function parseMirrorTranscript(content: string, opts: MirrorReadOptions = {}): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  // A stable clock when a record precedes any dated one, so a rewrite never
  // changes a message's signature.
  let clock = opts.fallbackClock || Date.now();
  let record = -1;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: { role?: string; type?: string; id?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    const role = entry.role;
    // turn_ended closes the turn on its last reply: the stamp changes that
    // message's signature, so the rewrite that only appends the marker still
    // reaches the sync and settles the status.
    if (entry.type === "turn_ended") {
      const last = messages[messages.length - 1];
      if (last) last.stopReason = "end_turn";
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    record++;
    if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) clock = entry.timestamp;
    const blocks = Array.isArray(entry.message?.content) ? entry.message!.content as Array<Record<string, unknown>> : [];
    const text: string[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      else if (block.type === "tool_use" && typeof block.name === "string") {
        const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
        toolCalls.push({ id: typeof block.id === "string" ? block.id : `${opts.toolIdPrefix ?? "mirror"}-${messages.length}-${toolCalls.length}`, name: block.name, input });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        toolResults.push({ toolUseId: block.tool_use_id, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""), ...(block.is_error === true ? { isError: true } : {}) });
      }
    }
    const uuid = opts.sessionId ? { uuid: `${opts.sessionId}:${typeof entry.id === "string" && entry.id ? entry.id : record}` } : {};
    // Control bytes a terminal paste left in the text (\v, \x01).
    const raw = text.join("\n\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    const rewritten = opts.rewrite?.(role, raw) ?? { text: raw };
    if (rewritten.clock !== undefined) clock = rewritten.clock;
    if (rewritten.whole) {
      messages.push({ ...uuid, role, content: rewritten.text, timestamp: clock });
      continue;
    }
    const body = rewritten.text.trim();
    if (!body && toolCalls.length === 0 && toolResults.length === 0) continue;
    messages.push({ ...uuid, role, content: body, timestamp: clock, ...(toolCalls.length ? { toolCalls } : {}), ...(toolResults.length ? { toolResults } : {}) });
  }
  return messages;
}

// ── meta.json ────────────────────────────────────────────────────────────────

/** A mirror's meta.json: where the session belongs and, for a forked worker, its parent. cursor-agent's own chat meta.json has the same shape. */
export interface MirrorMeta { dir: string; cwd?: string; title?: string; parentAgentId?: string; description?: string }

export function mirrorMetaJson(meta: { cwd: string; title?: string; url?: string; createdAtMs?: number; parentAgentId?: string; description?: string }): string {
  return JSON.stringify({ cwd: meta.cwd, title: meta.title, url: meta.url, createdAtMs: meta.createdAtMs || undefined, cloud: true, ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId, description: meta.description } : {}) });
}

/** The meta.json in a directory, or null when there is none. */
export async function readMetaJson(dir: string): Promise<MirrorMeta | null> {
  let raw: string;
  try { raw = await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"); } catch { return null; }
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { dir, cwd: str(meta.cwd), title: str(meta.title), parentAgentId: str(meta.parentAgentId), description: str(meta.description) };
  } catch { return { dir }; }
}

/** A cloud agent's mirror meta, found by its id: the provider is the one whose ids it carries. */
export async function readMirrorMeta(agentId: string): Promise<MirrorMeta | null> {
  for (const spec of Object.values(CLOUD_AGENT_PROVIDERS)) {
    if (!agentId.startsWith(spec.sessionIdPrefix)) continue;
    const meta = await readMetaJson(codecastPath(spec.mirrorDir, path.basename(agentId)));
    if (meta) return meta;
  }
  return null;
}
