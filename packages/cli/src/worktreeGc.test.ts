import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keepReason, probeWorktree, releaseSessionWorktree } from "./worktreeGc";

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
    expect(keepReason({ dirty: false, aheadOfOrigin: 0 })).toBeNull();
  });
  test("dirty, ahead, or unknown → keep, with the reason", () => {
    expect(keepReason({ dirty: true, aheadOfOrigin: 0 })).toBe("uncommitted changes");
    expect(keepReason({ dirty: false, aheadOfOrigin: 2 })).toBe("2 commit(s) not on origin");
    expect(keepReason({ dirty: false, aheadOfOrigin: null })).toMatch(/cannot tell/);
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
  });
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

    expect(probeWorktree(clean)).toEqual({ dirty: false, aheadOfOrigin: 0 });
    const released = await releaseSessionWorktree(path.join(clean, "packages"));
    expect(released.action).toBe("released");
    expect(fs.existsSync(clean)).toBe(false);

    const kept = await releaseSessionWorktree(dirty);
    expect(kept).toMatchObject({ action: "kept", reason: "uncommitted changes" });
    expect(fs.existsSync(dirty)).toBe(true);
  });

  test("keeps a worktree with commits that are not on origin", async () => {
    const { repo } = makeRepo();
    const wt = path.join(repo, ".codecast", "worktrees", "ahead");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    sh(repo, "git", ["worktree", "add", "-q", "-b", "codecast/ahead", wt]);
    sh(wt, "git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "local work"]);
    const kept = await releaseSessionWorktree(wt);
    expect(kept).toMatchObject({ action: "kept", reason: "1 commit(s) not on origin" });
    expect(fs.existsSync(wt)).toBe(true);
  });
});
