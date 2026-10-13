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
 * import's next item is the first genuine item.
 *
 * Only response_items are ever skipped. event_msg and turn_context lines are
 * copied too, but re-shaped (the fork adds `local_audio`, `phase`,
 * `memory_citation`, rate-limit fields, and changes `collaboration_mode.mode`),
 * so exact authority cannot be proven for them, and parser.ts does turn some
 * of them into messages (`task_complete` with an error). They are always
 * emitted; the parser ignores the copied ones by itself, and a genuine one
 * is never lost.
 *
 * The import file on disk is the authority. There is no second registry: a
 * cursor is rebuilt from the rollout's own bytes (reconstructReplayCursor).
 * Uncertainty is never resolved by skipping:
 *  - an import that is malformed, truncated, or not the expected session is
 *    REJECTED whole (no partial authority); the caller gets `hold`, meaning
 *    consume no bytes, keep the byte cursor where it is, and escalate,
 *    because falling back to ordinary ingestion from byte 0 is exactly the
 *    replay that duplicated jx7652s and jx7b88a;
 *  - a rollout line that is malformed or diverges from the import while the
 *    sequence is still being matched flips the cursor to `mismatch`
 *    permanently: that line and every later line are emitted, even ones that
 *    would have matched.
 *
 * Pure: no filesystem, no daemon state. The caller reads the import through
 * its bounded worker, feeds complete lines only (advanceReplayCursor carries
 * an incomplete trailing line for it), and honours the verdicts.
 */

export type ReplayVerdict = "skip" | "emit";

export interface ImportReplayAuthority {
  importSessionId: string;
  /** Fingerprints of the import's response_items, in file order. */
  fingerprints: string[];
}

export type ImportAuthorityRejection =
  | "empty"
  | "no_session_meta"
  | "wrong_session"
  | "malformed_line"
  | "unknown_line_type"
  | "truncated_tail";

/** Disposition for the caller when authority cannot be established: consume
 *  no bytes and keep the rollout's byte cursor unread until the import can be
 *  read whole and verified, or a human decides otherwise. Never ingest from
 *  byte 0 on this path. */
export interface ImportAuthorityHold {
  ok: false;
  disposition: "hold";
  reason: ImportAuthorityRejection;
  /** 1-based line number of the offending line, when there is one. */
  line?: number;
}

export type ImportAuthorityResult = { ok: true; authority: ImportReplayAuthority } | ImportAuthorityHold;

const ROLLOUT_LINE_TYPES = new Set(["session_meta", "response_item", "event_msg", "turn_context"]);

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

/** Read the WHOLE import file as the replay authority, or reject it whole.
 *  Rejected: empty; first line not a session_meta; session_meta id other than
 *  `importSessionId` (the file was replaced); any line that is not JSON or
 *  not a known rollout line type; a final line without its newline (the file
 *  was truncated mid-write). A shortened authority would let the replay's
 *  tail through as new messages, so there is no partial acceptance. */
export function readImportReplayAuthority(importJsonl: string, importSessionId: string): ImportAuthorityResult {
  if (importJsonl.length === 0) return { ok: false, disposition: "hold", reason: "empty" };
  if (!importJsonl.endsWith("\n")) return { ok: false, disposition: "hold", reason: "truncated_tail" };
  const lines = importJsonl.split("\n");
  lines.pop(); // the empty string after the final newline
  const fingerprints: string[] = [];
  let sawHead = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const parsed = parseLine(line);
    if (!parsed || typeof parsed.type !== "string") return { ok: false, disposition: "hold", reason: "malformed_line", line: i + 1 };
    if (!sawHead) {
      const headPayload = parsed.type === "session_meta" ? (parsed.payload as JsonRecord | undefined) : undefined;
      if (!headPayload) return { ok: false, disposition: "hold", reason: "no_session_meta", line: i + 1 };
      if (headPayload.id !== importSessionId) return { ok: false, disposition: "hold", reason: "wrong_session", line: i + 1 };
      sawHead = true;
      continue;
    }
    if (!ROLLOUT_LINE_TYPES.has(parsed.type)) return { ok: false, disposition: "hold", reason: "unknown_line_type", line: i + 1 };
    if (parsed.type !== "response_item") continue;
    const payload = parsed.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false, disposition: "hold", reason: "malformed_line", line: i + 1 };
    }
    fingerprints.push(responseItemFingerprint(payload as JsonRecord));
  }
  if (!sawHead) return { ok: false, disposition: "hold", reason: "empty" };
  return { ok: true, authority: { importSessionId, fingerprints } };
}

export function createReplayCursor(fingerprintCount: number): ReplayCursor {
  return { matched: 0, state: fingerprintCount === 0 ? "complete" : "replaying" };
}

/** Verdict for one COMPLETE rollout line. Mutates the cursor.
 *  `skip` only for a response_item proven equal to the import's next item.
 *  Anything malformed while matching ends matching for good. */
export function classifyRolloutLine(authority: ImportReplayAuthority, cursor: ReplayCursor, line: string): ReplayVerdict {
  if (cursor.state !== "replaying") return "emit";
  const parsed = parseLine(line);
  if (!parsed || typeof parsed.type !== "string") {
    cursor.state = "mismatch";
    return "emit";
  }
  if (parsed.type !== "response_item") return "emit";
  const payload = parsed.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    cursor.state = "mismatch";
    return "emit";
  }
  if (responseItemFingerprint(payload as JsonRecord) !== authority.fingerprints[cursor.matched]) {
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
