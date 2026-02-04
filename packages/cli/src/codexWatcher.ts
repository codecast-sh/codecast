import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

export interface CodexSessionEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
}

export interface CodexWatcherEvents {
  session: (event: CodexSessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface CodexWatcher {
  on<K extends keyof CodexWatcherEvents>(
    event: K,
    listener: CodexWatcherEvents[K]
  ): this;
  emit<K extends keyof CodexWatcherEvents>(
    event: K,
    ...args: Parameters<CodexWatcherEvents[K]>
  ): boolean;
}

export class CodexWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private historyPath: string;

  constructor(historyPath?: string) {
    super();
    this.historyPath =
      historyPath ||
      path.join(process.env.HOME || "", ".codex", "sessions");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.historyPath)) {
      fs.mkdirSync(this.historyPath, { recursive: true });
    }

    // Scan existing files sorted by mtime (newest first)
    this.emitExistingFilesSorted();

    const pattern = path.join(this.historyPath, "**", "*.jsonl");

    this.watcher = watch(pattern, {
      persistent: true,
      ignoreInitial: true, // We handle initial files ourselves for sorting
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("add", (filePath) => {
      this.handleFileEvent(filePath, "add");
    });

    this.watcher.on("change", (filePath) => {
      this.handleFileEvent(filePath, "change");
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
    const files: { path: string; mtime: number }[] = [];

    const scanDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try {
              const stat = fs.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch {
              // Skip files we can't stat
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    scanDir(this.historyPath);

    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime);

    // Emit events for each file
    for (const file of files) {
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
    this.emit("session", { sessionId, filePath, eventType });
  }

  private extractSessionId(filePath: string): string {
    const filename = path.basename(filePath, ".jsonl");
    const match = filename.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    return match ? match[1] : filename;
  }
}
