import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonWorkersEnabled } from "./workers/bridge.js";
import { CursorWatcher, type CursorSessionEvent } from "./cursorWatcher.js";
import { setSlowSyncFsThresholdForTests, setSlowSyncSink } from "./slowSync.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  setSlowSyncFsThresholdForTests(null);
  setSlowSyncSink(null);
  for (const fn of cleanups) { try { fn(); } catch {} }
  cleanups.length = 0;
});

function scaffold(): { cursorPath: string; storage: string; dbPath: string } {
  const cursorPath = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-poll-"));
  cleanups.push(() => fs.rmSync(cursorPath, { recursive: true, force: true }));
  const storage = path.join(cursorPath, "User", "workspaceStorage");
  const ws = path.join(storage, "abc123");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(storage, "no-db-here"), { recursive: true });
  fs.writeFileSync(path.join(ws, "workspace.json"), JSON.stringify({ folder: "file:///Users/me/proj%20one" }));
  const dbPath = path.join(ws, "state.vscdb");
  const db = new Database(dbPath);
  db.run("CREATE TABLE ItemTable (key TEXT, value BLOB)");
  db.run("INSERT INTO ItemTable (key, value) VALUES ('workbench.panel.aichat.view.aichat.chatdata', 'x')");
  db.close();
  return { cursorPath, storage, dbPath };
}

describe("CursorWatcher.pollWorkspaces", () => {
  test("emits the session off one sqlite block and skips an unchanged DB next time", async () => {
    const { cursorPath, storage, dbPath } = scaffold();
    const watcher = new CursorWatcher(cursorPath, 60_000);
    const events: CursorSessionEvent[] = [];
    watcher.on("session", (e) => events.push(e));
    watcher.on("error", (e) => { throw e; });
    const queries = spyOn(Database.prototype, "query");
    cleanups.push(() => queries.mockRestore());
    const seen: string[] = [];
    setSlowSyncSink((m) => seen.push(m));
    setSlowSyncFsThresholdForTests(0);

    await watcher.pollWorkspaces(storage);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: "abc123", workspacePath: "/Users/me/proj one", dbPath, eventType: "add" });
    expect(seen).toHaveLength(0);
    const firstQueries = queries.mock.calls.length;
    expect(firstQueries).toBe(daemonWorkersEnabled() ? 0 : 2);

    await watcher.pollWorkspaces(storage);
    expect(events).toHaveLength(1);
    expect(seen).toHaveLength(0);
    expect(queries.mock.calls.length).toBe(firstQueries);

    // A new chat row moves the WAL or the main file; the next poll opens it.
    const db = new Database(dbPath);
    db.run("INSERT INTO ItemTable (key, value) VALUES ('workbench.panel.aichat.view.aichat.chatdata', 'y')");
    db.close();
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(dbPath, future, future);
    await watcher.pollWorkspaces(storage);
    expect(events).toHaveLength(2);
    expect(events[1].eventType).toBe("change");
    expect(seen).toHaveLength(0);
    expect(queries.mock.calls.length).toBe(firstQueries * 2);
  }, 15_000);

  test("a poll still running makes the next tick do nothing instead of a second pass", async () => {
    const { cursorPath, storage } = scaffold();
    const watcher = new CursorWatcher(cursorPath, 60_000);
    const events: CursorSessionEvent[] = [];
    watcher.on("session", (e) => events.push(e));
    await Promise.all([watcher.pollWorkspaces(storage), watcher.pollWorkspaces(storage)]);
    expect(events).toHaveLength(1);
  }, 15_000);
});
