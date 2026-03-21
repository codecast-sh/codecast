import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";

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
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      maxDepth: 4,
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
      if (depth > 4) return;
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

  restart(): void {
    this.stop();
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
    const fileName = parts[parts.length - 1];
    const sessionId = fileName.replace(".jsonl", "");

    this.emit("session", {
      sessionId,
      filePath,
      eventType,
      projectPath: projectDirName,
    });
  }
}
