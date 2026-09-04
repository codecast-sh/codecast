import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";
import { type WalkFile } from "./fsWalk.js";
import { isTestProjectDir, isWorkflowSnapshot, watchFilter, watchDirFilter } from "./syncScope.js";

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

export class SessionWatcher extends EventEmitter {
  private watcher: RecursiveWatcher | null = null;
  private projectsPath: string;

  constructor(projectsPath?: string) {
    super();
    this.projectsPath =
      projectsPath ||
      path.join(process.env.HOME || "", ".claude", "projects");
  }

  /** Resolves once the priming walk has emitted the existing recent files,
   *  so boot can order work after it. Callers that do not care may ignore
   *  the promise; the watch itself is live as soon as this returns. */
  start(): Promise<void> {
    if (this.watcher) {
      return this.watcher.whenPrimed();
    }

    if (!fs.existsSync(this.projectsPath)) {
      fs.mkdirSync(this.projectsPath, { recursive: true });
    }

    this.watcher = new RecursiveWatcher({
      path: this.projectsPath,
      filter: watchFilter,
      dirFilter: watchDirFilter,
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      onExisting: (files) => this.emitExistingFilesSorted(files),
      // Deep enough for workflow agent transcripts (6 segments); watchFilter keeps
      // the extra depth from matching anything else.
      maxDepth: 6,
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
    return this.watcher.whenPrimed();
  }

  whenPrimed(): Promise<void> {
    return this.watcher ? this.watcher.whenPrimed() : Promise.resolve();
  }

  // Files the watcher's priming walk found (one walk serves both), newest
  // first, limited to ones touched recently: the rest are already synced and
  // the watchdog's stale sweep covers any that are not.
  private emitExistingFilesSorted(files: WalkFile[]): void {
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
    const now = Date.now();
    const recentFiles = files.filter(f => now - f.stat.mtimeMs < RECENT_THRESHOLD_MS);
    recentFiles.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const file of recentFiles) {
      this.handleFileEvent(file.path, "add");
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
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
    filePath: string,
    eventType: "add" | "change"
  ): void {
    const relative = path.relative(this.projectsPath, filePath);
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
