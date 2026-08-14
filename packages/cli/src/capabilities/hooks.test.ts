import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installOwnedHook, removeOwnedHook } from "./hooks.js";

const dirs: string[] = [];
function settings(seed?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hooks-"));
  dirs.push(dir);
  const file = path.join(dir, "settings.json");
  if (seed !== undefined) fs.writeFileSync(file, JSON.stringify(seed, null, 2) + "\n");
  return file;
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const CMD = "/home/u/.claude/hooks/codecast-status.sh";

describe("installOwnedHook", () => {
  test("adds a blanket matcher under each event", () => {
    const file = settings();
    installOwnedHook(["PreToolUse", "Stop"], CMD, { timeout: 5, settingsPath: file });
    const doc = read(file);
    for (const event of ["PreToolUse", "Stop"]) {
      expect(doc.hooks[event]).toEqual([
        { matcher: "", hooks: [{ type: "command", command: CMD, timeout: 5 }] },
      ]);
    }
  });

  test("installing twice does not duplicate the entry, and writes nothing the second time", () => {
    const file = settings();
    installOwnedHook(["Stop"], CMD, { timeout: 5, settingsPath: file });
    const before = fs.statSync(file).mtimeMs;
    const again = installOwnedHook(["Stop"], CMD, { timeout: 5, settingsPath: file });
    expect(again.wrote).toBe(false);
    expect(read(file).hooks.Stop[0].hooks).toHaveLength(1);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  test("keeps the user's own hooks in the same event", () => {
    const theirs = { type: "command", command: "/usr/local/bin/mine.sh" };
    const file = settings({ hooks: { Stop: [{ matcher: "", hooks: [theirs] }] } });
    installOwnedHook(["Stop"], CMD, { timeout: 5, settingsPath: file });
    expect(read(file).hooks.Stop[0].hooks).toEqual([
      theirs,
      { type: "command", command: CMD, timeout: 5 },
    ]);
  });

  test("keeps a user matcher that is not the blanket one", () => {
    const scoped = { matcher: "Bash", hooks: [{ type: "command", command: "/x.sh" }] };
    const file = settings({ hooks: { Stop: [scoped] } });
    installOwnedHook(["Stop"], CMD, { settingsPath: file });
    const arr = read(file).hooks.Stop;
    expect(arr).toContainEqual(scoped);
    expect(arr.find((m: any) => m.matcher === "").hooks[0].command).toBe(CMD);
  });

  test("leaves unrelated settings untouched", () => {
    const file = settings({ model: "opus", permissions: { allow: ["Bash(ls)"] } });
    installOwnedHook(["Stop"], CMD, { settingsPath: file });
    const doc = read(file);
    expect(doc.model).toBe("opus");
    expect(doc.permissions).toEqual({ allow: ["Bash(ls)"] });
  });

  test("writes 2-space indentation, so it never reformats the whole file", () => {
    // The three writers this replaced used indent 4 and indent 2, so enabling
    // two features rewrote every line and enabling them the other way rewrote
    // them back. Claude Code itself writes 2.
    const file = settings();
    installOwnedHook(["Stop"], CMD, { settingsPath: file });
    expect(fs.readFileSync(file, "utf-8")).toContain('\n  "hooks"');
  });

  test("a differing timeout updates in place rather than adding a second entry", () => {
    const file = settings();
    installOwnedHook(["Stop"], CMD, { timeout: 5, settingsPath: file });
    installOwnedHook(["Stop"], CMD, { timeout: 30, settingsPath: file });
    const hooks = read(file).hooks.Stop[0].hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].timeout).toBe(30);
  });

  test("dryRun previews without touching the file", () => {
    const file = settings();
    const plan = installOwnedHook(["Stop"], CMD, { settingsPath: file, dryRun: true });
    expect(plan.wrote).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(plan.writes).toEqual([["hooks", "Stop"]]);
  });

  test("a malformed settings file is rebuilt rather than throwing", () => {
    const file = settings();
    fs.writeFileSync(file, "{ not json");
    installOwnedHook(["Stop"], CMD, { settingsPath: file });
    expect(read(file).hooks.Stop[0].hooks[0].command).toBe(CMD);
  });
});

describe("removeOwnedHook", () => {
  test("restores the file to exactly what it was before we touched it", () => {
    const original = { model: "opus", permissions: { allow: ["Bash(ls)"] } };
    const file = settings(original);
    installOwnedHook(["PreToolUse", "Stop"], CMD, { timeout: 5, settingsPath: file });
    removeOwnedHook(CMD, { settingsPath: file });
    expect(read(file)).toEqual(original);
  });

  test("leaves the user's own hooks in place", () => {
    const theirs = { type: "command", command: "/usr/local/bin/mine.sh" };
    const file = settings({ hooks: { Stop: [{ matcher: "", hooks: [theirs] }] } });
    installOwnedHook(["Stop"], CMD, { settingsPath: file });
    removeOwnedHook(CMD, { settingsPath: file });
    expect(read(file).hooks.Stop).toEqual([{ matcher: "", hooks: [theirs] }]);
  });

  test("a hook the user edited by hand is left alone, not reverted", () => {
    // The case every hand-rolled remover got wrong. Once someone edits the
    // entry it is theirs; deleting it because we wrote it first destroys work.
    const file = settings();
    installOwnedHook(["Stop"], CMD, { timeout: 5, settingsPath: file });
    const doc = read(file);
    doc.hooks.Stop[0].hooks[0].timeout = 120;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");

    const result = removeOwnedHook(CMD, { settingsPath: file });
    expect(result.conflicts).toHaveLength(1);
    expect(read(file).hooks.Stop[0].hooks[0].timeout).toBe(120);
  });

  test("removing when nothing was installed is a no-op", () => {
    const file = settings({ model: "opus" });
    const result = removeOwnedHook(CMD, { settingsPath: file });
    expect(result.wrote).toBe(false);
    expect(read(file)).toEqual({ model: "opus" });
  });
});
