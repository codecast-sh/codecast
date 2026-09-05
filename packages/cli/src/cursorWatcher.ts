import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { daemonWorkersEnabled } from "./workers/bridge.js";
import { collectScan, yieldScanBatch } from "./workers/scanClient.js";
import type { ScanJob, ScanRow } from "./workers/scanTypes.js";

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
  private dbMtimes: Map<string, string> = new Map();
  private generation = 0;
  private pollRoot = "";
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

    this.generation++;
    this.emit("ready");

    this.pollInterval = setInterval(() => {
      void this.pollWorkspaces(workspaceStoragePath);
    }, this.pollFrequencyMs);

    setImmediate(() => { void this.pollWorkspaces(workspaceStoragePath); });
  }

  stop(): void {
    this.generation++;
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
    if (this.pollRoot !== workspaceStoragePath) {
      this.pollRoot = workspaceStoragePath;
      this.generation++;
      this.dbMtimes.clear();
      this.workspaceStates.clear();
      this.workspaceErrorCounts.clear();
      this.isFirstPoll = true;
    }
    const generation = this.generation, home = process.env.HOME;
    const current = () => generation === this.generation && home === process.env.HOME && this.pollRoot === workspaceStoragePath;
    try {
      const rows = await this.readCursorRows({ name: "cursorWorkspaces", root: workspaceStoragePath });
      if (!current()) return;
      const rootError = rows.find(row => row.type === "cursorError" && row.path === workspaceStoragePath);
      if (rootError?.type === "cursorError") throw Object.assign(new Error(rootError.message), { code: rootError.code });
      const workspaces = rows.filter((row): row is Extract<ScanRow, {type:"cursorWorkspaceDb"}> => row.type === "cursorWorkspaceDb");
      const present = new Set(workspaces.map(row => row.path));
      for (const key of this.dbMtimes.keys()) if (!present.has(key)) this.dbMtimes.delete(key);
      if (this.isFirstPoll) {
        workspaces.sort((a, b) => b.mtimeMs - a.mtimeMs);
        this.isFirstPoll = false;
      }
      for (const row of rows) if (row.type === "cursorError") this.workspaceReadError(path.basename(path.dirname(row.path)), new Error(row.message));
      const changed = workspaces.filter(row => this.dbMtimes.get(row.path) !== row.identity);
      for (let i = 0; i < changed.length; i += 128) {
        const batch = changed.slice(i, i + 128);
        const observations = await this.readCursorRows({ name: "cursorDatabases", paths: batch.map(row => row.path) });
        if (!current()) return;
        for (const workspace of batch) {
          const hash = path.basename(path.dirname(workspace.path));
          const observation = observations.find(row => (row.type === "cursorDb" || row.type === "cursorError") && row.path === workspace.path);
          if (observation?.type !== "cursorDb") {
            this.workspaceReadError(hash, new Error(observation?.type === "cursorError" ? observation.message : "Cursor observation missing"));
            continue;
          }
          this.checkWorkspaceForChanges(hash, observation);
          if (!current()) return;
          this.dbMtimes.set(workspace.path, workspace.identity);
          this.workspaceErrorCounts.delete(hash);
        }
        await yieldScanBatch();
        if (!current()) return;
      }
    } catch (err) {
      if (!current()) return;
      if (isTccDeniedError(err)) {
        this.stop();
        this.emit("denied");
        return;
      }
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private async readCursorRows(job: ScanJob): Promise<ScanRow[]> {
    if (daemonWorkersEnabled()) return collectScan(job);
    const { scanPages } = await import("./workers/scanJobs.js");
    const rows: ScanRow[] = [];
    for await (const page of scanPages(job)) { rows.push(...page); await yieldScanBatch(); }
    return rows;
  }

  private workspaceReadError(hash: string, error: Error): void {
    const count = (this.workspaceErrorCounts.get(hash) || 0) + 1;
    this.workspaceErrorCounts.set(hash, count);
    if (count <= CursorWatcher.ERROR_SUPPRESS_THRESHOLD) {
      const suffix = count === CursorWatcher.ERROR_SUPPRESS_THRESHOLD ? " (suppressing further errors for this workspace)" : "";
      this.emit("error", new Error(`Failed to check workspace ${hash}: ${error.message}${suffix}`));
    }
  }

  private checkWorkspaceForChanges(workspaceHash: string, observation: Extract<ScanRow, {type:"cursorDb"}>): void {
    const {maxRowId, path: dbPath} = observation;
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

    const actualPath = observation.workspacePath || workspaceHash;
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
