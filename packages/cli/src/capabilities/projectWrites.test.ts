import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { checkProjectWrite, projectWritesSetting } from "./projectWrites.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pw-"));
  dirs.push(d);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(d, "CLAUDE.md"), "tracked\n");
  fs.writeFileSync(path.join(d, ".gitignore"), "local.md\n");
  git("add", "CLAUDE.md", ".gitignore");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return d;
}

describe("checkProjectWrite", () => {
  test("a tracked target is refused, naming the file", () => {
    const r = checkProjectWrite(path.join(repo(), "CLAUDE.md"));
    expect(r).toMatchObject({ ok: false, reason: "tracked" });
    if (!r.ok) expect(r.detail).toContain("CLAUDE.md is tracked");
  });

  test("an ignored target is written, also before it exists", () => {
    const d = repo();
    expect(checkProjectWrite(path.join(d, "local.md"))).toEqual({ ok: true });
    fs.mkdirSync(path.join(d, "sub"));
    fs.writeFileSync(path.join(d, ".git", "info", "exclude"), "sub/AGENTS.md\n");
    expect(checkProjectWrite(path.join(d, "sub", "AGENTS.md"))).toEqual({ ok: true });
  });

  test("the override is honored and logged", () => {
    const lines: string[] = [];
    const r = checkProjectWrite(path.join(repo(), "CLAUDE.md"), { overrideTracked: true, log: (l) => lines.push(l) });
    expect(r).toEqual({ ok: true, overridden: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("next commit");
  });

  test("untracked but not ignored: refused by default, written under all, nothing under off", () => {
    const d = repo();
    const f = path.join(d, "AGENTS.md");
    const def = checkProjectWrite(f);
    expect(def).toMatchObject({ ok: false, reason: "not_ignored" });
    if (!def.ok) expect(def.detail).toContain(".git/info/exclude");
    expect(checkProjectWrite(f, { setting: "all" })).toEqual({ ok: true });
    expect(checkProjectWrite(f, { setting: "off" })).toMatchObject({ ok: false, reason: "project_writes_off" });
    expect(checkProjectWrite(path.join(d, "local.md"), { setting: "off" })).toMatchObject({ ok: false });
  });

  test("the device setting defaults to ignored_only and ignores unknown values", () => {
    expect(projectWritesSetting(null)).toBe("ignored_only");
    expect(projectWritesSetting({ capabilities: { project_writes: "everything" } })).toBe("ignored_only");
    expect(projectWritesSetting({ capabilities: { project_writes: "off" } })).toBe("off");
  });
});
