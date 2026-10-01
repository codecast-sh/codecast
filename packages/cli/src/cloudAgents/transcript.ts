/**
 * The mirror format every cloud agent renders into, and its one reader.
 *
 * Each record is one ParsedMessage: role, message.content parts (text,
 * tool_use, tool_result), a stable `id` and a fixed `timestamp`, and, when
 * the message has them, `thinking`, `images`, `subtype` and `model`.
 * `turn_ended` markers close a turn. It is cursor-agent's JSONL shape
 * extended, so Cursor's own local JSONL reads with the same reader in its
 * plain mode (parser.ts adds Cursor's text rewrites), and settles by the
 * same tail rule (classifyMirrorTranscriptTail). MirrorTranscript writes it:
 * `message` takes a message another parser produced as is (Codex's
 * threadItemToMessage), and the other methods build records from a vendor's
 * events. parseMirrorTranscript reads it back. meta.json beside it
 * (mirrorMetaJson, readMetaJson) places the session and links a forked
 * worker to its parent.
 *
 * Two rules keep a re-rendered mirror from duplicating rows on the server:
 * - Every record names a stable id (what it renders from), never a position,
 *   so a row keeps its identity when a turn gains detail.
 * - A record is dated by its first event, never by when it was flushed: a
 *   row's timestamp is fixed at its first sync.
 */
import * as fs from "fs";
import * as path from "path";
import { CLIENT_ERROR_BANNER_PREFIX } from "@codecast/shared/contracts";
import type { ImageBlock, ParsedMessage, ToolCall, ToolResult } from "../parser.js";

export interface MirrorToolUse { id: string; name: string; input: Record<string, unknown> }

export interface MirrorTranscriptOptions {
  /** Rewrites text before it is stored (e.g. a vendor's bare agent links). */
  linkify?: (t: string) => string;
  /** The line codecast adds under the first prompt (what the agent started from). */
  notice?: string;
}

/** A line codecast adds to a cloud agent's thread, set off from what the agent said. */
export function mirrorNoteText(text: string): string {
  return `ℹ ${text}`;
}

/** The statuses of a turn that still runs, across providers (Codex Cloud: pending; the Agents API: queued). */
const RUNNING_TURN_STATUSES: ReadonlySet<string> = new Set(["pending", "queued", "in_progress"]);

/**
 * Whether a provider's turn still runs. Any other status has ended it, and
 * endTurn says how: one codecast does not know reads as ended in the
 * provider's own word rather than as running forever.
 */
export function isRunningTurnStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && RUNNING_TURN_STATUSES.has(status);
}

export class MirrorTranscript {
  private readonly lines: string[] = [];
  /** Calls already shown: a call that completes turns later keeps its one row. */
  private readonly opened = new Set<string>();
  private pending = "";
  private pendingId: string | undefined;
  private pendingAt = 0;
  private readonly linkify: (t: string) => string;
  /** The notice still to place: it goes under the first turn's prompt. */
  private noticeText: string | undefined;
  /** The time new records take when nothing dates them. */
  clock: number;

  constructor(createdAt: number, opts: MirrorTranscriptOptions = {}) {
    this.clock = createdAt;
    this.linkify = opts.linkify ?? ((t) => t);
    this.noticeText = opts.notice || undefined;
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

  /**
   * Open a turn: its prompt, when it has one, and on the first turn the
   * notice under it (at the turn's start when the turn has no prompt).
   */
  turn(promptId: string | undefined, prompt: string | undefined): void {
    if (prompt !== undefined) this.user(promptId, prompt);
    this.placeNotice();
  }

  /** A prompt; the first one takes the notice under it. */
  user(id: string | undefined, text: string): void {
    this.push({ role: "user", id, timestamp: this.clock, message: { content: [this.text(text)] } });
    this.placeNotice();
  }

  assistant(id: string | undefined, text: string, at = this.clock): void {
    this.push({ role: "assistant", id, timestamp: at, message: { content: [this.text(text)] } });
  }

  /** A line codecast adds about the agent (what it started from, how a turn ended), set off from what the agent said. */
  note(id: string, text: string, at = this.clock): void {
    this.assistant(id, mirrorNoteText(text), at);
  }

  /** The notice, once, where the first turn opens. */
  private placeNotice(): void {
    if (!this.noticeText) return;
    const text = this.noticeText;
    this.noticeText = undefined;
    this.note("notice-start", text);
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
    this.push({ role: "user", id: `result-${toolUseId}`, timestamp: this.clock, message: { content: [toolResultBlock(toolUseId, content, isError)] } });
  }

  /**
   * A message another parser already produced, as one record: its text, tool
   * calls and results, thinking, images, subtype and model. Its uuid is the
   * record's id (a message without one is read back by its ordinal, which a
   * record that renders nothing yet can shift: give every message a uuid).
   * Its timestamp is the record's and moves the clock forward, so a message
   * without one takes the time of the one before it. A prompt (a user
   * message that carries no tool results) takes the notice under it.
   */
  message(m: ParsedMessage): void {
    this.flush();
    this.advanceTo(m.timestamp);
    const content: unknown[] = m.content ? [this.text(m.content)] : [];
    for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    for (const r of m.toolResults ?? []) content.push(toolResultBlock(r.toolUseId, r.content, !!r.isError));
    this.push({
      role: m.role,
      id: m.uuid,
      timestamp: m.timestamp || this.clock,
      message: { content },
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.subtype ? { subtype: m.subtype } : {}),
      ...(m.model ? { model: m.model } : {}),
    });
    if (m.role === "user" && !m.toolResults?.length) this.placeNotice();
  }

  /**
   * How a turn ended, then its end: a failure as an error banner (`reason`:
   * why), a cancel as a note, any other status the provider names as it says
   * it. Records are id'd by the turn's `key`, so a re-render keeps them.
   */
  endTurn(key: string, end: { status: string | null | undefined; label: string; reason?: string; at?: number }): void {
    const { status, label } = end;
    // Never before the turn's last row: a provider dates the end in its own (whole second) clock.
    const at = Math.max(end.at ?? this.clock, this.clock);
    if (status === "failed") this.error(`${key}:error`, `${label} turn failed: ${end.reason || "no reason given"}`, at);
    else if (status === "cancelled") this.note(`${key}:cancelled`, "Cancelled.", at);
    else if (status && status !== "completed") this.note(`${key}:ended`, `${label} ended this turn as ${status}.`, at);
    this.turnEnded();
  }

  turnEnded(): void {
    this.push({ type: "turn_ended", status: "success" });
  }

  toString(): string {
    return this.lines.length ? `${this.lines.join("\n")}\n` : "";
  }
}

function toolResultBlock(toolUseId: string, content: string, isError: boolean) {
  return { type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

type MirrorExtras = Pick<ParsedMessage, "thinking" | "images" | "subtype" | "model">;

/** A record's thinking, images, subtype and model, when it carries them (only `message` writes them). */
function mirrorExtras(entry: Record<string, unknown>): MirrorExtras {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const images = Array.isArray(entry.images)
    ? (entry.images as Array<Record<string, unknown>>).filter((i) => i && typeof i.mediaType === "string").map((i): ImageBlock => ({
      mediaType: i.mediaType as string,
      ...(str(i.data) ? { data: i.data as string } : {}),
      ...(str(i.localPath) ? { localPath: i.localPath as string } : {}),
      ...(str(i.toolUseId) ? { toolUseId: i.toolUseId as string } : {}),
    }))
    : [];
  const out: MirrorExtras = {};
  if (str(entry.thinking)) out.thinking = entry.thinking as string;
  if (images.length) out.images = images;
  if (str(entry.subtype)) out.subtype = entry.subtype as string;
  if (str(entry.model)) out.model = entry.model as string;
  return out;
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
  /**
   * A transcript codecast did not write (cursor-agent's own JSONL): read only
   * user and assistant records, their text and tool blocks. System records
   * and the extras (thinking, images, subtype, model) are what `message`
   * writes; skipping them here keeps a foreign file's ordinals, which are its
   * records' identities, exactly as they have always been counted.
   */
  plain?: boolean;
}

/**
 * A mirror record's message uuid: the session's id and the record's. A
 * branch reads under its root line's session id (mirrorHistoryId), so the
 * history it shares with its parent is the same messages (and its fork point
 * one of the parent's).
 */
export function mirrorMessageUuid(sessionId: string, recordId: string | number): string {
  return `${sessionId}:${recordId}`;
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
    let entry: { role?: string; type?: string; id?: unknown; timestamp?: unknown; message?: { content?: unknown } } & Record<string, unknown>;
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
    if (role !== "user" && role !== "assistant" && (role !== "system" || opts.plain)) continue;
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
    const uuid = opts.sessionId ? { uuid: mirrorMessageUuid(opts.sessionId, typeof entry.id === "string" && entry.id ? entry.id : record) } : {};
    // Control bytes a terminal paste left in the text (\v, \x01).
    const raw = text.join("\n\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    const rewritten = (role !== "system" && opts.rewrite?.(role, raw)) || { text: raw };
    if (rewritten.clock !== undefined) clock = rewritten.clock;
    if (rewritten.whole) {
      messages.push({ ...uuid, role, content: rewritten.text, timestamp: clock });
      continue;
    }
    const body = rewritten.text.trim();
    const extras: MirrorExtras = opts.plain ? {} : mirrorExtras(entry);
    if (!body && toolCalls.length === 0 && toolResults.length === 0 && !extras.thinking && !extras.images) continue;
    messages.push({ ...uuid, role, content: body, timestamp: clock, ...(toolCalls.length ? { toolCalls } : {}), ...(toolResults.length ? { toolResults } : {}), ...extras });
  }
  return messages;
}

/**
 * Whether a mirror's last turn has settled: `turn_ended` after the last
 * record closes it, a record after the last marker means it is still going.
 */
export function classifyMirrorTranscriptTail(content: string): "idle" | "active" | "unknown" {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let d: { type?: string; role?: string };
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "turn_ended") return "idle";
    if (d.role === "user" || d.role === "assistant") return "active";
  }
  return "unknown";
}

// ── meta.json ────────────────────────────────────────────────────────────────

/**
 * A mirror's meta.json: where the session belongs and, for a child, its
 * parent: a forked worker nests under it, a branch (`forkAt`) is a fork of
 * it at that record. cursor-agent's own chat meta.json has the same shape.
 */
export interface MirrorMeta { dir: string; cwd?: string; title?: string; parentAgentId?: string; description?: string; forkAt?: string; formerTitles?: string[]; archived?: boolean }

/** How many of a provider's earlier titles meta.json keeps: a title that changes more often than it syncs is still recognized as the provider's. */
const FORMER_TITLES = 5;

/**
 * `prior`: the meta.json this one replaces; its title joins the earlier
 * titles when the provider renamed the agent. `placeholders`: the provider's
 * titles for an agent it has not named yet, always among the earlier ones.
 */
export function mirrorMetaJson(meta: { cwd: string; title?: string; url?: string; createdAtMs?: number; parentAgentId?: string; description?: string; forkAt?: string; archived?: boolean }, prior?: MirrorMeta | null, placeholders: string[] = []): string {
  const renamed = [...(prior?.title && prior.title !== meta.title ? [prior.title] : []), ...(prior?.formerTitles ?? [])].filter((t) => !placeholders.includes(t)).slice(0, FORMER_TITLES);
  const former = [...new Set([...placeholders, ...renamed])].filter((t) => t !== meta.title);
  return JSON.stringify({ cwd: meta.cwd, title: meta.title, ...(former.length ? { formerTitles: former } : {}), url: meta.url, createdAtMs: meta.createdAtMs || undefined, cloud: true, ...(meta.archived !== undefined ? { archived: meta.archived } : {}), ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId, description: meta.description, ...(meta.forkAt ? { forkAt: meta.forkAt } : {}) } : {}) });
}

/** The meta.json in a directory, or null when there is none. */
export async function readMetaJson(dir: string): Promise<MirrorMeta | null> {
  let raw: string;
  try { raw = await fs.promises.readFile(path.join(dir, "meta.json"), "utf8"); } catch { return null; }
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const formerTitles = Array.isArray(meta.formerTitles) ? meta.formerTitles.filter((t): t is string => !!str(t)) : [];
    return { dir, cwd: str(meta.cwd), title: str(meta.title), parentAgentId: str(meta.parentAgentId), description: str(meta.description), ...(str(meta.forkAt) ? { forkAt: str(meta.forkAt) } : {}), ...(formerTitles.length ? { formerTitles } : {}), ...(typeof meta.archived === "boolean" ? { archived: meta.archived } : {}) };
  } catch { return { dir }; }
}

/**
 * The session id a mirror's records read under: its own, or for a branch
 * (`forkAt`) its root line's, found through each parent's meta.json beside
 * it. Every line of one agent then names the history they share with the
 * same message ids, and a branch of a branch forks at one of its parent's.
 */
export async function mirrorHistoryId(meta: MirrorMeta, ownId: string): Promise<string> {
  let id = ownId;
  let at: MirrorMeta | null = meta;
  for (let hops = 0; at?.forkAt && at.parentAgentId && hops < 16; hops++) {
    id = at.parentAgentId;
    at = await readMetaJson(path.join(path.dirname(at.dir), id));
  }
  return id;
}
