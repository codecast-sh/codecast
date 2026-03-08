import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";

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
  private watcher: RecursiveWatcher | null = null;
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

    this.watcher = new RecursiveWatcher({
      path: this.historyPath,
      filter: (rel) => rel.endsWith(".txt") && rel.includes(`agent-transcripts${path.sep}`) || rel.includes("agent-transcripts/"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
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
      this.watcher.stop();
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
