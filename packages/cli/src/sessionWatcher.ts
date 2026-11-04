import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";
import { type WalkFile } from "./fsWalk.js";
import { isTestProjectDir, isWorkflowSnapshot, watchFilter, watchDirFilter } from "./syncScope.js";
import { claudeProjectsDirs } from "./claudeConfigDirs.js";

export interface SessionEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
  projectPath: string;
  // Set when filePath is a dynamic-workflow run snapshot; sessionId is then the HOST session.
  workflowRunId?: string;
}

export interface SessionWatcherEvents {
  session: (event: SessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface SessionWatcher {
  on<K extends keyof SessionWatcherEvents>(
    event: K,
    listener: SessionWatcherEvents[K]
  ): this;
  emit<K extends keyof SessionWatcherEvents>(
    event: K,
    ...args: Parameters<SessionWatcherEvents[K]>
  ): boolean;
}

// The file-shape rules live in syncScope.ts so the startup and wake sweeps,
// reconciliation and `cast status` judge a path exactly as this watcher does.
export { isTestProjectDir, isWorkflowSnapshot, isWorkflowAgentTranscript, watchFilter, watchDirFilter } from "./syncScope.js";

// One recursive watch per Claude config dir's projects tree (claudeConfigDirs.ts):
// ~/.claude/projects, plus every CLAUDE_CONFIG_DIR a person runs Claude Code
// under. With no explicit roots, each start() asks again, so a config dir that
// appears later is picked up by the next restart.
export class SessionWatcher extends EventEmitter {
  private watchers: { root: string; watcher: RecursiveWatcher }[] = [];
  private fixedRoots: string[] | null;

  constructor(projectsPath?: string | string[]) {
    super();
    this.fixedRoots = projectsPath === undefined ? null : Array.isArray(projectsPath) ? projectsPath : [projectsPath];
  }

  /** The projects dirs this watcher covers (or would cover on start). */
  roots(): string[] {
    return this.watchers.length > 0 ? this.watchers.map((w) => w.root) : this.fixedRoots ?? claudeProjectsDirs();
  }

  /** Resolves once the priming walk has emitted the existing recent files,
   *  so boot can order work after it. Callers that do not care may ignore
   *  the promise; the watch itself is live as soon as this returns. */
  start(): Promise<void> {
    if (this.watchers.length > 0) {
      return this.whenPrimed();
    }

    for (const root of this.fixedRoots ?? claudeProjectsDirs()) {
      try {
        if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
      } catch (err) {
        this.emit("error", err as Error);
        continue;
      }
      const entry: { root: string; watcher: RecursiveWatcher } = { root, watcher: null as unknown as RecursiveWatcher };
      entry.watcher = new RecursiveWatcher({
        path: root,
        scanPolicy: { dirs: "claudeWatch", files: "claudeWatch" },
        filter: watchFilter,
        dirFilter: watchDirFilter,
        callback: (filePath, eventType) => { if (eventType !== "unlink") this.handleFileEvent(root, filePath, eventType); },
        onExisting: (files) => this.emitExistingFilesSorted(entry, files),
        // Deep enough for workflow agent transcripts (6 segments); watchFilter keeps
        // the extra depth from matching anything else.
        maxDepth: 6,
        debounceMs: 100,
      });
      entry.watcher.on("error", (err: Error) => this.emit("error", err));
      this.watchers.push(entry);
    }

    // One "ready" for the whole set, once every root's watch is up.
    let pending = this.watchers.length;
    for (const { watcher } of this.watchers) {
      watcher.on("ready", () => { if (--pending === 0) this.emit("ready"); });
      watcher.start();
    }
    return this.whenPrimed();
  }

  whenPrimed(): Promise<void> {
    return Promise.all(this.watchers.map((w) => w.watcher.whenPrimed())).then(() => {});
  }

  // Files the watcher's priming walk found (one walk serves both), newest
  // first, limited to ones touched recently: the rest are already synced and
  // the watchdog's stale sweep covers any that are not.
  private async emitExistingFilesSorted(entry: { root: string; watcher: RecursiveWatcher }, files: WalkFile[]): Promise<void> {
    const watcher = entry.watcher;
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
    const now = Date.now();
    const recentFiles = files.filter(f => now - f.stat.mtimeMs < RECENT_THRESHOLD_MS);
    recentFiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (let i = 0; i < recentFiles.length; i++) {
      if (i % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      if (!this.watchers.some((w) => w.watcher === watcher)) return;
      const file = recentFiles[i];
      this.handleFileEvent(entry.root, file.path, "add");
    }
  }

  stop(): void {
    for (const { watcher } of this.watchers) watcher.stop();
    this.watchers = [];
  }

  async restart(): Promise<void> {
    this.stop();
    // Yield before re-opening: bun's native File Watcher thread holds an
    // os_unfair_lock during fs.watch teardown, and a back-to-back close→open
    // on the same path can deadlock the main thread against that worker.
    // (Observed: daemon froze for 27h on wake-from-sleep with both threads
    // wedged on __ulock_wait2.)
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Not awaited: the watchdog races this restart against a 10s timeout, and
    // priming on a contended disk can outlast that. The watch is live here;
    // whenPrimed() is there for anyone who needs the walk to have finished.
    void this.start();
  }

  private handleFileEvent(
    root: string,
    filePath: string,
    eventType: "add" | "change"
  ): void {
    const relative = path.relative(root, filePath);
    const parts = relative.split(path.sep);
    if (parts.length < 2) return;

    const projectDirName = parts[0];
    if (isTestProjectDir(projectDirName)) return;
    const fileName = parts[parts.length - 1];

    // Workflow run snapshot: attribute to the HOST session (parts[1]) and carry the runId.
    if (isWorkflowSnapshot(relative)) {
      this.emit("session", {
        sessionId: parts[1],
        filePath,
        eventType,
        projectPath: projectDirName,
        workflowRunId: fileName.replace(".json", ""),
      });
      return;
    }

    const sessionId = fileName.replace(".jsonl", "");

    this.emit("session", {
      sessionId,
      filePath,
      eventType,
      projectPath: projectDirName,
    });
  }
}
