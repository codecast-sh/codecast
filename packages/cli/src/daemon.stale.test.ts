import { daemonWorkersEnabled } from "./workers/bridge.js";
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Database } from "bun:sqlite";
import { runBounded, findStaleSessionFiles, findStaleCursorSessions, isAppServerManagedCodexSessionHead, shouldTreatClaudeFileAsStale } from "./daemon.js";
import { updateSyncRecord } from "./syncLedger.js";
import { clearPosition, setPosition } from "./positionTracker.js";
import { setSlowSyncFsThresholdForTests, setSlowSyncSink } from "./slowSync.js";
import { isolateCodecastDir } from "./test-helpers/codecastDir.js";

const isolatedCodecastDir = isolateCodecastDir("daemon-sync-state-");
afterAll(() => isolatedCodecastDir.restore());

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

test("one failed startup transcript does not stop the rest of the catch-up sweep", async () => {
  const synced: number[] = [];
  await runBounded([0, 1, 2, 3, 4], 2, async item => {
    if (item === 0) throw new Error("ingest reservation capacity");
    synced.push(item);
  }, "test recovery");
  expect(synced.sort()).toEqual([1, 2, 3, 4]);
});

test("Claude recovery includes nested subagents without scanning tool output folders", async () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stale-"));
  const root = path.join(home, ".claude/projects");
  const files = ["project/11111111-1111-4111-8111-111111111111.jsonl", "project/11111111-1111-4111-8111-111111111111/subagents/agent-child.jsonl", "project/11111111-1111-4111-8111-111111111111/subagents/workflows/wf_run/agent-worker.jsonl"];
  const ignored = "project/11111111-1111-4111-8111-111111111111/tool-results/output.jsonl";
  try {
    process.env.HOME = home;
    for (const file of [...files, ignored]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "{}\n");
    }
    const stale = await findStaleSessionFiles();
    expect(stale.sort()).toEqual(files.map(file => path.join(root, file)).sort());
    for (const file of files) updateSyncRecord(path.join(root, file), { lastSyncedPosition: 3, lastSyncedAt: Date.now() + 1000 });
    expect(await findStaleSessionFiles()).toEqual([]);
  } finally {
    process.env.HOME = previousHome;
    for (const file of files) clearPosition(path.join(root, file));
    fs.rmSync(home, { recursive: true, force: true });
  }
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
    // The sqlite open is the one sync step of the sweep; with the threshold
    // at zero each open reports, so the count of reports is the count of opens.
    const reports: string[] = [];
    const opens = () => reports.filter((m) => m.includes("getCursorMaxRowId")).length;
    setSlowSyncFsThresholdForTests(0);
    setSlowSyncSink((m) => reports.push(m));
    try {
      db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);

      const first = await findStaleCursorSessions();
      expect(first.map((s) => s.sessionId)).toEqual(["abc123"]);
      expect(first[0].workspacePath).toBe("/tmp/proj");
      expect(first[0].dbPath).toBe(dbPath);
      expect(opens()).toBe(daemonWorkersEnabled() ? 0 : 1);

      // Synced to the last row: nothing to report, and no mtime moved, so
      // the db is not opened again.
      setPosition(dbPath, 2);
      expect(await findStaleCursorSessions()).toEqual([]);
      expect(opens()).toBe(daemonWorkersEnabled() ? 0 : 1);

      // A new row moves the db (or its wal): opened and reported again.
      await new Promise((r) => setTimeout(r, 20));
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [CHAT_KEY, "{}"]);
      const again = await findStaleCursorSessions();
      expect(again.map((s) => s.sessionId)).toEqual(["abc123"]);
      expect(opens()).toBe(daemonWorkersEnabled() ? 0 : 2);
    } finally {
      setSlowSyncSink(null);
      setSlowSyncFsThresholdForTests(null);
      db.close();
      clearPosition(dbPath);
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
