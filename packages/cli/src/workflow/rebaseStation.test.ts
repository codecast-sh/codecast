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
const SHIP = fs.readFileSync(path.join(import.meta.dir, "templates/line/ship.sh"), "utf-8");
const LANDED = path.join(import.meta.dir, "landed.ts");

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
      worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", task_id: "ct-1", run_id: "run1",
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
if [ "$1 $2" = "flow landed" ]; then printf '%s\\n' "$@" > "${root}/landed-args"; [ -n "$REAL_LANDED" ] && { shift 2; exec bun "${root}/landed-shim.ts" "$@"; }; exit 0; fi
exit 1
`, { mode: 0o755 });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // The real `cast flow landed` check, without the server: the fake cast runs it when REAL_LANDED is set.
  const shim = () => fs.writeFileSync(path.join(root, "landed-shim.ts"), `import { runLanded } from ${JSON.stringify(LANDED)};
const a = process.argv.slice(2); const o: Record<string, string> = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1];
process.exit(await runLanded(process.cwd(), o as any));
`);
  // ship.sh as the runner runs it, with the project's ship command.
  const ship = (command: string) => {
    shim();
    const context: Record<string, string> = {
      worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", task_id: "ct-1", run_id: "run1",
      run_dir: path.join(root, "run"), "line.commands.ship": command,
    };
    const r = spawnSync("bash", ["-c", expandScriptVars(SHIP, context)], {
      cwd: work, encoding: "utf-8",
      env: { ...process.env, REAL_LANDED: "1", PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const mergeSha = () => JSON.parse(fs.readFileSync(path.join(root, "run", "merge.json"), "utf-8")).sha;

  // A fast-forward lands the branch as itself, so its fork from main is its own tip afterwards: Land reads the fork
  // before landing and keeps it, and a later rebase that finds the change already landed starts from that.
  test("a fast-forward landing writes the branch tip to merge.json from Land and again from a later already-landed rebase", () => {
    const tip = git(work, "rev-parse", "HEAD");
    const before = git(work, "rev-parse", "origin/main");
    const landed = ship("git push -q origin HEAD:main");
    expect(landed.code).toBe(0);
    expect(mergeSha()).toBe(tip);
    expect(fs.readFileSync(path.join(root, "run", "since"), "utf-8").trim()).toBe(before);
    // The rebase station reads the environment this process has.
    process.env.REAL_LANDED = "1";
    try {
      const again = station();
      expect(again.json).toMatchObject({ rebased: true, landed: true });
      expect(mergeSha()).toBe(tip);
      // With no fork kept and no frozen change, nothing says this tip on main is the change: no merge.json.
      fs.rmSync(path.join(root, "run", "since"));
      station();
      expect(fs.existsSync(path.join(root, "run", "merge.json"))).toBe(false);
    } finally {
      delete process.env.REAL_LANDED;
    }
  });

  // A branch with no commit of its own sits on an old main commit: nothing of it is left to ship, and nothing says
  // its tip is the change, so no merge.json is written and Deploy says nothing was merged.
  test("a branch with no commit of its own is never written as landed", () => {
    git(work, "reset", "-q", "--hard", "origin/main");
    git(work, "push", "-q", "-f", "origin", "codecast/line-ct-1");
    const r = station();
    expect(r.json).toMatchObject({ rebased: true, landed: true });
    expect(fs.existsSync(path.join(root, "landed-args"))).toBe(false);
    expect(fs.existsSync(path.join(root, "run", "merge.json"))).toBe(false);
  });

  test("with no fork kept by Land, the commit the run froze the change on says where it started", () => {
    const start = git(work, "rev-parse", "HEAD~1");
    fs.mkdirSync(path.join(root, "run"), { recursive: true });
    fs.writeFileSync(path.join(root, "run", "change.json"), JSON.stringify({ source: "session", base: start, tip: "x", branch: "codecast/line-ct-1", worktree: "line-ct-1", paths: ["intro.txt"] }, null, 2));
    git(work, "push", "-q", "origin", "HEAD:main");
    shim();
    process.env.REAL_LANDED = "1";
    try {
      station();
    } finally {
      delete process.env.REAL_LANDED;
    }
    expect(fs.readFileSync(path.join(root, "landed-args"), "utf-8")).toContain(`--since\n${start}\n`);
    expect(mergeSha()).toBe(git(work, "rev-parse", "HEAD"));
  });

  test("a land command that exits 0 with nothing on main ends Land at Not merged", () => {
    const r = ship("echo applied to a working tree");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Land reported success but codecast/line-ct-1 is not on main: nothing was merged");
    expect(fs.existsSync(path.join(root, "run", "merge.json"))).toBe(false);
  });

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

  // Deploy starts from merge.json; the already-landed route skips Land, so the rebase station writes it there.
  test("a change already on the default branch has its commit written where Deploy starts, and a stale merge.json goes first", () => {
    fs.mkdirSync(path.join(root, "run"), { recursive: true });
    fs.writeFileSync(path.join(root, "run", "merge.json"), '{"sha":"stale"}\n');
    const was = git(work, "rev-parse", "HEAD");
    const fork = git(work, "rev-parse", "HEAD~1");
    const other = path.join(root, "hand");
    git(root, "clone", "-q", origin, other);
    fs.writeFileSync(path.join(other, "intro.txt"), "say which side offers what to whom\n");
    git(other, "commit", "-qam", "fix(ct-1): squashed");
    git(other, "push", "-q", "origin", "main");
    const r = station();
    expect(r.json).toMatchObject({ rebased: true, landed: true });
    expect(fs.existsSync(path.join(root, "run", "merge.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "landed-args"), "utf-8").trim().split("\n")).toEqual([
      "flow", "landed", "--branch", was, "--as", "codecast/line-ct-1", "--base", "main", "--files", "", "--since", fork, "--out", path.join(root, "run", "merge.json"), "--run", "run1",
    ]);
  });

  test("a change main already carries, reworked after review, conflicts with a note naming main's commit and asking to keep both sides", () => {
    // ct-70983: the commit channel committed the session's tree, which held the
    // reviewed change and a fix written after review, in the same file.
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("intro.txt", "say which side offers what to whom, reworked\nand a line written after review\n", "the tree, committed");
    const landed = git(origin, "rev-parse", "--short", "main");
    const r = station();
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: false, landed: false });
    expect(r.json.why).toContain(`conflicted in intro.txt (intro.txt: ${landed} the tree, committed)`);
    expect(r.comments).toContain(`intro.txt: ${landed} the tree, committed`);
    expect(r.comments).toContain("keeping both sides");
    expect(r.comments).toContain("never overwrite origin/main's own edits");
    expect(r.comments).not.toContain("keeping the approved change");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  test("a change only partly on the default branch names only the file that conflicts, so the file still to ship is not lost", () => {
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
    expect(r.json.why).toStartWith("rebase onto origin/main conflicted in other.txt (other.txt: ");
    expect(r.json.why).not.toContain("intro.txt");
  });

  test("an untracked copy of a file the default branch now tracks moves aside, and the rebase goes on", () => {
    // ct-74465: the run's worktree held an untracked copy of a file main had since tracked.
    landOnMain("team-kit.md", "tracked on main\n", "main tracks team-kit.md");
    fs.writeFileSync(path.join(work, "team-kit.md"), "an untracked copy\n");
    fs.writeFileSync(path.join(work, "draft.md"), "untracked, not on main\n");
    const r = station();
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
    expect(fs.readFileSync(path.join(work, "team-kit.md"), "utf-8")).toBe("tracked on main\n");
    const [attempt] = fs.readdirSync(path.join(root, "run", "aside"));
    expect(fs.readFileSync(path.join(root, "run", "aside", attempt, "team-kit.md"), "utf-8")).toBe("an untracked copy\n");
    expect(fs.readFileSync(path.join(work, "draft.md"), "utf-8")).toBe("untracked, not on main\n");
    expect(r.comments).toContain("Moved 1 untracked file(s) that origin/main tracks");
  });

  test("files moved aside go back into the worktree when the rebase conflicts or the check fails", () => {
    landOnMain("intro.txt", "something else entirely\n", "a conflicting change");
    landOnMain("kit é.md", "tracked on main\n", "main tracks kit é.md");
    fs.writeFileSync(path.join(work, "kit é.md"), "an untracked copy\n");
    expect(station().code).toBe(1);
    expect(fs.readFileSync(path.join(work, "kit é.md"), "utf-8")).toBe("an untracked copy\n");

    git(work, "reset", "-q", "--hard", "origin/codecast/line-ct-1");
    landOnMain("intro.txt", "say who offers what\n", "main puts intro.txt back");
    landOnMain("other.txt", "y\n", "someone else's change");
    const r = station("echo the check is red; false");
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: true, landed: false });
    expect(fs.readFileSync(path.join(work, "kit é.md"), "utf-8")).toBe("an untracked copy\n");
  });

  test("a rebase git refuses to start is reported with git's reason, never as a conflict", () => {
    const before = git(work, "rev-parse", "HEAD");
    landOnMain("other.txt", "y\n", "someone else's change");
    fs.writeFileSync(path.join(work, ".git", "index.lock"), "");
    const r = station();
    fs.rmSync(path.join(work, ".git", "index.lock"));
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ rebased: false, landed: false });
    expect(r.json.why).toStartWith("rebase could not start: ");
    expect(r.json.why).toContain("index.lock");
    expect(r.json.why).not.toContain("conflicted");
    expect(r.comments).toContain("could not start");
    expect(r.comments).toContain("the rebase then has to run again");
    expect(r.comments).not.toContain("ship__rebase");
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
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
