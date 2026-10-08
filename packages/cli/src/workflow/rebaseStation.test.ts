import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { expandScriptVars } from "./runner.js";
import { extractJsonOutput } from "./condition.js";

// The line's rebase station (templates/line/rebase.sh) against real
// repositories: an origin, the run's worktree on its branch, and a fake
// `cast` that answers `ws path` and records task comments.

const SCRIPT = fs.readFileSync(path.join(import.meta.dir, "templates/line/rebase.sh"), "utf-8");

describe("line rebase station", () => {
  let root: string;
  let origin: string;
  let work: string;
  let bin: string;
  let comments: string;

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
  };
  // Main moves in a second clone and is pushed, the way other people's work lands.
  const landOnMain = (file: string, text: string, msg: string) => {
    const other = path.join(root, `other-${Math.random().toString(36).slice(2, 8)}`);
    git(root, "clone", "-q", origin, other);
    commit(other, file, text, msg);
    git(other, "push", "-q", "origin", "main");
  };
  const station = (check = "true") => {
    const context: Record<string, string> = {
      worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", task_id: "ct-1",
      run_dir: path.join(root, "run"), "line.commands.check": check,
    };
    const r = spawnSync("bash", ["-c", expandScriptVars(SCRIPT, context)], {
      cwd: work, encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    // Read the answer the way the runner does (recordNodeOutput): the whole stdout is the JSON.
    return { code: r.status, json: extractJsonOutput(r.stdout) as any, comments: fs.existsSync(comments) ? fs.readFileSync(comments, "utf-8") : "" };
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-rebase-station-"));
    origin = path.join(root, "origin.git");
    work = path.join(root, "work");
    bin = path.join(root, "bin");
    comments = path.join(root, "comments.txt");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, work);
    commit(work, "intro.txt", "say who offers what\n", "base");
    commit(work, "other.txt", "x\n", "base 2");
    git(work, "push", "-q", "origin", "main");
    git(work, "checkout", "-qb", "codecast/line-ct-1");
    commit(work, "intro.txt", "say which side offers what to whom\n", "fix(ct-1): the intro names who offers what");
    git(work, "push", "-q", "origin", "codecast/line-ct-1");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash
if [ "$1 $2" = "ws path" ]; then echo "${work}"; exit 0; fi
if [ "$1 $2" = "task comment" ]; then printf '%s\\n' "$4" >> "${comments}"; echo "ok Comment added to $3"; exit 0; fi
exit 1
`, { mode: 0o755 });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("a branch the default branch moved under is rebased, checked, and goes on to ship", () => {
    landOnMain("other.txt", "y\n", "someone else's change");
    const r = station("test \"$(cat other.txt)\" = y");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
    expect(git(work, "rev-list", "--count", "HEAD..origin/main")).toBe("0");
    // The remote branch the ship command lands follows the rebase.
    git(work, "fetch", "-q", "origin");
    expect(git(work, "rev-parse", "origin/codecast/line-ct-1")).toBe(git(work, "rev-parse", "HEAD"));
  });

  test("a rebase that conflicts goes back to implement with the conflict on the task, the branch untouched", () => {
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("intro.txt", "something else entirely\n", "a conflicting change");
    const r = station();
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: false, landed: false });
    expect(r.json.why).toContain("intro.txt");
    expect(r.comments).toContain("conflicted in intro.txt");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  test("a change already on the default branch is not shipped twice: it goes on to watch", () => {
    // Landed by hand in a commit that carried more than the change, so its patch differs.
    landOnMain("other.txt", "y\n", "someone else's change");
    const other = path.join(root, "hand");
    git(root, "clone", "-q", origin, other);
    fs.writeFileSync(path.join(other, "intro.txt"), "say which side offers what to whom\n");
    fs.writeFileSync(path.join(other, "extra.txt"), "more\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "fix(ct-1): landed by hand, with more");
    git(other, "push", "-q", "origin", "main");
    landOnMain("other.txt", "z\n", "a later change");
    const landed = git(origin, "rev-parse", "main~1");
    const r = station();
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rebased: true, landed: true });
    expect(r.json.why).toContain(landed.slice(0, 10));
    expect(r.comments).toContain(`Already on main as ${landed.slice(0, 10)}`);
  });

  test("a check that fails on the rebased branch goes back to implement, and the branch returns to where it was", () => {
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("other.txt", "y\n", "someone else's change");
    const r = station("echo the check is red; false");
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
    expect(r.comments).toContain("the check is red");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
  });

  test("a branch already on the default branch skips the check", () => {
    const r = station("false");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
  });
});
