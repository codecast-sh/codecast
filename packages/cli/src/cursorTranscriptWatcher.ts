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

/** A transcript is a .txt somewhere under an agent-transcripts dir. Relative
 *  to the projects root, so the dir is never the first segment. */
export function isCursorTranscriptPath(rel: string): boolean {
  return rel.endsWith(".txt") && (rel.includes(`agent-transcripts${path.sep}`) || rel.includes("agent-transcripts/"));
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

  /** Resolves once the priming walk has emitted the existing transcripts;
   *  immediately when there is no cursor projects dir to watch. */
  start(): Promise<void> {
    if (this.watcher) {
      return this.watcher.whenPrimed();
    }

    if (!fs.existsSync(this.historyPath)) {
      return Promise.resolve();
    }

    this.watcher = new RecursiveWatcher({
      path: this.historyPath,
      filter: isCursorTranscriptPath,
      // A project dir holds canvases, mcps and terminals next to
      // agent-transcripts; only the transcript subtree can hold a match.
      dirFilter: (rel) => {
        const parts = rel.split(path.sep);
        return parts.length === 1 || parts[1] === "agent-transcripts";
      },
      // <proj>/agent-transcripts/<id>/<id>.txt is depth 4; one spare level.
      maxDepth: 5,
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      onExisting: (files) => this.emitExistingFilesSorted(files),
      debounceMs: 100,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
    return this.watcher.whenPrimed();
  }

  whenPrimed(): Promise<void> {
    return this.watcher ? this.watcher.whenPrimed() : Promise.resolve();
  }

  // Files the watcher's priming walk found (one walk serves both), newest first.
  private emitExistingFilesSorted(files: WalkFile[]): void {
    const matched = files.filter((f) => isCursorTranscriptPath(f.rel));
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
