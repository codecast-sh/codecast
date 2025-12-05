import { Client } from "fb-watchman";
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

interface WatchmanFile {
  name: string;
  exists: boolean;
  new: boolean;
}

interface WatchmanSubscription {
  root: string;
  subscription: string;
  files: WatchmanFile[];
}

export class SessionWatcher extends EventEmitter {
  private client: Client | null = null;
  private projectsPath: string;
  private watchPath: string | null = null;
  private relativePath: string = "";
  private subscriptionName = "codecast-sessions";

  constructor(projectsPath?: string) {
    super();
    this.projectsPath =
      projectsPath ||
      path.join(process.env.HOME || "", ".claude", "projects");
  }

  start(): void {
    if (this.client) {
      return;
    }

    if (!fs.existsSync(this.projectsPath)) {
      fs.mkdirSync(this.projectsPath, { recursive: true });
    }

    this.client = new Client();

    this.client.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.client.on("end", () => {
      this.client = null;
    });

    this.client.on("subscription", (resp: WatchmanSubscription) => {
      if (resp.subscription !== this.subscriptionName) return;

      for (const file of resp.files) {
        if (!file || !file.name) continue;
        if (!file.name.endsWith(".jsonl")) continue;
        if (!file.exists) continue;

        const filePath = path.join(this.projectsPath, file.name);
        const eventType = file.new ? "add" : "change";
        this.handleFileEvent(filePath, eventType);
      }
    });

    this.client.capabilityCheck(
      { optional: [], required: ["relative_root"] },
      (err) => {
        if (err) {
          this.emit("error", err);
          return;
        }
        this.setupWatch();
      }
    );
  }

  private setupWatch(): void {
    if (!this.client) return;

    this.client.command(["watch-project", this.projectsPath], (err, resp) => {
      if (err) {
        this.emit("error", err);
        return;
      }

      this.watchPath = resp.watch;
      this.relativePath = resp.relative_path || "";

      const sub = {
        expression: [
          "allof",
          ["match", "*.jsonl"],
          ["type", "f"],
        ],
        fields: ["name", "exists", "new"],
        relative_root: this.relativePath || undefined,
      };

      this.client!.command(
        ["subscribe", this.watchPath, this.subscriptionName, sub],
        (subErr) => {
          if (subErr) {
            this.emit("error", subErr);
            return;
          }
          this.emitInitialFiles();
        }
      );
    });
  }

  private emitInitialFiles(): void {
    if (!this.client || !this.watchPath) {
      this.emit("ready");
      return;
    }

    const query: Record<string, unknown> = {
      expression: ["allof", ["match", "*.jsonl"], ["type", "f"]],
      fields: ["name"],
    };
    if (this.relativePath) {
      query.relative_root = this.relativePath;
    }

    this.client.command(
      ["query", this.watchPath, query],
      (err, resp) => {
        if (err) {
          this.emit("error", err);
          this.emit("ready");
          return;
        }

        if (resp.files) {
          for (const file of resp.files) {
            if (!file || !file.name) continue;
            const filePath = path.join(this.projectsPath, file.name);
            this.handleFileEvent(filePath, "add");
          }
        }

        this.emit("ready");
      }
    );
  }

  stop(): void {
    if (this.client) {
      if (this.watchPath) {
        this.client.command(
          ["unsubscribe", this.watchPath, this.subscriptionName],
          () => {}
        );
      }
      this.client.end();
      this.client = null;
      this.watchPath = null;
      this.relativePath = "";
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
