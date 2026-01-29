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
  private isFirstPoll: boolean = true;

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
      if (this.isFirstPoll) {
        console.log(`[CursorWatcher] Found ${workspaceDirs.length} workspace directories`);
      }

      // Build list of workspaces with their db paths and mtimes
      const workspaces: { hash: string; dbPath: string; mtime: number }[] = [];

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
          const stat = fs.statSync(dbPath);
          workspaces.push({ hash: workspaceHash, dbPath, mtime: stat.mtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }

      // Sort by mtime descending (newest first) on first poll
      if (this.isFirstPoll) {
        workspaces.sort((a, b) => b.mtime - a.mtime);
        this.isFirstPoll = false;
      }

      for (const workspace of workspaces) {
        try {
          this.checkWorkspaceForChanges(workspace.hash, workspace.dbPath);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit("error", new Error(`Failed to check workspace ${workspace.hash}: ${error.message}`));
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }

  private getWorkspaceFolderPath(workspaceStorageDir: string): string | null {
    const workspaceJsonPath = path.join(workspaceStorageDir, "workspace.json");
    try {
      if (!fs.existsSync(workspaceJsonPath)) {
        return null;
      }
      const content = fs.readFileSync(workspaceJsonPath, "utf-8");
      const data = JSON.parse(content);

      // workspace.json contains { "folder": "file:///path/to/folder" }
      // or { "workspace": "file:///path/to/workspace.code-workspace" }
      const folderUri = data.folder || data.workspace;
      if (!folderUri) {
        return null;
      }

      // Convert file:// URI to path
      if (folderUri.startsWith("file://")) {
        const decoded = decodeURIComponent(folderUri.slice(7));
        // On Windows, remove leading slash from /C:/path
        if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
          return decoded.slice(1);
        }
        return decoded;
      }

      return folderUri;
    } catch {
      return null;
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
          "SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'"
        )
        .get();

      const maxRowId = maxRowIdResult?.maxRowId ?? 0;

      const state = this.workspaceStates.get(workspaceHash);

      // Get actual workspace folder path from workspace.json
      const workspaceStorageDir = path.dirname(dbPath);
      const actualPath = this.getWorkspaceFolderPath(workspaceStorageDir) || workspaceHash;

      if (!state) {
        this.workspaceStates.set(workspaceHash, {
          lastRowId: maxRowId,
          lastCheck: Date.now(),
        });
        if (maxRowId > 0) {
          console.log(`[CursorWatcher] Emitting session for ${workspaceHash} (${actualPath}), maxRowId=${maxRowId}`);
          this.emit("session", {
            sessionId: workspaceHash,
            workspacePath: actualPath,
            dbPath,
            eventType: "add",
          });
        }
      } else if (maxRowId > state.lastRowId) {
        state.lastRowId = maxRowId;
        state.lastCheck = Date.now();
        this.emit("session", {
          sessionId: workspaceHash,
          workspacePath: actualPath,
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
