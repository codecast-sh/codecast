import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitCapabilityStore } from "./gitCapability";
import { keepReason, probeWorktree, releaseSessionWorktree, type WorktreeProbe } from "./worktreeGc";

let savedCodecastDir: string | undefined;
beforeEach(() => {
  savedCodecastDir = process.env.CODECAST_DIR;
  // The git capability cache is a host file; keep the suite out of the user's.
  process.env.CODECAST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wtgc-home-"));
});
afterEach(() => {
  fs.rmSync(process.env.CODECAST_DIR!, { recursive: true, force: true });
  if (savedCodecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = savedCodecastDir;
});

test("daemon GC is opt-in for retirement, never account or agent recycling", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf8");
  const kill = source.slice(source.indexOf("async function killConversationBackends("), source.indexOf("async function killConversationBackendsForAgentSwitch("));
  expect(kill).toContain("retireWorkspace = false");
  expect(kill).toContain("if (retireWorkspace && gcCwd && (teardown.killedAppServer || teardownPlan.reapPidTree)");
  expect(source.match(/killConversationBackends\([^\n]*, true\)/g)).toEqual([
    "killConversationBackends(conversationId, sessionIdHint, true)",
  ]);
  expect(source).toContain("killConversationBackends(convId, sessionIds[convId])");
});

describe("keepReason", () => {
  test("clean and on origin → release", () => {
    expect(keepReason({ dirty: false, aheadOfOrigin: 0, contentInBase: true })).toBeNull();
  });
  test("dirty, ahead, or unknown → keep, with the reason", () => {
    expect(keepReason({ dirty: true, aheadOfOrigin: 0, contentInBase: true })).toBe("uncommitted changes");
    expect(keepReason({ dirty: false, aheadOfOrigin: 2, contentInBase: false })).toBe("2 commit(s) not on origin");
    expect(keepReason({ dirty: false, aheadOfOrigin: null, contentInBase: false })).toMatch(/cannot tell/);
  });
  test("content already on the base outranks the commit count", () => {
    expect(keepReason({ dirty: false, aheadOfOrigin: 3, contentInBase: true })).toBeNull();
    expect(keepReason({ dirty: false, aheadOfOrigin: null, contentInBase: true })).toBeNull();
  });
});

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo with an "origin" clone, so origin/main exists and worktrees can be probed. */
function makeRepo(): { origin: string; repo: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtgc-"));
  const origin = path.join(dir, "origin");
  fs.mkdirSync(origin);
  sh(origin, "git", ["init", "-q", "-b", "main"]);
  sh(origin, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root"]);
  const repo = path.join(dir, "repo");
  sh(dir, "git", ["clone", "-q", origin, repo]);
  return { origin, repo };
}

function commit(cwd: string, message: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), body);
  sh(cwd, "git", ["add", "-A"]);
  sh(cwd, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", message]);
}

/** A worktree of `repo` at `.codecast/worktrees/<name>`, on its own branch. */
function addWorktree(repo: string, name: string): string {
  const wt = path.join(repo, ".codecast", "worktrees", name);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  sh(repo, "git", ["worktree", "add", "-q", "-b", `codecast/${name}`, wt]);
  return wt;
}

describe("releaseSessionWorktree", () => {
  test("keeps shared worktrees and fails closed when the session roster is unavailable", async () => {
    const { repo } = makeRepo();
    const wt = path.join(repo, ".codecast", "worktrees", "shared");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    sh(repo, "git", ["worktree", "add", "-q", "-b", "codecast/shared", wt]);
    expect(await releaseSessionWorktree(wt, () => {}, async () => true)).toMatchObject({ action: "kept", reason: "another session uses this worktree" });
    expect(await releaseSessionWorktree(wt, () => {}, async () => { throw new Error("offline"); })).toMatchObject({ action: "kept", reason: "cannot verify exclusive session ownership" });
    expect(fs.existsSync(wt)).toBe(true);
    expect(await releaseSessionWorktree(wt, () => {}, async () => false)).toMatchObject({ action: "released" });
  }, 30_000);
  test("ignores paths that are not codecast worktrees", async () => {
    expect(await releaseSessionWorktree(undefined)).toEqual({ action: "skipped", reason: "no cwd" });
    expect((await releaseSessionWorktree("/tmp/plain")).action).toBe("skipped");
  });

  test("releases a clean worktree whose branch is on origin, keeps a dirty one", async () => {
    const { repo } = makeRepo();
    const wtDir = path.join(repo, ".codecast", "worktrees");
    fs.mkdirSync(wtDir, { recursive: true });
    const clean = path.join(wtDir, "clean-one");
    const dirty = path.join(wtDir, "dirty-one");
    sh(repo, "git", ["worktree", "add", "-q", "-b", "codecast/clean-one", clean]);
    sh(repo, "git", ["worktree", "add", "-q", "-b", "codecast/dirty-one", dirty]);
    fs.writeFileSync(path.join(dirty, "scratch.txt"), "work in progress");

    expect(await probeWorktree(clean)).toEqual({ dirty: false, aheadOfOrigin: 0, contentInBase: true });
    const released = await releaseSessionWorktree(path.join(clean, "packages"));
    expect(released.action).toBe("released");
    expect(fs.existsSync(clean)).toBe(false);

    const kept = await releaseSessionWorktree(dirty);
    expect(kept).toMatchObject({ action: "kept", reason: "uncommitted changes" });
    expect(fs.existsSync(dirty)).toBe(true);
  }, 30_000);

  test("keeps a worktree whose content is not on origin", async () => {
    const { repo } = makeRepo();
    const wt = addWorktree(repo, "ahead");
    commit(wt, "local work", { "feature.txt": "unmerged work\n" });
    expect(await probeWorktree(wt)).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });
    const kept = await releaseSessionWorktree(wt);
    expect(kept).toMatchObject({ action: "kept", reason: "1 commit(s) not on origin" });
    expect(fs.existsSync(wt)).toBe(true);
  }, 30_000);

  test("releases a branch whose commits were squash merged into origin", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "squashed");
    commit(wt, "step one", { "feature.txt": "half\n" });
    commit(wt, "step two", { "feature.txt": "half\nwhole\n" });
    // The merge lands on origin as one new commit: the branch stays 2 ahead.
    commit(origin, "squash merge (#1)", { "feature.txt": "half\nwhole\n" });

    // probeWorktree fetches, so the clone has not seen the merge yet.
    const probe = await probeWorktree(wt);
    expect(probe).toMatchObject({ dirty: false, aheadOfOrigin: 2, contentInBase: true });
    expect(await releaseSessionWorktree(wt)).toMatchObject({ action: "released" });
    expect(fs.existsSync(wt)).toBe(false);
  }, 30_000);

  test("releases a branch that was rebased onto a moved base before merging", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "rebased");
    commit(wt, "feature", { "feature.txt": "work\n" });
    commit(origin, "someone else", { "other.txt": "unrelated\n" });
    commit(origin, "feature (rebased)", { "feature.txt": "work\n" });

    expect(await probeWorktree(wt)).toMatchObject({ aheadOfOrigin: 1, contentInBase: true });
    expect(await releaseSessionWorktree(wt)).toMatchObject({ action: "released" });
    expect(fs.existsSync(wt)).toBe(false);
  }, 30_000);

  test("a conflicting branch is content, not a merge proof", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "conflict");
    commit(wt, "mine", { "feature.txt": "mine\n" });
    commit(origin, "theirs", { "feature.txt": "theirs\n" });

    expect(await probeWorktree(wt)).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });
    expect(await releaseSessionWorktree(wt)).toMatchObject({ action: "kept" });
    expect(fs.existsSync(wt)).toBe(true);
  }, 30_000);
});

describe("fetching origin", () => {
  test("one fetch per repo covers a burst of releases", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "burst");
    commit(wt, "work", { "feature.txt": "work\n" });
    expect(await probeWorktree(wt, { repoKey: repo })).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });

    commit(origin, "merge the branch", { "feature.txt": "work\n" });
    // The next worktree of the same repo reuses that fetch, so it still reads
    // the origin refs from before the merge.
    expect(await probeWorktree(wt, { repoKey: repo })).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });
    // A different repo is a different remote to refresh, and it sees the merge.
    expect(await probeWorktree(wt, { repoKey: `${repo}-other` })).toMatchObject({ contentInBase: true });
  }, 30_000);

  test("a failed fetch answers from the origin refs already on disk", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "offline");
    sh(repo, "git", ["remote", "set-url", "origin", path.join(path.dirname(origin), "gone")]);

    expect(await probeWorktree(wt)).toEqual({ dirty: false, aheadOfOrigin: 0, contentInBase: true });
    expect(await releaseSessionWorktree(wt)).toMatchObject({ action: "released" });
    expect(fs.existsSync(wt)).toBe(false);
  }, 30_000);
});

describe("old git without merge-tree --write-tree", () => {
  /** A `git` that rejects `--write-tree` the way pre-2.38 git does, and logs the attempt. */
  function shimOldGit(dir: string, log: string): string {
    const realGit = execFileSync("command", ["-v", "git"], { encoding: "utf8", shell: "/bin/sh" }).trim();
    const bin = path.join(dir, "old-git-bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--write-tree" ]; then
    echo attempt >> ${JSON.stringify(log)}
    echo "error: unknown option \\\`write-tree'" >&2
    exit 129
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
      { mode: 0o755 },
    );
    return bin;
  }

  /** Probe in a child process, because a PATH shim only reaches a fresh spawn. */
  async function probeOnHost(worktree: string, env: Record<string, string>): Promise<WorktreeProbe> {
    const child = Bun.spawn(
      [process.execPath, "-e", `
        import { probeWorktree } from ${JSON.stringify(path.join(import.meta.dir, "worktreeGc.ts"))};
        console.log(JSON.stringify(await probeWorktree(${JSON.stringify(worktree)})));
      `],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(out.trim()) as WorktreeProbe;
  }

  test("falls back to the commit count, without retrying the rejected option each run", async () => {
    const { origin, repo } = makeRepo();
    const wt = addWorktree(repo, "old-host");
    commit(wt, "step one", { "feature.txt": "done\n" });
    commit(origin, "squash merge (#2)", { "feature.txt": "done\n" });

    const log = path.join(repo, "write-tree-attempts.log");
    const env = {
      PATH: `${shimOldGit(repo, log)}:${process.env.PATH}`,
      // This host's capability cache belongs to this host's git, shim included.
      CODECAST_DIR: path.join(repo, "old-host-home"),
    };
    const first = await probeOnHost(wt, env);
    expect(first).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });
    expect(keepReason(first)).toBe("1 commit(s) not on origin");
    // A second run is a second process: it reads the cache instead of the option.
    expect(await probeOnHost(wt, env)).toMatchObject({ aheadOfOrigin: 1, contentInBase: false });
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["attempt"]);

    // The same cache file, seen by an upgraded git: a different version is a
    // different key, so the capability is probed again and the merge is visible.
    const cachePath = path.join(env.CODECAST_DIR, "git-capabilities.json");
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8")).capabilities).toEqual({ "merge-tree-write-tree": false });
    const upgraded = createGitCapabilityStore({ cachePath, gitVersion: "git version 99.0.0" });
    expect(await probeWorktree(wt, { capabilities: upgraded })).toMatchObject({ aheadOfOrigin: 1, contentInBase: true });
    expect(await releaseSessionWorktree(wt)).toMatchObject({ action: "released" });
  }, 30_000);
});
