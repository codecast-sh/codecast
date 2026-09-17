import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireWorkspace, healWorkspace, releaseWorkspace } from "./lifecycle.js";
import { readState } from "./contract.js";

// `cast ws acquire --start-point <ref> --branch <b> [--alt-branch <b2>]`: how a
// cloud worktree is created at the laptop's seed (ct-49433). Real git, because
// the properties (git's atomic branch creation decides the name, argv-only
// calls, the seed ref and branch are dropped on release) are git's.

let repoRoot: string;
let savedDir: string | undefined;
// agentDriven: false because the trust gate refuses an untrusted setup command from an agent shell
// (the runner may export CLAUDECODE); these tests need setup to run and fail, not be refused.
const opts = { skipSetup: true, skipHooks: true, skipBrowser: true, skipPool: true, agentDriven: false };
const SEED_REF = "refs/codecast/cloud/w1";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const branches = () => git(repoRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);
const hasRef = (ref: string) => { try { git(repoRoot, "show-ref", "--verify", "--quiet", ref); return true; } catch { return false; } };

let base: string;
let snapshot: string;

beforeEach(() => {
  repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ws-seed-")));
  savedDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repoRoot, "host-state");
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "config", "user.email", "t@t.t");
  git(repoRoot, "config", "user.name", "t");
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-qm", "init");
  // The "laptop seed": a snapshot commit (an extra untracked file) whose parent is the base.
  base = git(repoRoot, "rev-parse", "HEAD");
  const tree = (() => {
    const idx = path.join(repoRoot, "seed-index");
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    execFileSync("git", ["-C", repoRoot, "read-tree", "HEAD"], { env, stdio: "ignore" });
    fs.writeFileSync(path.join(repoRoot, "wip.txt"), "laptop work in progress\n");
    execFileSync("git", ["-C", repoRoot, "add", "wip.txt"], { env, stdio: "ignore" });
    const t = execFileSync("git", ["-C", repoRoot, "write-tree"], { env, encoding: "utf-8" }).trim();
    fs.rmSync(path.join(repoRoot, "wip.txt"));
    fs.rmSync(idx, { force: true });
    return t;
  })();
  snapshot = git(repoRoot, "commit-tree", tree, "-p", base, "-m", "codecast wip snapshot");
  git(repoRoot, "update-ref", SEED_REF, snapshot);
});

afterEach(() => {
  try { execFileSync("git", ["-C", repoRoot, "worktree", "prune"], { stdio: "ignore" }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedDir;
});

describe("acquire --start-point", () => {
  test("creates the branch at the snapshot's parent with the snapshot as uncommitted work; state.json carries startPoint and seedBase", async () => {
    const r = await acquireWorkspace(repoRoot, "w1", { ...opts, branch: "feat/x", startPoint: SEED_REF });
    expect(r.created).toBe(true);
    expect(r.workspace.branch).toBe("feat/x");
    expect(r.workspace.startPoint).toBe(SEED_REF);
    expect(r.workspace.seedBase).toBe(base);
    // The branch never points at the snapshot commit: acquire itself resets to the base.
    expect(git(r.workspace.path, "rev-parse", "HEAD")).toBe(base);
    expect(git(repoRoot, "rev-parse", "feat/x")).toBe(base);
    expect(git(r.workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x");
    expect(git(r.workspace.path, "status", "--porcelain")).toBe("?? wip.txt");
    expect(fs.readFileSync(path.join(r.workspace.path, "wip.txt"), "utf8")).toBe("laptop work in progress\n");
    const state = readState(repoRoot, "w1")!;
    expect(state.startPoint).toBe(SEED_REF);
    expect(state.seedBase).toBe(base);
    expect(state.branch).toBe("feat/x");
    // Without a start point the state carries neither field.
    const plain = await acquireWorkspace(repoRoot, "plain", opts);
    expect(readState(repoRoot, "plain")!.startPoint).toBeUndefined();
    expect(plain.workspace.seedBase).toBeUndefined();
  });

  test("an existing primary branch lands on --alt-branch (ws.branch reports it); without an alternate it is an error, never a silent attach", async () => {
    git(repoRoot, "branch", "feat/x");
    const r = await acquireWorkspace(repoRoot, "w1", { ...opts, branch: "feat/x", startPoint: SEED_REF, altBranch: "feat/x-w1" });
    expect(r.workspace.branch).toBe("feat/x-w1");
    expect(readState(repoRoot, "w1")!.branch).toBe("feat/x-w1");
    expect(git(r.workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x-w1");
    expect(git(repoRoot, "rev-parse", "feat/x")).toBe(base); // untouched
    await expect(acquireWorkspace(repoRoot, "w2", { ...opts, branch: "feat/x", startPoint: SEED_REF })).rejects.toThrow(/git worktree add -b feat\/x: fatal: a branch named 'feat\/x' already exists/);
    expect(fs.existsSync(path.join(repoRoot, ".codecast/worktrees/w2"))).toBe(false);
    // A second collision (the alternate exists too) is an error as well.
    git(repoRoot, "branch", "feat/x-w3");
    await expect(acquireWorkspace(repoRoot, "w3", { ...opts, branch: "feat/x", startPoint: SEED_REF, altBranch: "feat/x-w3" })).rejects.toThrow(/git worktree add -b feat\/x-w3: fatal: a branch named 'feat\/x-w3' already exists/);
  });

  test("a plain commit-ish start point is the base itself: no reset, heal and the GC read it as unchanged", async () => {
    const r = await acquireWorkspace(repoRoot, "gen", { ...opts, branch: "gen-b", startPoint: "main" });
    expect(git(r.workspace.path, "rev-parse", "HEAD")).toBe(base);
    expect(readState(repoRoot, "gen")!.seedBase).toBe(base);
    expect(git(r.workspace.path, "status", "--porcelain")).toBe("");
  });

  test("a failing setup after the alternate branch won leaves a record naming the ALTERNATE; release drops it and leaves the primary alone", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codecast/workspace.toml"), '[setup]\ninstall = ["exit 7"]\n');
    git(repoRoot, "add", ".codecast/workspace.toml");
    git(repoRoot, "commit", "-qm", "manifest");
    const primaryTip = git(repoRoot, "rev-parse", "HEAD");
    git(repoRoot, "branch", "feat/x");
    await expect(acquireWorkspace(repoRoot, "w1", { ...opts, skipSetup: false, branch: "feat/x", startPoint: SEED_REF, altBranch: "feat/x-w1" })).rejects.toThrow();
    const state = readState(repoRoot, "w1")!;
    expect(state.state).toBe("broken");
    expect(state.branch).toBe("feat/x-w1");
    expect(git(state.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x-w1");
    await releaseWorkspace(repoRoot, "w1");
    expect(branches()).not.toContain("feat/x-w1");
    expect(git(repoRoot, "rev-parse", "feat/x")).toBe(primaryTip);
    expect(hasRef(SEED_REF)).toBe(false);
  });

  test("a failing setup on a seeded acquire never leaves the branch at the snapshot commit; release removes the branch and the ref", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".codecast/workspace.toml"), '[setup]\ninstall = ["false"]\n');
    await expect(acquireWorkspace(repoRoot, "w1", { ...opts, skipSetup: false, branch: "feat/x", startPoint: SEED_REF })).rejects.toThrow();
    expect(readState(repoRoot, "w1")!.state).toBe("broken");
    expect(git(repoRoot, "rev-parse", "feat/x")).toBe(base);
    expect(git(repoRoot, "log", "-1", "--format=%s", "feat/x")).not.toBe("codecast wip snapshot");
    await releaseWorkspace(repoRoot, "w1");
    expect(branches()).toEqual(["main"]);
    expect(hasRef(SEED_REF)).toBe(false);
    // Even a branch left AT the snapshot commit (creation died before the reset) holds nothing host-made.
    git(repoRoot, "update-ref", "refs/codecast/cloud/w2", snapshot);
    const r2 = await acquireWorkspace(repoRoot, "w2", { ...opts, branch: "feat/y", startPoint: "refs/codecast/cloud/w2" });
    git(r2.workspace.path, "reset", "-q", "--soft", snapshot);
    await releaseWorkspace(repoRoot, "w2");
    expect(branches()).toEqual(["main"]);
  });

  test("an existing workspace name with a start point is an error, never the old worktree", async () => {
    const first = await acquireWorkspace(repoRoot, "dup", opts);
    expect(first.workspace.branch).toBe("codecast/dup");
    await expect(acquireWorkspace(repoRoot, "dup", { ...opts, branch: "other", startPoint: SEED_REF })).rejects.toThrow("workspace dup already exists; a start point needs a fresh name");
    expect(readState(repoRoot, "dup")!.branch).toBe("codecast/dup");
    expect(branches()).not.toContain("other");
  });

  test("an existing worktree directory with a start point is an error; a start point needs a branch; an alternate needs a start point", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast/worktrees/w1"), { recursive: true });
    await expect(acquireWorkspace(repoRoot, "w1", { ...opts, branch: "feat/x", startPoint: SEED_REF })).rejects.toThrow("already exists");
    await expect(acquireWorkspace(repoRoot, "w4", { ...opts, startPoint: SEED_REF })).rejects.toThrow("a start point needs an explicit branch name");
    await expect(acquireWorkspace(repoRoot, "w5", { ...opts, branch: "b", altBranch: "c" })).rejects.toThrow("altBranch only applies with a start point");
  });

  test("branch names are argv, never a shell: `a;b` is a literal branch and `$(touch …)` is refused by git itself", async () => {
    const r = await acquireWorkspace(repoRoot, "w1", { ...opts, branch: "a;b", startPoint: SEED_REF });
    expect(r.workspace.branch).toBe("a;b");
    expect(branches()).toContain("a;b");
    const sentinel = path.join(repoRoot, "sentinel");
    await expect(acquireWorkspace(repoRoot, "w2", { ...opts, branch: `x $(touch ${sentinel})`, startPoint: SEED_REF })).rejects.toThrow(/is not a valid branch name/);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  test("heal recreates a removed worktree from the start point and resets it to the seed base", async () => {
    const r = await acquireWorkspace(repoRoot, "w1", { ...opts, branch: "feat/x", startPoint: SEED_REF });
    // What the laptop's finishSeededWorktree does after acquire.
    git(r.workspace.path, "reset", "-q", "--mixed", base);
    expect(git(r.workspace.path, "rev-parse", "HEAD")).toBe(base);
    fs.rmSync(r.workspace.path, { recursive: true, force: true });
    const healed = await healWorkspace(repoRoot, "w1");
    expect(healed.state).toBe("ready");
    expect(healed.branch).toBe("feat/x");
    expect(git(healed.path, "rev-parse", "HEAD")).toBe(base);
    expect(git(healed.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x");
    // heal re-runs setup, whose log lands under .codecast/; the laptop's work is back as untracked.
    expect(git(healed.path, "status", "--porcelain").split("\n").filter((l) => !l.includes(".codecast/"))).toEqual(["?? wip.txt"]);
    expect(fs.readFileSync(path.join(healed.path, "wip.txt"), "utf8")).toBe("laptop work in progress\n");
    // A branch that advanced on the host keeps its tree as committed: no re-seed.
    fs.writeFileSync(path.join(healed.path, "host.txt"), "host commit\n");
    git(healed.path, "add", "host.txt");
    git(healed.path, "commit", "-qm", "host work");
    const advanced = git(healed.path, "rev-parse", "HEAD");
    fs.rmSync(healed.path, { recursive: true, force: true });
    const again = await healWorkspace(repoRoot, "w1");
    expect(git(again.path, "rev-parse", "HEAD")).toBe(advanced);
    expect(git(again.path, "status", "--porcelain").split("\n").filter((l) => l && !l.includes(".codecast/"))).toEqual([]);
  });

  test("release deletes the seed ref and a branch whose tip is still the seed base, and keeps a branch that advanced", async () => {
    const r = await acquireWorkspace(repoRoot, "w1", { ...opts, branch: "feat/x", startPoint: SEED_REF });
    git(r.workspace.path, "reset", "-q", "--mixed", base);
    expect(hasRef(SEED_REF)).toBe(true);
    await releaseWorkspace(repoRoot, "w1");
    expect(fs.existsSync(r.workspace.path)).toBe(false);
    expect(hasRef(SEED_REF)).toBe(false);
    expect(branches()).not.toContain("feat/x");

    git(repoRoot, "update-ref", "refs/codecast/cloud/w2", snapshot);
    const r2 = await acquireWorkspace(repoRoot, "w2", { ...opts, branch: "feat/y", startPoint: "refs/codecast/cloud/w2" });
    git(r2.workspace.path, "reset", "-q", "--mixed", base);
    git(r2.workspace.path, "add", "wip.txt");
    git(r2.workspace.path, "commit", "-qm", "kept on the host");
    const tip = git(r2.workspace.path, "rev-parse", "HEAD");
    await releaseWorkspace(repoRoot, "w2");
    expect(hasRef("refs/codecast/cloud/w2")).toBe(false);
    expect(branches()).toContain("feat/y");
    expect(git(repoRoot, "rev-parse", "feat/y")).toBe(tip);
    // A plain worktree's release touches no branch (today's behaviour).
    const plain = await acquireWorkspace(repoRoot, "plain", opts);
    await releaseWorkspace(repoRoot, "plain");
    expect(branches()).toContain("codecast/plain");
    expect(fs.existsSync(plain.workspace.path)).toBe(false);
  });
});
