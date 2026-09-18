import * as fs from "node:fs";

// When did an agent last actually do something in its transcript?
//
// File mtime is not that answer. Something rewrites mtime on transcripts with
// no new content: on 2026-09-17, 161 Claude transcripts carried an mtime under
// an hour old while their newest line was 18 to 37 hours old, and the terminal
// reaper read every one of them as "active" and reaped nothing. The newest
// timestamp written INTO the file is the honest clock.
//
// mtime still answers one direction for free: content cannot be newer than the
// last write, so an old mtime proves the transcript is old. Only a fresh mtime
// is ambiguous, and only then does a caller need to read the tail. That keeps
// the common case (a transcript untouched for days) at one stat.

/**
 * The newest timestamp on any line of a JSONL tail, in epoch ms, or null when
 * no line carries one. Any line counts, meta and hook records included: a gate
 * that may kill a terminal should see every sign of life, not only chat turns.
 * Claude and codex write ISO strings; grok writes epoch seconds.
 */
export function newestLineTimestampMs(tail: string): number | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes("timestamp")) continue;
    let d: { timestamp?: unknown };
    try {
      d = JSON.parse(line);
    } catch {
      continue; // a partial line mid-write, or the tail's cut first line
    }
    const ms = timestampMs(d.timestamp);
    if (ms !== null) return ms;
  }
  return null;
}

function timestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** True when mtime alone cannot settle "idle for at least windowMs". */
export function mtimeNeedsContentCheck(mtimeMs: number, windowMs: number, now: number): boolean {
  return now - mtimeMs < windowMs;
}

/**
 * The time of the transcript's last real activity. `tail` is null when the
 * caller did not read it (mtime was already old enough) or could not.
 * Never later than mtime, so a skewed clock inside the file cannot make an old
 * transcript look fresh.
 */
export function transcriptActivityMs(mtimeMs: number, tail: string | null): number {
  if (tail === null) return mtimeMs;
  const ts = newestLineTimestampMs(tail);
  return ts === null ? mtimeMs : Math.min(mtimeMs, ts);
}

// Reads the last ~64KB of a file as UTF-8 without loading the whole thing --
// transcripts run to MBs and this is called per-session on every heartbeat.
export function readFileTailSync(filePath: string, maxBytes = 64 * 1024): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const { start, len } = tailRange(size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function tailRange(size: number, maxBytes: number): { start: number; len: number } {
  const start = Math.max(0, size - maxBytes);
  return { start, len: size - start };
}

// The promise twin of readFileTailSync, for the hook path: a settle and a
// permission prompt each read a transcript tail, and the hook server runs on
// the daemon's loop.
export async function readFileTailAsync(filePath: string, maxBytes = 64 * 1024): Promise<string> {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    const { start, len } = tailRange(size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}
