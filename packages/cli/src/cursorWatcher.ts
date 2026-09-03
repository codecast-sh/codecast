import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { Database } from "bun:sqlite";
import { timeSyncFs } from "./slowSync.js";

export interface CursorSessionEvent {
  sessionId: string;
  workspacePath: string;
  dbPath: string;
  eventType: "add" | "change";
}

export interface CursorWatcherEvents {
  session: (event: CursorSessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
  /** macOS revoked/denied access to Cursor's app data mid-run; polling stops. */
  denied: () => void;
}

export function defaultCursorPath(): string {
  const home = process.env.HOME || "";
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Cursor");
  } else if (process.platform === "linux") {
    return path.join(home, ".config", "Cursor");
  } else if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Cursor");
  }
  return path.join(home, ".cursor");
}

/** EPERM/EACCES from a read under another app's data dir is macOS App Data
 *  protection (TCC) saying no — not a transient fs error. */
export function isTccDeniedError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

/** One deliberate read of Cursor's workspace storage. On macOS with an
 *  undecided TCC state this is what raises the "access data from other apps"
 *  prompt — only call it when the user is in a consent flow (or access was
 *  already granted). Async on purpose: the syscall BLOCKS until the user
 *  answers the dialog, and the daemon's event loop (heartbeats, watchdog
 *  liveness) must keep running underneath it. */
export async function probeCursorAccess(cursorPath?: string): Promise<"ok" | "denied" | "missing"> {
  const storagePath = path.join(cursorPath || defaultCursorPath(), "User", "workspaceStorage");
  try {
    await fs.promises.readdir(storagePath);
    return "ok";
  } catch (err) {
    return isTccDeniedError(err) ? "denied" : "missing";
  }
}

/**
 * Whether the daemon may scan Cursor's app data at startup. On macOS the scan
 * is consent-gated: it runs only when the user enabled it (`cast cursor on`)
 * or a prior run recorded the grant — never as a surprise TCC prompt at login.
 * Off-macOS there is no TCC, so the watcher starts unless turned off.
 */
export function cursorWatcherDecision(input: {
  platform: NodeJS.Platform;
  pref?: "on" | "off";
  recordedAccess?: "granted" | "denied";
}): "start" | "skip" | "needs-consent" {
  if (input.pref === "off") return "skip";
  if (input.platform !== "darwin") return "start";
  if (input.pref === "on") return "start";
  if (input.recordedAccess === "granted") return "start";
  return "needs-consent";
}

export declare interface CursorWatcher {
  on<K extends keyof CursorWatcherEvents>(
    event: K,
    listener: CursorWatcherEvents[K]
  ): this;
  emit<K extends keyof CursorWatcherEvents>(
    event: K,
    ...args: Parameters<CursorWatcherEvents[K]>
  ): boolean;
}

interface WorkspaceState {
  lastRowId: number;
  lastCheck: number;
}

export class CursorWatcher extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private cursorPath: string;
  private workspaceStates: Map<string, WorkspaceState> = new Map();
  // Newest mtime of each workspace's state.vscdb (or its WAL) at the last
  // successful check. Opening a SQLite file and running two queries is real
  // I/O; doing it for every workspace every 2s pinned the loop whenever the
  // disk was busy. A file nobody wrote to since the last look cannot hold new
  // chat rows, so it is skipped on a stat alone.
  private dbMtimes: Map<string, number> = new Map();
  private pollFrequencyMs: number;
  private isFirstPoll: boolean = true;
  // Circuit breaker: suppress error logging for workspaces that fail repeatedly
  private workspaceErrorCounts: Map<string, number> = new Map();
  private static readonly ERROR_SUPPRESS_THRESHOLD = 3;

  constructor(cursorPath?: string, pollFrequencyMs: number = 2000) {
    super();
    this.cursorPath = cursorPath || this.detectCursorPath();
    this.pollFrequencyMs = pollFrequencyMs;
  }

  private detectCursorPath(): string {
    return defaultCursorPath();
  }

  start(): void {
    if (this.pollInterval) {
      return;
    }

    const workspaceStoragePath = path.join(
      this.cursorPath,
      "User",
      "workspaceStorage"
    );

    if (!fs.existsSync(workspaceStoragePath)) {
      return;
    }

    this.emit("ready");

    this.pollInterval = setInterval(() => {
      void this.pollWorkspaces(workspaceStoragePath);
    }, this.pollFrequencyMs);

    setImmediate(() => { void this.pollWorkspaces(workspaceStoragePath); });
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // A poll that is still running when the next tick fires is skipped, so a
  // slow disk makes polls sparser instead of stacking them.
  private pollInFlight = false;

  /** One pass over workspaceStorage: stat every workspace DB off the loop,
   *  open only the ones that moved. Public so a test can drive one pass. */
  async pollWorkspaces(workspaceStoragePath: string): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.pollWorkspacesOnce(workspaceStoragePath);
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollWorkspacesOnce(workspaceStoragePath: string): Promise<void> {
    try {
      const workspaceDirs = await fs.promises.readdir(workspaceStoragePath);
      if (this.isFirstPoll) {
        console.log(`[CursorWatcher] Found ${workspaceDirs.length} workspace directories`);
      }

      // Build list of workspaces with their db paths and mtimes. Stats are
      // batched so a machine with hundreds of workspaces does not serialize
      // two syscalls per workspace behind each other's latency.
      const workspaces: { hash: string; dbPath: string; mtime: number }[] = [];
      const statMtime = async (workspaceHash: string) => {
        const dbPath = path.join(workspaceStoragePath, workspaceHash, "state.vscdb");
        // A missing DB (ENOENT) skips the workspace; so does any other stat error.
        const main = await fs.promises.stat(dbPath).catch(() => null);
        if (!main) return;
        // In WAL mode a write lands in state.vscdb-wal first; the main file's
        // mtime only moves on checkpoint.
        const wal = await fs.promises.stat(`${dbPath}-wal`).catch(() => null);
        workspaces.push({ hash: workspaceHash, dbPath, mtime: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) });
      };
      const STAT_BATCH = 16;
      for (let i = 0; i < workspaceDirs.length; i += STAT_BATCH) {
        await Promise.all(workspaceDirs.slice(i, i + STAT_BATCH).map(statMtime));
      }

      // Sort by mtime descending (newest first) on first poll
      if (this.isFirstPoll) {
        workspaces.sort((a, b) => b.mtime - a.mtime);
        this.isFirstPoll = false;
      }

      for (const workspace of workspaces) {
        if (this.dbMtimes.get(workspace.hash) === workspace.mtime) continue;
        try {
          await this.checkWorkspaceForChanges(workspace.hash, workspace.dbPath);
          this.dbMtimes.set(workspace.hash, workspace.mtime);
          // Reset error count on success
          this.workspaceErrorCounts.delete(workspace.hash);
        } catch (err) {
          const count = (this.workspaceErrorCounts.get(workspace.hash) || 0) + 1;
          this.workspaceErrorCounts.set(workspace.hash, count);
          // Only emit errors until threshold, then suppress to avoid log flooding
          if (count <= CursorWatcher.ERROR_SUPPRESS_THRESHOLD) {
            const error = err instanceof Error ? err : new Error(String(err));
            const suffix = count === CursorWatcher.ERROR_SUPPRESS_THRESHOLD ? " (suppressing further errors for this workspace)" : "";
            this.emit("error", new Error(`Failed to check workspace ${workspace.hash}: ${error.message}${suffix}`));
          }
        }
      }
    } catch (err) {
      // Access revoked mid-run (System Settings toggle): stop polling instead
      // of failing every 2s, and let the daemon record the denial.
      if (isTccDeniedError(err)) {
        this.stop();
        this.emit("denied");
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }

  private async getWorkspaceFolderPath(workspaceStorageDir: string): Promise<string | null> {
    const workspaceJsonPath = path.join(workspaceStorageDir, "workspace.json");
    try {
      // A workspace without the file (ENOENT) has no folder to name.
      const content = await fs.promises.readFile(workspaceJsonPath, "utf-8");
      const data = JSON.parse(content);

      // workspace.json contains { "folder": "file:///path/to/folder" }
      // or { "workspace": "file:///path/to/workspace.code-workspace" }
      const folderUri = data.folder || data.workspace;
      if (!folderUri) {
        return null;
      }

      // Convert file:// URI to path
      if (folderUri.startsWith("file://")) {
        const decoded = decodeURIComponent(folderUri.slice(7));
        // On Windows, remove leading slash from /C:/path
        if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
          return decoded.slice(1);
        }
        return decoded;
      }

      return folderUri;
    } catch {
      return null;
    }
  }

  // bun:sqlite is synchronous, so the open plus two queries is the one block
  // of sync work this watcher keeps; it is timed under its own name so a slow
  // disk names the workspace DB, not the poll.
  private readChatMaxRowId(dbPath: string): number | null {
    return timeSyncFs("cursorWatcher.sqlite", dbPath, () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const tableExists = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
          )
          .get();
        if (!tableExists) return null;
        const maxRowIdResult = db
          .query<{ maxRowId: number | null }, []>(
            "SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'"
          )
          .get();
        return maxRowIdResult?.maxRowId ?? 0;
      } finally {
        db.close();
      }
    });
  }

  private async checkWorkspaceForChanges(workspaceHash: string, dbPath: string): Promise<void> {
    const maxRowId = this.readChatMaxRowId(dbPath);
    if (maxRowId === null) return;

    const state = this.workspaceStates.get(workspaceHash);
    const emitting = !state ? maxRowId > 0 : maxRowId > state.lastRowId;
    if (!state) {
      this.workspaceStates.set(workspaceHash, { lastRowId: maxRowId, lastCheck: Date.now() });
    } else if (emitting) {
      state.lastRowId = maxRowId;
      state.lastCheck = Date.now();
    }
    if (!emitting) return;

    // Get actual workspace folder path from workspace.json; only an emit needs it.
    const actualPath = (await this.getWorkspaceFolderPath(path.dirname(dbPath))) || workspaceHash;
    if (!state) {
      console.log(`[CursorWatcher] Emitting session for ${workspaceHash} (${actualPath}), maxRowId=${maxRowId}`);
    }
    this.emit("session", {
      sessionId: workspaceHash,
      workspacePath: actualPath,
      dbPath,
      eventType: state ? "change" : "add",
    });
  }
}
