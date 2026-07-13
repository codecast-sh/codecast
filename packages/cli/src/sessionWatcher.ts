import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";

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

export class SessionWatcher extends EventEmitter {
  private watcher: RecursiveWatcher | null = null;
  private projectsPath: string;

  constructor(projectsPath?: string) {
    super();
    this.projectsPath =
      projectsPath ||
      path.join(process.env.HOME || "", ".claude", "projects");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.projectsPath)) {
      fs.mkdirSync(this.projectsPath, { recursive: true });
    }

    this.emitExistingFilesSorted();

    this.watcher = new RecursiveWatcher({
      path: this.projectsPath,
      filter: watchFilter,
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      // Deep enough for workflow agent transcripts (6 segments); watchFilter keeps
      // the extra depth from matching anything else.
      maxDepth: 6,
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }

  private emitExistingFilesSorted(): void {
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
    const now = Date.now();

    const scanDir = (dir: string, depth: number) => {
      if (depth > 5) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (watchFilter(path.relative(this.projectsPath, fullPath))) {
            try {
              const fileStat = fs.statSync(fullPath);
              files.push({ path: fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    };

    try {
      scanDir(this.projectsPath, 0);
    } catch {
      return;
    }

    const recentFiles = files.filter(f => now - f.mtimeMs < RECENT_THRESHOLD_MS);
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

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
    this.start();
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
