import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cursorDbOpenPath } from "./cursorDbPath.js";

describe("cursorDbOpenPath", () => {
  test("a closed WAL database opens read-only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor db ?#"));
    const file = path.join(dir, "state.vscdb");
    const db = new Database(file);
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.run("INSERT INTO ItemTable VALUES ('k', 'v')");
    db.close();
    // What a closed Cursor window leaves: the main file alone.
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });

    // A plain read-only open throws here on macOS; Linux's SQLite opens it, so only the immutable path is asserted.
    expect(cursorDbOpenPath(file)).toEndWith("?immutable=1");
    const opened = new Database(cursorDbOpenPath(file), { readonly: true });
    expect(opened.query("SELECT value FROM ItemTable").get()).toEqual({ value: "v" });
    opened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a live WAL database and a rollback-journal one open as they are", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-db-"));
    const wal = path.join(dir, "wal.vscdb");
    const live = new Database(wal);
    live.run("PRAGMA journal_mode=WAL");
    live.run("CREATE TABLE t (x)");
    expect(cursorDbOpenPath(wal)).toBe(wal);
    live.close();
    const plain = path.join(dir, "plain.vscdb");
    new Database(plain).run("CREATE TABLE t (x)");
    expect(cursorDbOpenPath(plain)).toBe(plain);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
