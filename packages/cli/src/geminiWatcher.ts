import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";

export interface GeminiSessionEvent {
  sessionId: string;
  filePath: string;
  projectHash: string;
  eventType: "add" | "change";
}

export interface GeminiWatcherEvents {
  session: (event: GeminiSessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface GeminiWatcher {
  on<K extends keyof GeminiWatcherEvents>(
    event: K,
    listener: GeminiWatcherEvents[K]
  ): this;
  emit<K extends keyof GeminiWatcherEvents>(
    event: K,
    ...args: Parameters<GeminiWatcherEvents[K]>
  ): boolean;
}

export class GeminiWatcher extends EventEmitter {
  private watcher: RecursiveWatcher | null = null;
  private basePath: string;

  constructor(basePath?: string) {
    super();
    this.basePath =
      basePath ||
      path.join(process.env.HOME || "", ".gemini", "tmp");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    this.emitExistingFilesSorted();

    this.watcher = new RecursiveWatcher({
      path: this.basePath,
      filter: (rel) => rel.endsWith(".json") && (rel.includes(`chats${path.sep}`) || rel.includes("chats/")),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      debounceMs: 200,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
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
          } else if (entry.isFile() && entry.name.endsWith(".json") && dir.endsWith("/chats")) {
            try {
              const stat = fs.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    };

    scanDir(this.basePath);
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
    const projectHash = this.extractProjectHash(filePath);
    this.emit("session", { sessionId, filePath, projectHash, eventType });
  }

  private extractSessionId(filePath: string): string {
    const filename = path.basename(filePath, ".json");
    const match = filename.match(
      /([0-9a-f]{8})$/i
    );
    return match ? filename : filename;
  }

  private extractProjectHash(filePath: string): string {
    const parts = filePath.split(path.sep);
    const chatsIdx = parts.lastIndexOf("chats");
    if (chatsIdx > 0) {
      return parts[chatsIdx - 1];
    }
    return "";
  }
}
