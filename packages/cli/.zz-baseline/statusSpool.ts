// The append-only spool the status hook falls back to when the daemon's
// loopback handler is unreachable (a restart, a port change, the boot window
// before the handler registers).
//
// It replaces a fallback that wrote ONE file per session holding only the
// latest status: a burst during a restart collapsed to its last entry, so a
// Stop that arrived before a later event simply vanished and the session sat
// "working" until a transcript read caught it (ct-49531). Here every event
// lands on its own line, the daemon replays the file in order and truncates
// behind itself.
//
// The legacy `<session>.json` is still written and still read for one release,
// so a daemon from before the spool keeps working and a hook script from
// before it still reports the latest status.
import * as fs from "node:fs";
import * as path from "node:path";

export const SPOOL_EXT = ".jsonl";
// Retention. A spool is drained on every watcher event and at boot, so a file
// still holding bytes days later belongs to a session nobody is running.
export const SPOOL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Growth cap, ~50k events for one session. Enforced by the daemon's sweep
// rather than by the hook: bash has no builtin that reads a file size, and an
// extra process per hook event is what blew Claude Code's hook timeout and lost
// turn starts before (see the note atop statusHook.ts).
export const SPOOL_MAX_BYTES = 5 * 1024 * 1024;

// PreToolUse fires once per tool call and maps to "working" — the highest
// frequency event the hook emits, and the one a long turn would otherwise fill
// the spool with. The legacy single-status file still carries the latest one,
// so keeping tool progress out of the ordered history loses nothing.
export const SPOOL_SKIPPED_STATUS = "working";
export function isSpoolableStatus(status: string): boolean {
  return status !== SPOOL_SKIPPED_STATUS;
}

// A session id that is safe to use as a file name inside the agent-status
// directory. The leading character cannot be a dot, so no id can name a parent
// directory, and no separator is allowed, so no id can leave the directory at
// all. Real ids are uuids, so this rejects nothing a real caller sends. Both
// the legacy file and the spool derive a path from the id, which is why the
// check lives here and daemon.ts re-exports it.
const SAFE_STATUS_SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
export function isSafeStatusSessionId(sessionId: string): boolean {
  return SAFE_STATUS_SESSION_ID.test(sessionId);
}

export function statusSpoolPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}${SPOOL_EXT}`);
}

/** One record, one line. Ordered against every other writer by the caller. */
export async function appendStatusSpool(dir: string, sessionId: string, record: unknown): Promise<void> {
  if (!isSafeStatusSessionId(sessionId)) return;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(statusSpoolPath(dir, sessionId), `${JSON.stringify(record)}\n`);
}

/**
 * Every complete record in one session's spool, oldest first, with the bytes
 * read removed from the file. A half-written trailing line is left in place for
 * the next drain, and a line that does not parse is skipped rather than ending
 * the replay — one corrupt record must not strand the Stop behind it.
 */
export async function drainStatusSpool<T>(filePath: string): Promise<T[]> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch {
    return [];
  }
  const consumed = buf.lastIndexOf(0x0a) + 1;
  if (consumed === 0) return [];

  const records: T[] = [];
  for (const line of buf.subarray(0, consumed).toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {}
  }

  // Rewrite the tail rather than emptying the file: an append that landed while
  // this drain was reading is a status nobody has seen yet.
  try {
    const current = await fs.promises.readFile(filePath);
    await fs.promises.writeFile(filePath, current.subarray(consumed));
  } catch {}
  return records;
}

export async function listStatusSpools(dir: string): Promise<Array<{ sessionId: string; filePath: string }>> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(SPOOL_EXT))
    .sort()
    .map((name) => ({ sessionId: name.slice(0, -SPOOL_EXT.length), filePath: path.join(dir, name) }));
}

/** Every session's spool, each drained in write order. */
export async function drainAllStatusSpools<T>(dir: string): Promise<Array<{ sessionId: string; records: T[] }>> {
  const out: Array<{ sessionId: string; records: T[] }> = [];
  for (const { sessionId, filePath } of await listStatusSpools(dir)) {
    const records = await drainStatusSpool<T>(filePath);
    if (records.length) out.push({ sessionId, records });
  }
  return out;
}

/**
 * Retention pass: drop a spool nothing has written to in SPOOL_TTL_MS, and cut
 * an oversized one back to its newest SPOOL_MAX_BYTES on a line boundary. The
 * newest end is what a replay still cares about, so overflow drops the oldest.
 */
export async function sweepStatusSpools(
  dir: string,
  now = Date.now(),
): Promise<{ removed: string[]; trimmed: string[] }> {
  const removed: string[] = [];
  const trimmed: string[] = [];
  for (const { sessionId, filePath } of await listStatusSpools(dir)) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > SPOOL_TTL_MS) {
        await fs.promises.unlink(filePath);
        removed.push(sessionId);
        continue;
      }
      if (stat.size <= SPOOL_MAX_BYTES) continue;
      const buf = await fs.promises.readFile(filePath);
      const tail = buf.subarray(buf.length - SPOOL_MAX_BYTES);
      // The cut lands mid-record, so the kept bytes start after the first
      // newline in the tail — and hold nothing at all if there is none.
      const nl = tail.indexOf(0x0a);
      await fs.promises.writeFile(filePath, nl < 0 ? Buffer.alloc(0) : tail.subarray(nl + 1));
      trimmed.push(sessionId);
    } catch {}
  }
  return { removed, trimmed };
}
