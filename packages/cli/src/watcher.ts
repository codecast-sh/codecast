import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";

export interface FileChangeEvent {
  filePath: string;
  eventType: "add" | "change";
}

export interface HistoryWatcherEvents {
  change: (event: FileChangeEvent) => void;
  ready: () => void;
  error: (error: Error) => void;
}

export class HistoryWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private historyPath: string;

  constructor(historyPath?: string) {
    super();
    this.historyPath =
      historyPath ||
      path.join(process.env.HOME || "", ".claude", "history.jsonl");
  }

  start(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.historyPath, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on("add", (filePath: string) => {
      this.emit("change", { filePath, eventType: "add" } as FileChangeEvent);
    });

    this.watcher.on("change", (filePath: string) => {
      this.emit("change", { filePath, eventType: "change" } as FileChangeEvent);
    });

    this.watcher.on("ready", () => {
      this.emit("ready");
    });

    this.watcher.on("error", (error: unknown) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getHistoryPath(): string {
    return this.historyPath;
  }
}
