// OpenCode's transcript store. Current opencode (v1.2.0+; verified on v1.18.3)
// keeps everything in a single SQLite database at ~/.local/share/opencode/opencode.db
// (WAL mode), NOT the legacy storage/ JSON tree older builds used. The relevant
// tables:
//
//   session(id, project_id, directory, title, version, time_created, time_updated, …)
//   message(id, session_id, time_created, time_updated, data)   -- data = message JSON
//   part(id, message_id, session_id, time_created, time_updated, data)  -- data = part JSON
//
// message.data / part.data hold the exact JSON opencode used to write to msg_*.json /
// prt_*.json (minus the id, which is the row's primary key). So this module reads the
// DB and re-assembles a session into the same shape `opencode export <id>` emits —
// { info, messages: [{ info, parts }] } — which parseOpencodeSessionFile consumes.
// The daemon reads read-only; opencode owns the file. Modeled on cursorWatcher.ts
// (bun:sqlite, readonly open, poll + watermark, per-poll open/close, circuit breaker).
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { Database } from "bun:sqlite";
import {
  type TranscriptDirEvent,
  type TranscriptDirWatcherEvents,
  type DirEventWatcher,
} from "./transcriptDirWatcher.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";

/** Absolute path to opencode's SQLite store, from the registry descriptor. */
export function opencodeDbPath(): string {
  const root = AGENT_CLIENTS.opencode.transcriptRoots[0];
  return root.startsWith("~/") ? path.join(process.env.HOME || "", root.slice(2)) : root;
}

/** Open the opencode DB read-only, or null if it doesn't exist yet (opencode not
 *  installed / never run). Read-only + WAL means the daemon never blocks opencode. */
function openDb(dbPath: string): Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

interface SessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  version: string | null;
  project_id: string | null;
  slug: string | null;
  time_created: number;
  time_updated: number;
}

/** True when a session exists in the opencode DB — the existence check
 *  findSessionFile uses to claim a `ses_*` id as opencode's. */
export function sessionExistsInOpencodeDb(sessionId: string, dbPath: string = opencodeDbPath()): boolean {
  const db = openDb(dbPath);
  if (!db) return false;
  try {
    return db.query("SELECT 1 FROM session WHERE id = ? LIMIT 1").get(sessionId) != null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** The cwd an opencode session ran in — used to bind a freshly launched session to
 *  its pending started-tmux conversation (matchStartedConversation's cwd fallback).
 *  The DB's session.directory is the authoritative, NOT-NULL cwd. */
export function resolveOpencodeSessionCwd(sessionId: string, dbPath: string = opencodeDbPath()): string | undefined {
  const db = openDb(dbPath);
  if (!db) return undefined;
  try {
    const row = db.query<{ directory: string | null }, [string]>(
      "SELECT directory FROM session WHERE id = ?",
    ).get(sessionId);
    return row?.directory ?? undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * Assemble a whole opencode session from the DB into the `opencode export` JSON
 * shape ({ info, messages: [{ info, parts }] }) as a string, or null if the session
 * has no readable messages. This is the read boundary parseTranscriptFor("opencode",
 * …) consumes: the SQL rows are stitched here, the parser stays a pure
 * string→ParsedMessage[] function. The row id (primary key) is injected back into
 * each message/part object, since opencode stores it as the column, not inside `data`.
 */
export function assembleOpencodeSession(sessionId: string, dbPath: string = opencodeDbPath()): string | null {
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const session = db.query<SessionRow, [string]>(
      "SELECT id, directory, title, version, project_id, slug, time_created, time_updated FROM session WHERE id = ?",
    ).get(sessionId);
    if (!session) return null;

    const messageRows = db.query<{ id: string; data: string }, [string]>(
      "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
    ).all(sessionId);
    if (messageRows.length === 0) return null;

    const partRows = db.query<{ message_id: string; id: string; data: string }, [string]>(
      "SELECT message_id, id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
    ).all(sessionId);
    const partsByMessage = new Map<string, unknown[]>();
    for (const row of partRows) {
      let part: Record<string, unknown>;
      try { part = JSON.parse(row.data); } catch { continue; }
      part.id = row.id; // id is the column, not in data
      let list = partsByMessage.get(row.message_id);
      if (!list) { list = []; partsByMessage.set(row.message_id, list); }
      list.push(part);
    }

    const messages: { info: unknown; parts: unknown[] }[] = [];
    for (const row of messageRows) {
      let info: Record<string, unknown>;
      try { info = JSON.parse(row.data); } catch { continue; }
      info.id = row.id;
      messages.push({ info, parts: partsByMessage.get(row.id) ?? [] });
    }
    if (messages.length === 0) return null;

    const info = {
      id: session.id,
      title: session.title ?? undefined,
      directory: session.directory ?? undefined,
      version: session.version ?? undefined,
      projectID: session.project_id ?? undefined,
      slug: session.slug ?? undefined,
      time: { created: session.time_created, updated: session.time_updated },
    };
    return JSON.stringify({ info, messages });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The session's title straight from the DB row (cheaper than assembling), for the
 *  title-sync path. */
export function readOpencodeSessionTitle(sessionId: string, dbPath: string = opencodeDbPath()): string | undefined {
  const db = openDb(dbPath);
  if (!db) return undefined;
  try {
    const row = db.query<{ title: string | null }, [string]>(
      "SELECT title FROM session WHERE id = ?",
    ).get(sessionId);
    return row?.title ?? undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export declare interface OpencodeStorageWatcher {
  on<K extends keyof TranscriptDirWatcherEvents>(event: K, listener: TranscriptDirWatcherEvents[K]): this;
  emit<K extends keyof TranscriptDirWatcherEvents>(event: K, ...args: Parameters<TranscriptDirWatcherEvents[K]>): boolean;
}

/**
 * Polls the opencode SQLite store and emits one `session` event per session whose
 * message/part/session rows advanced past a `time_updated` watermark — a single
 * global max across the three tables, because session.time_updated alone is
 * insufficient (a message can be written after its session row updates, verified on
 * real rows). Cheap when idle: a stat of the db + -wal file gates the query, so an
 * unchanged store costs only two stats. Structurally mirrors cursorWatcher (readonly
 * open, poll interval, per-poll open/close, error circuit-breaker).
 *
 * The watermark PERSISTS across daemon restarts via positionTracker (getPosition/
 * setPosition, keyed by the db path — a real file, so the store's dead-key prune
 * keeps it). This closes the catch-up gap a silent first-poll prime would leave: a
 * session that runs start-to-finish while the daemon is down advances the DB past
 * the persisted watermark, so the next daemon start emits it and it syncs. The
 * first-EVER run (no persisted watermark → 0) emits every existing session once, a
 * one-time backfill that matches TranscriptDirWatcher/cursorWatcher's first-sight
 * behavior; the persisted watermark then makes every subsequent restart cost only
 * the delta (sessions changed since we last ran) rather than re-emitting the whole
 * DB — the concern the aggregated single-file store would otherwise raise, since
 * re-emitting an already-synced session, while a downstream no-op (addMessages
 * upserts by uuid → indexed read, zero writes), is still O(total history) per
 * restart when every session lives in one DB.
 *
 * `filePath` on the event is set to the session id so the daemon's registration seam
 * debounces per session (its InvalidateSync map keys on filePath); processOpencode-
 * Session reads only event.sessionId and re-assembles the whole session each pass, so
 * a session missed at the exact watermark ms self-heals on its next write.
 */
export class OpencodeStorageWatcher extends EventEmitter implements DirEventWatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private dbPath: string;
  private pollMs: number;
  private watermark = 0;
  private lastMtime = 0;
  private errorCount = 0;
  private static readonly ERROR_SUPPRESS_THRESHOLD = 3;

  constructor(dbPath: string = opencodeDbPath(), pollMs = 2000) {
    super();
    this.dbPath = dbPath;
    this.pollMs = pollMs;
  }

  start(): void {
    if (this.pollTimer) return;
    // Resume from where the previous daemon left off. 0 on the first-ever run, which
    // makes the first poll emit every existing session (`time_updated > 0`) — the
    // one-time backfill; thereafter this is the last persisted high-water mark.
    this.watermark = getPosition(this.dbPath);
    this.emit("ready");
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    setImmediate(() => this.poll());
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Max mtime across the db and its -wal sidecar; 0 if the db is absent. WAL writes
   *  land in -wal before a checkpoint, so both must be checked. */
  private storeMtime(): number {
    let m = 0;
    for (const p of [this.dbPath, this.dbPath + "-wal"]) {
      try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {}
    }
    return m;
  }

  private poll(): void {
    const mtime = this.storeMtime();
    if (mtime === 0) return; // no db yet
    // Skip the query when the store hasn't been touched since the last poll — but
    // never skip the FIRST poll of this run (lastMtime 0), which must reconcile the
    // persisted watermark against whatever changed while the daemon was down.
    if (this.lastMtime !== 0 && mtime === this.lastMtime) return;
    this.lastMtime = mtime;

    const db = openDb(this.dbPath);
    if (!db) return;
    try {
      const globalMax = db.query<{ mx: number | null }, []>(
        "SELECT MAX(mx) AS mx FROM (SELECT MAX(time_updated) mx FROM message UNION ALL SELECT MAX(time_updated) FROM part UNION ALL SELECT MAX(time_updated) FROM session)",
      ).get()?.mx ?? 0;

      if (globalMax <= this.watermark) return;

      const changed = db.query<{ sid: string }, [number, number, number]>(
        "SELECT DISTINCT sid FROM (" +
          "SELECT session_id AS sid, time_updated AS t FROM message WHERE time_updated > ?1 " +
          "UNION ALL SELECT session_id, time_updated FROM part WHERE time_updated > ?2 " +
          "UNION ALL SELECT id, time_updated FROM session WHERE time_updated > ?3)",
      ).all(this.watermark, this.watermark, this.watermark);

      this.watermark = globalMax;
      setPosition(this.dbPath, globalMax); // survive a restart at this high-water mark
      this.errorCount = 0;
      for (const { sid } of changed) {
        if (typeof sid === "string" && sid.startsWith("ses_")) this.emitSession(sid);
      }
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= OpencodeStorageWatcher.ERROR_SUPPRESS_THRESHOLD) {
        const suffix = this.errorCount === OpencodeStorageWatcher.ERROR_SUPPRESS_THRESHOLD ? " (suppressing further errors)" : "";
        this.emit("error", new Error(`opencode DB poll failed: ${err instanceof Error ? err.message : String(err)}${suffix}`));
      }
    } finally {
      db.close();
    }
  }

  private emitSession(sessionId: string): void {
    const event: TranscriptDirEvent = { sessionId, filePath: sessionId, eventType: "change" };
    this.emit("session", event);
  }
}
