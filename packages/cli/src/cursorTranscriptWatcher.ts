import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";
import type { WalkFile } from "./fsWalk.js";

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

    this.watcher = new RecursiveWatcher({
      path: this.historyPath,
      filter: (rel) => rel.endsWith(".txt") && rel.includes(`agent-transcripts${path.sep}`) || rel.includes("agent-transcripts/"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      onExisting: (files) => this.emitExistingFilesSorted(files),
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }

  // Files the watcher's priming walk found (one walk serves both), newest first.
  private emitExistingFilesSorted(files: WalkFile[]): void {
    const matched = files.filter((f) =>
      f.path.endsWith(".txt") && f.path.includes(`${path.sep}agent-transcripts${path.sep}`));
    matched.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const file of matched) {
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
