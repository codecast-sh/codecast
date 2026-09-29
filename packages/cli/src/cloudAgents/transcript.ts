/**
 * The mirror transcript every cloud agent renders into: cursor-agent's JSONL
 * record shape (role + message.content parts, `turn_ended` markers) plus a
 * stable `id` and a fixed `timestamp` per record, which the Cursor JSONL
 * parser reads (parser.ts, parseCursorJsonlTranscript).
 *
 * Two rules keep a re-rendered mirror from duplicating rows on the server:
 * - Every record names a stable id (what it renders from), never a position,
 *   so a row keeps its identity when a turn gains detail.
 * - A record is dated by its first event, never by when it was flushed: a
 *   row's timestamp is fixed at its first sync.
 */
import { CLIENT_ERROR_BANNER_PREFIX } from "@codecast/shared/contracts";

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
