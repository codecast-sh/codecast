// Read-only queries against opencode's SQLite store. Kept off opencodeStorage.ts
// so the poll worker can load this module without pulling the watcher, the
// position tracker, or EventEmitter onto the worker thread.
import * as fs from "fs";
import { Database } from "bun:sqlite";

export type OpencodeDelta = { globalMax: number; sessionIds: string[] };

/** Open the opencode DB read-only, or null if it doesn't exist yet. */
export function openOpencodeDb(dbPath: string): Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * One poll of the store: the global max(time_updated) across message/part/session,
 * plus every session id that advanced past `watermark`. Cheap on a warm cache;
 * mapping a multi-gigabyte file under memory pressure is what pins the daemon
 * loop, which is why the watcher runs this on a worker thread.
 */
export function queryOpencodeDelta(dbPath: string, watermark: number): OpencodeDelta {
  const db = openOpencodeDb(dbPath);
  if (!db) return { globalMax: 0, sessionIds: [] };
  try {
    const globalMax = db.query<{ mx: number | null }, []>(
      "SELECT MAX(mx) AS mx FROM (SELECT MAX(time_updated) mx FROM message UNION ALL SELECT MAX(time_updated) FROM part UNION ALL SELECT MAX(time_updated) FROM session)",
    ).get()?.mx ?? 0;
    if (globalMax <= watermark) return { globalMax, sessionIds: [] };
    const changed = db.query<{ sid: string }, [number, number, number]>(
      "SELECT DISTINCT sid FROM (" +
        "SELECT session_id AS sid, time_updated AS t FROM message WHERE time_updated > ?1 " +
        "UNION ALL SELECT session_id, time_updated FROM part WHERE time_updated > ?2 " +
        "UNION ALL SELECT id, time_updated FROM session WHERE time_updated > ?3)",
    ).all(watermark, watermark, watermark);
    return { globalMax, sessionIds: changed.map((row) => row.sid) };
  } finally {
    db.close();
  }
}
