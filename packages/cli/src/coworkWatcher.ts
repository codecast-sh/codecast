import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";

export interface CoworkSessionEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
  projectPath: string;
}

export interface CoworkWatcherEvents {
  session: (event: CoworkSessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface CoworkWatcher {
  on<K extends keyof CoworkWatcherEvents>(
    event: K,
    listener: CoworkWatcherEvents[K]
  ): this;
  emit<K extends keyof CoworkWatcherEvents>(
    event: K,
    ...args: Parameters<CoworkWatcherEvents[K]>
  ): boolean;
}

export class CoworkWatcher extends EventEmitter {
  private watcher: RecursiveWatcher | null = null;
  private basePath: string;

  constructor(basePath?: string) {
    super();
    this.basePath =
      basePath ||
      path.join(process.env.HOME || "", "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.basePath)) {
      return;
    }

    this.emitExistingFilesSorted();

    this.watcher = new RecursiveWatcher({
      path: this.basePath,
      filter: (rel) => rel.endsWith(".jsonl") && !rel.endsWith("audit.jsonl"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      maxDepth: 8,
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }

  private emitExistingFilesSorted(): void {
    const files: { path: string; mtime: number }[] = [];

    const scanDir = (dir: string, depth: number): void => {
      if (depth > 8) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "audit.jsonl") {
            try {
              const stat = fs.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    };

    scanDir(this.basePath, 0);
    files.sort((a, b) => b.mtime - a.mtime);

    for (const file of files) {
      this.handleFileEvent(file.path, "add");
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  private handleFileEvent(filePath: string, eventType: "add" | "change"): void {
    const sessionId = this.extractSessionId(filePath);
    const projectPath = this.extractProjectPath(filePath);
    this.emit("session", { sessionId, filePath, eventType, projectPath });
  }

  private extractSessionId(filePath: string): string {
    const filename = path.basename(filePath, ".jsonl");
    const match = filename.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    return match ? match[1] : filename;
  }

  private extractProjectPath(filePath: string): string {
    const relative = path.relative(this.basePath, filePath);
    const parts = relative.split(path.sep);
    const projectsIdx = parts.findIndex(p => p === "projects");
    if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
      return parts[projectsIdx + 1];
    }
    return parts[0] || "unknown";
  }
}
