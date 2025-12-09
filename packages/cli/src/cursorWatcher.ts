import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { Database } from "bun:sqlite";

export interface CursorSessionEvent {
  sessionId: string;
  workspacePath: string;
  dbPath: string;
  eventType: "add" | "change";
}

export interface CursorWatcherEvents {
  session: (event: CursorSessionEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface CursorWatcher {
  on<K extends keyof CursorWatcherEvents>(
    event: K,
    listener: CursorWatcherEvents[K]
  ): this;
  emit<K extends keyof CursorWatcherEvents>(
    event: K,
    ...args: Parameters<CursorWatcherEvents[K]>
  ): boolean;
}

interface WorkspaceState {
  lastRowId: number;
  lastCheck: number;
}

export class CursorWatcher extends EventEmitter {
  private pollInterval: NodeJS.Timeout | null = null;
  private cursorPath: string;
  private workspaceStates: Map<string, WorkspaceState> = new Map();
  private pollFrequencyMs: number;

  constructor(cursorPath?: string, pollFrequencyMs: number = 2000) {
    super();
    this.cursorPath = cursorPath || this.detectCursorPath();
    this.pollFrequencyMs = pollFrequencyMs;
  }

  private detectCursorPath(): string {
    const platform = process.platform;
    const home = process.env.HOME || "";

    if (platform === "darwin") {
      return path.join(home, "Library", "Application Support", "Cursor");
    } else if (platform === "linux") {
      return path.join(home, ".config", "Cursor");
    } else if (platform === "win32") {
      return path.join(process.env.APPDATA || "", "Cursor");
    }

    return path.join(home, ".cursor");
  }

  start(): void {
    if (this.pollInterval) {
      return;
    }

    const workspaceStoragePath = path.join(
      this.cursorPath,
      "User",
      "workspaceStorage"
    );

    if (!fs.existsSync(workspaceStoragePath)) {
      this.emit(
        "error",
        new Error(`Cursor workspace storage not found at ${workspaceStoragePath}`)
      );
      return;
    }

    this.emit("ready");

    this.pollInterval = setInterval(() => {
      this.pollWorkspaces(workspaceStoragePath);
    }, this.pollFrequencyMs);

    setImmediate(() => this.pollWorkspaces(workspaceStoragePath));
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private pollWorkspaces(workspaceStoragePath: string): void {
    try {
      const workspaceDirs = fs.readdirSync(workspaceStoragePath);

      for (const workspaceHash of workspaceDirs) {
        const dbPath = path.join(
          workspaceStoragePath,
          workspaceHash,
          "state.vscdb"
        );

        if (!fs.existsSync(dbPath)) {
          continue;
        }

        try {
          this.checkWorkspaceForChanges(workspaceHash, dbPath);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit("error", new Error(`Failed to check workspace ${workspaceHash}: ${error.message}`));
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }

  private checkWorkspaceForChanges(workspaceHash: string, dbPath: string): void {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });

      const tableExists = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'"
        )
        .get();

      if (!tableExists) {
        return;
      }

      const maxRowIdResult = db
        .query<{ maxRowId: number | null }, []>(
          "SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'aiService.prompts'"
        )
        .get();

      const maxRowId = maxRowIdResult?.maxRowId ?? 0;

      const state = this.workspaceStates.get(workspaceHash);

      if (!state) {
        this.workspaceStates.set(workspaceHash, {
          lastRowId: maxRowId,
          lastCheck: Date.now(),
        });
        if (maxRowId > 0) {
          this.emit("session", {
            sessionId: workspaceHash,
            workspacePath: workspaceHash,
            dbPath,
            eventType: "add",
          });
        }
      } else if (maxRowId > state.lastRowId) {
        state.lastRowId = maxRowId;
        state.lastCheck = Date.now();
        this.emit("session", {
          sessionId: workspaceHash,
          workspacePath: workspaceHash,
          dbPath,
          eventType: "change",
        });
      }
    } finally {
      if (db) {
        db.close();
      }
    }
  }
}
