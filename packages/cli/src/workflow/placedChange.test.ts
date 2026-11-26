// cast flow run --device (ct-98920): which machine a run goes to, and how its
// change gets there. Real git: an origin, the asking machine's clone and the
// run machine's clone; the run machine's `cast ws` is a stand-in that makes a
// plain git worktree.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { flowDeviceChoice, preparePlacedChange, pushChangeBranch, repoKeyMatches, type CastRun } from "./placedChange";
import { changeReturnWords, readFrozenChange, type FrozenChange } from "./flowChangeFile";
import { refreezeSessionChange } from "./flowChange";

const ORIGIN = "git@github.com:codecast-sh/codecast.git";

describe("flowDeviceChoice", () => {
  const config = { device: "nose", devices: { "codecast-sh/codecast": "acme-box" } };
  test("--device wins over every default, and here keeps the run local", () => {
    expect(flowDeviceChoice("b8335a40", config, ORIGIN)).toEqual({ name: "b8335a40", from: "--device" });
    expect(flowDeviceChoice("here", config, ORIGIN)).toBeNull();
    expect(flowDeviceChoice("Local", config, ORIGIN)).toBeNull();
  });
  test("a repository's default comes before the default for every repository", () => {
    expect(flowDeviceChoice(undefined, config, ORIGIN)).toEqual({ name: "acme-box", from: "flow.device.codecast-sh/codecast" });
    expect(flowDeviceChoice(undefined, config, "https://github.com/someone/else")).toEqual({ name: "nose", from: "flow.device" });
    expect(flowDeviceChoice(undefined, { devices: config.devices }, "https://github.com/someone/else")).toBeNull();
    expect(flowDeviceChoice(undefined, undefined, null)).toBeNull();
  });
  test("a repository key matches by owner/name or by a full origin, never by a shared suffix alone", () => {
    expect(repoKeyMatches("codecast-sh/codecast", "github.com/codecast-sh/codecast")).toBe(true);
    expect(repoKeyMatches("https://github.com/codecast-sh/codecast.git", "github.com/codecast-sh/codecast")).toBe(true);
    expect(repoKeyMatches("sh/codecast", "github.com/codecast-sh/codecast")).toBe(false);
  });
});

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const saved: Record<string, string | undefined> = {};
let sandbox = "";
beforeAll(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-placed-")));
  for (const [k, v] of Object.entries({ ...ENV, HOME: sandbox })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(sandbox, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, ...ENV } }).trim();

/** The run machine's `cast ws`: path answers where an earlier worktree is, acquire makes one on the branch. */
function fakeCast(worktrees: string): CastRun {
  return async (args, cwd) => {
    const dir = path.join(worktrees, args[2] ?? "");
    if (args[1] === "path") return { code: 0, out: fs.existsSync(dir) ? dir : "", err: "" };
    if (args[1] === "acquire") {
      if (!fs.existsSync(dir)) git(cwd, "worktree", "add", "-q", dir, args[4]);
      return { code: 0, out: JSON.stringify({ path: dir }), err: "" };
    }
    return { code: 1, out: "", err: `unexpected cast ${args.join(" ")}` };
  };
}

describe("a change placed on another machine", () => {
  test("the asking machine pushes the frozen branch; the run machine fetches it, makes the worktree, and follows each refreeze by fetching", async () => {
    const origin = path.join(sandbox, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const laptop = path.join(sandbox, "laptop");
    execFileSync("git", ["clone", "-q", origin, laptop]);
    fs.writeFileSync(path.join(laptop, "a.ts"), "one\n");
    git(laptop, "add", "a.ts");
    git(laptop, "commit", "-q", "-m", "base");
    git(laptop, "push", "-q", "origin", "main");
    const box = path.join(sandbox, "box");
    execFileSync("git", ["clone", "-q", origin, box]);

    // The session's edit, frozen onto the run's branch without touching the laptop's tree (as freezeSessionChange does).
    const branch = "codecast/change-ct-1";
    git(laptop, "checkout", "-q", "-b", branch);
    fs.writeFileSync(path.join(laptop, "a.ts"), "two\n");
    git(laptop, "commit", "-q", "-am", "the change");
    const tip = git(laptop, "rev-parse", "HEAD");
    git(laptop, "checkout", "-q", "main");
    const change: FrozenChange = { source: "session", session: "jx70y3y", conversation: "conv1", base: tip, tip, branch, worktree: "change-ct-1", paths: ["a.ts"], shared: [], held: [], pushed: true };
    expect(pushChangeBranch(laptop, change)).toBeNull();

    const runDir = path.join(box, ".git", "codecast-runs", change.worktree);
    const worktrees = path.join(sandbox, "box-worktrees");
    const ready = await preparePlacedChange(box, runDir, change, fakeCast(worktrees), "run1");
    expect(ready).toMatchObject({ tip, pushed: true, branch, run: "run1" });
    expect(readFrozenChange(runDir)).toMatchObject({ tip, pushed: true, session: "jx70y3y" });
    const wt = path.join(worktrees, change.worktree);
    expect(fs.readFileSync(path.join(wt, "a.ts"), "utf-8")).toBe("two\n");

    // The subject freezes its fix on the laptop with cast flow refreeze, which never touches the shared tree, and pushes
    // (the commit below stands in for that freeze); the run fetches, never freezes the box's tree.
    expect(changeReturnWords(ready)).toContain("`cast flow refreeze run1` in this checkout");
    expect(changeReturnWords(ready)).not.toMatch(/git (checkout|switch|stash)/);
    expect(changeReturnWords({ ...ready, source: "branch" })).toContain("never by switching a shared tree");
    git(laptop, "checkout", "-q", branch);
    fs.writeFileSync(path.join(laptop, "a.ts"), "three\n");
    git(laptop, "commit", "-q", "-am", "the fix");
    expect(pushChangeBranch(laptop, change)).toBeNull();
    const { change: after, moved } = await refreezeSessionChange(box, runDir, wt);
    expect(moved).toBe(true);
    expect(after.tip).toBe(git(laptop, "rev-parse", "HEAD"));
    expect(fs.readFileSync(path.join(wt, "a.ts"), "utf-8")).toBe("three\n");

    // A second run of the same change on the box, after the tip moved to new content: the clean earlier worktree is
    // read before its branch moves (never refused as holding work), then follows the new tip.
    fs.writeFileSync(path.join(laptop, "a.ts"), "four\n");
    git(laptop, "commit", "-q", "--amend", "-am", "the fix, again");
    expect(pushChangeBranch(laptop, change)).toBeNull();
    const again = await preparePlacedChange(box, runDir, change, fakeCast(worktrees));
    expect(again.tip).toBe(git(laptop, "rev-parse", "HEAD"));
    expect(git(wt, "rev-parse", "HEAD")).toBe(again.tip);
    expect(fs.readFileSync(path.join(wt, "a.ts"), "utf-8")).toBe("four\n");

    // A commit made on the box and never pushed is never dropped: the rerun is refused and the branch keeps it.
    fs.writeFileSync(path.join(wt, "a.ts"), "box-only\n");
    git(wt, "commit", "-q", "-am", "made on the box, never pushed");
    const boxOnly = git(wt, "rev-parse", "HEAD");
    await expect(preparePlacedChange(box, runDir, change, fakeCast(worktrees))).rejects.toThrow(/has commits origin does not/);
    expect(git(box, "rev-parse", branch)).toBe(boxOnly);
    expect(git(wt, "rev-parse", "HEAD")).toBe(boxOnly);
    git(wt, "reset", "-q", "--hard", again.tip);

    // Work left uncommitted in that worktree is never reset: the rerun is refused and the branch stays where it was.
    fs.writeFileSync(path.join(wt, "a.ts"), "someone's work\n");
    const before = git(box, "rev-parse", branch);
    fs.writeFileSync(path.join(laptop, "a.ts"), "five\n");
    git(laptop, "commit", "-q", "-am", "more");
    expect(pushChangeBranch(laptop, change)).toBeNull();
    await expect(preparePlacedChange(box, runDir, change, fakeCast(worktrees))).rejects.toThrow(/holds uncommitted work/);
    expect(git(box, "rev-parse", branch)).toBe(before);
    expect(fs.readFileSync(path.join(wt, "a.ts"), "utf-8")).toBe("someone's work\n");
  });

  test("a named branch is never forced: a copy behind origin is refused and origin keeps what was pushed there", () => {
    const origin = path.join(sandbox, "origin.git");
    const laptop = path.join(sandbox, "laptop");
    const other = path.join(sandbox, "other");
    execFileSync("git", ["clone", "-q", origin, other]);
    const branch = "codecast/change-ct-9";
    git(laptop, "branch", "-f", branch, "main");
    const named = { source: "branch" as const, branch };
    expect(pushChangeBranch(laptop, named)).toBeNull();
    // An implementer pushes to the branch from elsewhere; the laptop's copy is now behind.
    git(other, "fetch", "-q", "origin", branch);
    git(other, "checkout", "-q", "-b", branch, "FETCH_HEAD");
    fs.writeFileSync(path.join(other, "b.ts"), "pushed\n");
    git(other, "add", "b.ts");
    git(other, "commit", "-q", "-m", "an implementer's commit");
    git(other, "push", "-q", "origin", branch);
    const pushed = git(other, "rev-parse", "HEAD");
    for (const source of ["branch", "task"] as const) {
      expect(pushChangeBranch(laptop, { source, branch })).toContain("has commits this copy lacks");
    }
    expect(git(origin, "rev-parse", branch)).toBe(pushed);
    // The run's own frozen branch is forced, the way a refreeze rewrites it.
    expect(pushChangeBranch(laptop, { source: "session", branch })).toBeNull();
    expect(git(origin, "rev-parse", branch)).toBe(git(laptop, "rev-parse", branch));
  });

  test("a worktree the run's machine cannot make fails the run with why", async () => {
    const box = path.join(sandbox, "box");
    const change: FrozenChange = { source: "branch", base: "x", tip: "x", branch: "main", worktree: "no-room", paths: [], shared: [], held: [], pushed: true };
    const refuse: CastRun = async (args) => (args[1] === "acquire" ? { code: 1, out: "", err: "disk full\n" } : { code: 0, out: "", err: "" });
    await expect(preparePlacedChange(box, path.join(sandbox, "rd2"), change, refuse)).rejects.toThrow(/Could not make the worktree for the change: disk full/);
  });

  test("a branch origin does not have, and a checkout not on this machine, fail with why", async () => {
    const box = path.join(sandbox, "box");
    const change: FrozenChange = { source: "branch", base: "x", tip: "x", branch: "nowhere", worktree: "w", paths: [], shared: [], held: [], pushed: true };
    await expect(preparePlacedChange(box, path.join(sandbox, "rd"), change, fakeCast(sandbox))).rejects.toThrow(/Could not fetch nowhere from origin/);
    await expect(preparePlacedChange("/no/such/checkout", path.join(sandbox, "rd"), change, fakeCast(sandbox))).rejects.toThrow(/not on this machine/);
  });
});
