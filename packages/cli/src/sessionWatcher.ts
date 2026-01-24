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
      depth: 2,
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

    try {
      const projectDirs = fs.readdirSync(this.projectsPath);
      for (const projectDir of projectDirs) {
        const projectPath = path.join(this.projectsPath, projectDir);
        try {
          const stat = fs.statSync(projectPath);
          if (!stat.isDirectory()) continue;

          const sessionFiles = fs.readdirSync(projectPath);
          for (const file of sessionFiles) {
            if (!file.endsWith(".jsonl")) continue;
            const filePath = path.join(projectPath, file);
            try {
              const fileStat = fs.statSync(filePath);
              files.push({ path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
            } catch {
              // Skip files we can't stat
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
      return;
    }

    // Separate recently modified files from older files
    const recentFiles = files.filter(f => now - f.mtimeMs < RECENT_THRESHOLD_MS);
    const olderFiles = files.filter(f => now - f.mtimeMs >= RECENT_THRESHOLD_MS);

    // Sort recent files by mtime descending (most recent first) - active sessions get priority
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Sort older files by size ascending (small files first)
    olderFiles.sort((a, b) => a.size - b.size);

    // Emit recent files first, then older files
    for (const file of recentFiles) {
      this.handleFileEvent(file.path, "add");
    }
    for (const file of olderFiles) {
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
