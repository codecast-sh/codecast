import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { expandScriptVars } from "./runner.js";
import { extractJsonOutput } from "./condition.js";
import { lineCommandEnv } from "../lineProfile.js";

// The line's red station (templates/line/red.sh) against real repositories,
// for a prompt cause: red runs the project's prove command on the base, and
// that command keeps the prove hand's recorded replays only when it measures
// on the base the hand measured on. The stub prove command records the base
// the way Union's does (the merge base with origin/<default branch>).

const SCRIPT = fs.readFileSync(path.join(import.meta.dir, "templates/line/red.sh"), "utf-8");
const PROVE = 'git merge-base origin/main HEAD >> "$run_dir/bases"';

describe("line red station", () => {
  let root: string;
  let origin: string;
  let box: string;
  let work: string;
  let bin: string;
  let runDir: string;

  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...gitEnv } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", msg);
  };
  // Main moves in a second clone and is pushed, the way other people's work lands.
  const landOnMain = (msg: string) => {
    const other = path.join(root, `other-${Math.random().toString(36).slice(2, 8)}`);
    git(root, "clone", "-q", origin, other);
    commit(other, "other.txt", msg, msg);
    git(other, "push", "-q", "origin", "main");
  };
  const context = (): Record<string, string> => ({
    worktree: "line-ct-1", branch: "codecast/line-ct-1", default_branch: "main", task_id: "ct-1",
    category: "prompt", run_dir: runDir, "line.commands.prove": PROVE,
  });
  const env = () => ({ ...process.env, ...gitEnv, ...lineCommandEnv(context()), PATH: `${bin}:${process.env.PATH}` });
  // The prove hand runs the command itself from the worktree, as prove.md tells it to.
  const hand = () => {
    const r = spawnSync("bash", ["-c", PROVE], { cwd: work, encoding: "utf-8", env: env() });
    expect(r.status).toBe(0);
  };
  const red = () => {
    const r = spawnSync("bash", ["-c", expandScriptVars(SCRIPT, context())], { cwd: box, encoding: "utf-8", env: env() });
    return extractJsonOutput(r.stdout) as any;
  };
  const bases = () => fs.readFileSync(path.join(runDir, "bases"), "utf-8").trim().split("\n");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-red-station-"));
    origin = path.join(root, "origin.git");
    box = path.join(root, "box");
    work = path.join(root, "worktree");
    bin = path.join(root, "bin");
    runDir = path.join(root, "run");
    fs.mkdirSync(runDir);
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, box);
    commit(box, "prompt.txt", "ask the go-ahead\n", "base");
    git(box, "push", "-q", "origin", "main");
    // The box's local main stays here while the remote moves on: nobody pulls it.
    landOnMain("a week of other work");
    git(box, "fetch", "-q", "origin");
    // Every run cuts its worktree from the default branch as the remote has it.
    git(box, "worktree", "add", "-q", "-b", "codecast/line-ct-1", work, "origin/main");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/bash
if [ "$1 $2" = "ws path" ]; then echo "${work}"; exit 0; fi
exit 0
`, { mode: 0o755 });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("red runs the prove command on the base the hand proved on, though the box's local main is stale", () => {
    hand();
    expect(red()).toMatchObject({ red: true });
    const [handBase, redBase] = bases();
    expect(handBase).toBe(git(box, "rev-parse", "origin/main"));
    expect(redBase).toBe(handBase);
  });

  test("main moving and being fetched between the hand and red leaves the base where the hand proved", () => {
    hand();
    landOnMain("lands while the hand hands off");
    git(box, "fetch", "-q", "origin");
    expect(red()).toMatchObject({ red: true });
    const [handBase, redBase] = bases();
    expect(redBase).toBe(handBase);
  });

  test("a branch carrying an earlier round's commits is checked on its merge base and returned to", () => {
    commit(work, "prompt.txt", "confirm the go-ahead once\n", "fix(ct-1): an earlier round");
    hand();
    expect(red()).toMatchObject({ red: true });
    const [handBase, redBase] = bases();
    expect(redBase).toBe(handBase);
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/line-ct-1");
  });
});
