import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

export interface CursorTranscriptEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
}

export interface CursorTranscriptWatcherEvents {
  session: (event: CursorTranscriptEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface CursorTranscriptWatcher {
  on<K extends keyof CursorTranscriptWatcherEvents>(
    event: K,
    listener: CursorTranscriptWatcherEvents[K]
  ): this;
  emit<K extends keyof CursorTranscriptWatcherEvents>(
    event: K,
    ...args: Parameters<CursorTranscriptWatcherEvents[K]>
  ): boolean;
}

export class CursorTranscriptWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private historyPath: string;

  constructor(historyPath?: string) {
    super();
    this.historyPath =
      historyPath ||
      path.join(process.env.HOME || "", ".cursor", "projects");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.historyPath)) {
      return;
    }

    this.emitExistingFilesSorted();

    const pattern = path.join(this.historyPath, "**", "agent-transcripts", "*.txt");

    this.watcher = watch(pattern, {
      persistent: true,
      ignoreInitial: true,
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
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".txt")) {
          if (!fullPath.includes(`${path.sep}agent-transcripts${path.sep}`)) {
            continue;
          }
          try {
            const stat = fs.statSync(fullPath);
            files.push({ path: fullPath, mtime: stat.mtimeMs });
          } catch {
            continue;
          }
        }
      }
    };

    scanDir(this.historyPath);

    files.sort((a, b) => b.mtime - a.mtime);

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
    return path.basename(filePath, ".txt");
  }
}
