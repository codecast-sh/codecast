import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

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
  private watcher: FSWatcher | null = null;
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

    this.watcher = watch(this.projectsPath, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
      depth: 2,
    });

    this.watcher.on("add", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        this.handleFileEvent(filePath, "add");
      }
    });

    this.watcher.on("change", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        this.handleFileEvent(filePath, "change");
      }
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
    const projectPath = this.extractProjectPath(filePath);
    this.emit("session", { sessionId, filePath, eventType, projectPath });
  }

  private extractSessionId(filePath: string): string {
    return path.basename(filePath, ".jsonl");
  }

  private extractProjectPath(filePath: string): string {
    const parentDir = path.basename(path.dirname(filePath));
    return parentDir.replace(/-/g, "/");
  }
}
