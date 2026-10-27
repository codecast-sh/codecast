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

  test("a change the default branch mostly carries, reworked after review, stops and names the files that differ, never as a plain conflict", () => {
    // ct-70983: the commit channel committed the session's tree, which held the
    // reviewed change and a fix written after review, in the same file.
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("intro.txt", "say which side offers what to whom\nand a line written after review\n", "the tree, committed");
    const landed = git(origin, "rev-parse", "main");
    const r = station();
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: false, landed: false });
    expect(r.json.why).toContain(`mostly on origin/main as ${landed.slice(0, 10)}, not as reviewed: more than reviewed in intro.txt`);
    expect(r.comments).toContain("Holds the reviewed edit plus edits no review saw: intro.txt");
    expect(r.comments).not.toContain("resolve the conflict");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  test("a file main shares only part of the reviewed edit with is named as not holding it, never as landed", () => {
    // The second review's case: main deletes the same lines the branch did but writes a different line in place of the reviewed one.
    commit(work, "other.txt", "a\nb\nc\nd\nX\n", "fix(ct-1): other.txt");
    git(work, "push", "-q", "origin", "codecast/line-ct-1");
    const other = path.join(root, "shared");
    git(root, "clone", "-q", origin, other);
    fs.writeFileSync(path.join(other, "intro.txt"), "say which side offers what to whom\n");
    fs.writeFileSync(path.join(other, "other.txt"), "a\nb\nc\nd\nY\n");
    git(other, "commit", "-qam", "intro as reviewed, other.txt another way");
    git(other, "push", "-q", "origin", "main");
    const r = station();
    expect(r.code).toBe(1);
    expect(r.json.why).toContain("reviewed edit not as written in other.txt");
    expect(r.json.why).not.toContain("intro.txt");
    expect(r.comments).toContain("Does not hold the reviewed edit as written (reworked after review, or part of it never landed): other.txt");
  });

  test("a change only partly on the default branch is a plain conflict: the file that never landed is still to ship", () => {
    // intro.txt lands exactly as reviewed; other.txt's reviewed edit never lands and conflicts with someone else's.
    commit(work, "other.txt", "the reviewed edit\n", "fix(ct-1): other.txt too");
    git(work, "push", "-q", "origin", "codecast/line-ct-1");
    const other = path.join(root, "partial");
    git(root, "clone", "-q", origin, other);
    fs.writeFileSync(path.join(other, "intro.txt"), "say which side offers what to whom\n");
    fs.writeFileSync(path.join(other, "other.txt"), "someone else's edit\n");
    git(other, "commit", "-qam", "intro landed, other.txt edited by someone else");
    git(other, "push", "-q", "origin", "main");
    const r = station();
    expect(r.code).toBe(1);
    expect(r.json.why).toBe("rebase onto origin/main conflicted in other.txt ");
    expect(r.comments).not.toContain("carries most of");
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

  test("a rebased branch the remote refuses to take is not reported rebased: ship decides on the branch as it is", () => {
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("other.txt", "y\n", "someone else's change");
    // The remote's branch moves after the worktree fetched it, so the lease is stale and the push is refused.
    const other = path.join(root, "pusher");
    git(root, "clone", "-q", "-b", "codecast/line-ct-1", origin, other);
    commit(other, "late.txt", "late\n", "someone pushed to the branch");
    git(other, "push", "-q", "origin", "codecast/line-ct-1");
    const r = station();
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ rebased: false, landed: false });
    expect(r.json.why).toContain("push of the rebased branch failed");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
  });

  test("a branch already on the default branch skips the check", () => {
    const r = station("false");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
  });
});
