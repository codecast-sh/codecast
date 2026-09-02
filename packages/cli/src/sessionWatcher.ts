import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";
import type { WalkFile } from "./fsWalk.js";

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

// Marker substrings produced by the test harness (`messagingHarness.ts` →
// `codecast-test-cwd-`, `fakeClaudeShim.ts` → `codecast-fake-claude-`).
// These tmpdirs end up under ~/.claude/projects/<encoded-cwd>/ when tests
// run, and without filtering the daemon would upload them to the user's
// production Convex inbox. Tests that need a real session-watcher event
// loop should pick a neutral project dir name.
const TEST_PROJECT_MARKERS = ["codecast-test-cwd-", "codecast-fake-claude-"];

export function isTestProjectDir(projectDirName: string): boolean {
  return TEST_PROJECT_MARKERS.some(m => projectDirName.includes(m));
}

// Dynamic-workflow run snapshot: <projectDir>/<session>/workflows/wf_<id>.json
// (the runtime materializes the whole run here; the daemon ingests it for the dash).
export function isWorkflowSnapshot(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (parts.length < 2) return false;
  const base = parts[parts.length - 1];
  return parts[parts.length - 2] === "workflows"
    && parts[parts.length - 3] !== "subagents"
    && /^wf_.*\.json$/.test(base);
}

// Dynamic-workflow per-agent transcript:
// <projectDir>/<session>/subagents/workflows/<wf_runId>/agent-<id>.jsonl
// These sync as regular subagent conversations (session_id = filename base), which is
// what makes workflow agent sessions clickable in the run UI. Matched explicitly —
// NOT via the generic .jsonl rule — so raising the watch depth doesn't sweep in other
// deep files (e.g. the runtime's journal.jsonl alongside them).
export function isWorkflowAgentTranscript(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return parts.length === 6
    && parts[2] === "subagents"
    && parts[3] === "workflows"
    && /^agent-.+\.jsonl$/.test(parts[5]);
}

// Single source of truth for what the watcher (and the priming scan) considers a
// syncable file. Plain .jsonl matching keeps its historical depth (session transcripts
// and Task-tool subagents, <= 4 segments); deeper paths must match a specific shape.
export function watchFilter(relativePath: string): boolean {
  const depth = relativePath.split(path.sep).length;
  return (relativePath.endsWith(".jsonl") && depth <= 4)
    || isWorkflowSnapshot(relativePath)
    || isWorkflowAgentTranscript(relativePath);
}

const SESSION_DIR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whether the walk should enter a directory: only one that can hold a file
// watchFilter accepts. Without this the priming walk and every rescan read
// each session's tool-results, memory, session-memory and checkpoint dirs
// (1510 tool-results dirs on one machine, 3696 dirs walked for 2074 useful)
// and merely discarded what they found.
//   <slug>/                                   any project
//   <slug>/<uuid>/                            a session's own dir
//   <slug>/<uuid>/subagents|workflows/        Task subagents, run snapshots
//   <slug>/<uuid>/subagents/workflows/wf_*/   workflow agent transcripts
export function watchDirFilter(relativeDirPath: string): boolean {
  const parts = relativeDirPath.split(path.sep);
  switch (parts.length) {
    case 1: return true;
    case 2: return SESSION_DIR_UUID_RE.test(parts[1]);
    case 3: return parts[2] === "subagents" || parts[2] === "workflows";
    case 4: return parts[2] === "subagents" && parts[3] === "workflows";
    case 5: return parts[2] === "subagents" && parts[3] === "workflows" && parts[4].startsWith("wf_");
    default: return false;
  }
}

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
