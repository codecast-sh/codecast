import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

export interface SessionEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
  projectPath: string;
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

export class SessionWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
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

    // Scan existing files
    this.emitExistingFilesSorted();

    this.watcher = watch(this.projectsPath, {
      persistent: true,
      ignoreInitial: true, // We handle initial files ourselves for sorting
      depth: 2, // Main sessions only (projects/<hash>/<session>.jsonl) - subagents not needed
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("add", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        this.handleFileEvent(filePath, "add");
      }
    });

    this.watcher.on("change", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        this.handleFileEvent(filePath, "change");
      }
    });

    this.watcher.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    });

    this.watcher.on("ready", () => {
      this.emit("ready");
    });
  }

  private emitExistingFilesSorted(): void {
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    // Recursively scan for .jsonl files up to depth 2 (main sessions only)
    const scanDir = (dir: string, depth: number) => {
      if (depth > 2) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.name.endsWith(".jsonl")) {
            try {
              const fileStat = fs.statSync(fullPath);
              files.push({ path: fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
            } catch {
              // Skip files we can't stat
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    try {
      scanDir(this.projectsPath, 0);
    } catch {
      // Directory doesn't exist or can't be read
      return;
    }

    // Only emit recently modified files on startup - watchdog handles older files
    const recentFiles = files.filter(f => now - f.mtimeMs < RECENT_THRESHOLD_MS);

    // Sort recent files by mtime descending (most recent first)
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Only emit recent files to avoid flooding the API on startup
    for (const file of recentFiles) {
      this.handleFileEvent(file.path, "add");
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private handleFileEvent(filePath: string, eventType: "add" | "change"): void {
    const sessionId = this.extractSessionId(filePath);
    const projectPath = this.extractProjectPath(filePath);
    this.emit("session", { sessionId, filePath, eventType, projectPath });
  }

  private extractSessionId(filePath: string): string {
    return path.basename(filePath, ".jsonl");
  }

  private extractProjectPath(filePath: string): string {
    const parentDir = path.basename(path.dirname(filePath));
    return parentDir.replace(/-/g, "/");
  }
}
