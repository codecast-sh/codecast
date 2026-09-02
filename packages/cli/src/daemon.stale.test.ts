import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { findStaleCursorSessions, isAppServerManagedCodexSessionHead, shouldTreatClaudeFileAsStale } from "./daemon.js";
import { clearPosition, setPosition } from "./positionTracker.js";

describe("shouldTreatClaudeFileAsStale", () => {
  test("marks file stale when there is no sync record", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 2000, size: 100 },
        null
      )
    ).toBe(true);
  });

  test("ignores mtime drift for legacy fallback records", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 100 },
        {
          lastSyncedAt: 0,
          lastSyncedPosition: 100,
          messageCount: 0,
          isLegacyFallback: true,
        }
      )
    ).toBe(false);
  });

  test("marks legacy fallback record stale when size grows", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 101 },
        {
          lastSyncedAt: 0,
          lastSyncedPosition: 100,
          messageCount: 0,
          isLegacyFallback: true,
        }
      )
    ).toBe(true);
  });

  test("marks non-legacy record stale when mtime moves forward", () => {
    expect(
      shouldTreatClaudeFileAsStale(
        { mtimeMs: 5000, size: 100 },
        {
          lastSyncedAt: 4000,
          lastSyncedPosition: 100,
          messageCount: 10,
        }
      )
    ).toBe(true);
  });
});

describe("isAppServerManagedCodexSessionHead", () => {
  test("detects codecast app-server transcripts", () => {
    expect(
      isAppServerManagedCodexSessionHead(
        '{"type":"session_meta","payload":{"originator":"codecast","source":{"custom":"codecast"}}}\n'
      )
    ).toBe(true);
  });

  test("ignores normal Codex CLI transcripts", () => {
    expect(
      isAppServerManagedCodexSessionHead(
        '{"type":"session_meta","payload":{"originator":"codex_cli_rs","source":"cli"}}\n'
      )
    ).toBe(false);
  });
});

// The cursor stale finder walks workspaceStorage off the loop and opens a
// workspace's sqlite (the one sync step) only when the db or its wal moved
// since the last sweep. The position compare runs every sweep, so a sync
// that failed is retried without a new open.
describe("findStaleCursorSessions", () => {
  const CHAT_KEY = "workbench.panel.aichat.view.aichat.chatdata";
  test("reports a workspace with unsynced rows, skips it once synced, reports it again when it moves", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const realHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cursor-stale-"));
    process.env.HOME = home;
    const storage = process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage")
      : path.join(home, ".config", "Cursor", "User", "workspaceStorage");
    const wsDir = path.join(storage, "abc123");
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///tmp/proj" }));
    const dbPath = path.join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    try {
      db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);

      const first = await findStaleCursorSessions();
      expect(first.map((s) => s.sessionId)).toEqual(["abc123"]);
      expect(first[0].workspacePath).toBe("/tmp/proj");
      expect(first[0].dbPath).toBe(dbPath);

      // Synced to the last row: nothing to report, and no mtime moved.
      setPosition(dbPath, 2);
      expect(await findStaleCursorSessions()).toEqual([]);

      // A new row moves the db (or its wal): reported again.
      await new Promise((r) => setTimeout(r, 20));
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);
      const again = await findStaleCursorSessions();
      expect(again.map((s) => s.sessionId)).toEqual(["abc123"]);
    } finally {
      db.close();
      clearPosition(dbPath);
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
