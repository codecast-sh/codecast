/**
 * Replay boundary for a Codex rollout the app-server forked from a codecast
 * import (`codecast-fork-*-<importSessionId>.jsonl`, written by generateCodexJsonl).
 *
 * `thread/fork` copies the import into the new rollout, but it mints a fresh
 * `payload.id` on every response_item and stamps every line with the fork
 * time. Nothing else changes: across 19,142 aligned response_items from the
 * two real forks of 2026-09-04 (imports 22b96cbf and 281e2ac7), the ONLY
 * differences were `payload.id` (absent in the import, present in the fork)
 * and the line `timestamp`. `call_id`, `content`, `arguments`, `output` and
 * every other field are byte-identical. That is why the fingerprint below
 * drops exactly `payload.id` and the line timestamp and nothing more.
 *
 * The replayed prefix is therefore the import's response_item sequence, one
 * to one and in order, and the first response_item that does not equal the
 * import's next item is the first genuine item. Genuine turns only ever land
 * after the copy (the app-server cannot accept a turn before the fork
 * returns), so a non-response line seen while the import is still being
 * matched is a copied line too (event_msg / turn_context are copied with
 * rewritten ids and produce no message).
 *
 * The import file on disk is the authority. There is no second registry: a
 * cursor is rebuilt from the rollout's own bytes (reconstructReplayCursor),
 * and whenever provenance is uncertain (no import, wrong import, a mismatch
 * before the sequence is exhausted) the answer is "emit": keep the source
 * line for ordinary ingestion rather than discard it.
 *
 * Pure: no filesystem, no daemon state. The daemon feeds it the import text
 * and rollout chunks and honours the per-line verdicts.
 */

export type ReplayVerdict = "skip" | "emit";

export interface ImportReplayAuthority {
  importSessionId: string;
  /** Fingerprints of the import's response_items, in file order. */
  fingerprints: string[];
}

export type ReplayCursorState = "replaying" | "complete" | "mismatch";

export interface ReplayCursor {
  /** How many of the import's response_items have been matched, in order. */
  matched: number;
  state: ReplayCursorState;
}

export interface ReplayChunkResult {
  skipped: string[];
  emitted: string[];
  /** Trailing bytes after the last newline: an incomplete line to prepend to the next chunk. */
  carry: string;
}

type JsonRecord = Record<string, unknown>;

function parseLine(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Fingerprint of a response_item payload as the fork replays it: the payload
 *  with `id` removed (the one field thread/fork adds), key order normalised.
 *  The line `timestamp` is outside the payload and never enters. */
export function responseItemFingerprint(payload: JsonRecord): string {
  const { id: _id, ...rest } = payload;
  return stableJson(rest);
}

/** `forked_from_id` from a rollout's first line, when it is a session_meta. */
export function rolloutForkParentId(firstLine: string): string | undefined {
  const parsed = parseLine(firstLine);
  const payload = parsed?.type === "session_meta" ? (parsed.payload as JsonRecord | undefined) : undefined;
  return typeof payload?.forked_from_id === "string" ? payload.forked_from_id : undefined;
}

/** Read the import file as the replay authority. Returns null when the file
 *  is not the import it is supposed to be: no leading session_meta, or a
 *  session_meta whose id is not `importSessionId` (the file was replaced). */
export function readImportReplayAuthority(importJsonl: string, importSessionId: string): ImportReplayAuthority | null {
  const lines = importJsonl.split("\n").filter((line) => line.trim().length > 0);
  const head = lines.length > 0 ? parseLine(lines[0]) : null;
  const headPayload = head?.type === "session_meta" ? (head.payload as JsonRecord | undefined) : undefined;
  if (headPayload?.id !== importSessionId) return null;
  const fingerprints: string[] = [];
  for (const line of lines.slice(1)) {
    const parsed = parseLine(line);
    if (parsed?.type !== "response_item") continue;
    const payload = parsed.payload;
    if (!payload || typeof payload !== "object") continue;
    fingerprints.push(responseItemFingerprint(payload as JsonRecord));
  }
  return { importSessionId, fingerprints };
}

export function createReplayCursor(fingerprintCount: number): ReplayCursor {
  return { matched: 0, state: fingerprintCount === 0 ? "complete" : "replaying" };
}

/** Verdict for one complete rollout line. Mutates the cursor. */
export function classifyRolloutLine(authority: ImportReplayAuthority, cursor: ReplayCursor, line: string): ReplayVerdict {
  if (cursor.state !== "replaying") return "emit";
  const parsed = parseLine(line);
  if (!parsed) return "emit";
  if (parsed.type === "session_meta") return "emit";
  if (parsed.type !== "response_item") return "skip";
  const payload = parsed.payload;
  const fingerprint = payload && typeof payload === "object" ? responseItemFingerprint(payload as JsonRecord) : "";
  if (fingerprint !== authority.fingerprints[cursor.matched]) {
    cursor.state = "mismatch";
    return "emit";
  }
  cursor.matched += 1;
  if (cursor.matched === authority.fingerprints.length) cursor.state = "complete";
  return "skip";
}

/** Classify every complete line in a chunk; an incomplete trailing line is
 *  returned as `carry` and must be prepended to the next chunk. */
export function advanceReplayCursor(
  authority: ImportReplayAuthority,
  cursor: ReplayCursor,
  chunk: string,
): ReplayChunkResult {
  const lastNewline = chunk.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : chunk.slice(0, lastNewline + 1);
  const carry = lastNewline === -1 ? chunk : chunk.slice(lastNewline + 1);
  const skipped: string[] = [];
  const emitted: string[] = [];
  for (const line of complete.split("\n")) {
    if (line.trim().length === 0) continue;
    (classifyRolloutLine(authority, cursor, line) === "skip" ? skipped : emitted).push(line);
  }
  return { skipped, emitted, carry };
}

/** Rebuild the cursor for a rollout whose first `consumedBytes` were already
 *  ingested before a restart: the rollout's own bytes are the record of what
 *  was matched, so nothing but the import needs to persist. */
export function reconstructReplayCursor(authority: ImportReplayAuthority, rolloutText: string, consumedBytes: number): ReplayCursor {
  const cursor = createReplayCursor(authority.fingerprints.length);
  const consumed = Buffer.from(rolloutText, "utf8").subarray(0, consumedBytes).toString("utf8");
  advanceReplayCursor(authority, cursor, consumed);
  return cursor;
}
