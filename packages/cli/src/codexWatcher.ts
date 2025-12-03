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
      path.join(process.env.HOME || "", ".codex", "history");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    if (!fs.existsSync(this.historyPath)) {
      fs.mkdirSync(this.historyPath, { recursive: true });
    }

    const pattern = path.join(this.historyPath, "**", "*.jsonl");

    this.watcher = watch(pattern, {
      persistent: true,
      ignoreInitial: false,
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
    return path.basename(path.dirname(filePath));
  }
}
