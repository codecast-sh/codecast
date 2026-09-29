import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { remoteSnapshotScript } from "../wipSnapshot";
import { ensureSyncWorktree, syncTick, type SyncState, type SyncTickDeps } from "./liveSync";

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-sync-")));
  fs.mkdirSync(path.join(dir, "laptop"));
  git(path.join(dir, "laptop"), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "laptop/a.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "laptop/.gitignore"), "node_modules/\n");
  git(path.join(dir, "laptop"), "add", "-A");
  git(path.join(dir, "laptop"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", path.join(dir, "laptop"), path.join(dir, "host")]);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** The host is a local clone: the same snapshot script ssh would run, and a local fetch. */
function localDeps(local: string): SyncTickDeps {
  const host = path.join(dir, "host");
  return {
    snapshot: async () => execFileSync("sh", ["-c", remoteSnapshotScript({ cwd: host, ref: "refs/codecast/sync/c1" })], { encoding: "utf-8" }).trim().split("\n").pop()!,
    fetch: async () => { git(local, "fetch", "-q", host, "+refs/codecast/sync/c1:refs/codecast/sync/c1"); },
  };
}

test("the host's commits and uncommitted work land here; nothing moves when nothing changed; an edit here stops sync", async () => {
  const local = await ensureSyncWorktree(path.join(dir, "laptop"), "sync-c1");
  const host = path.join(dir, "host");
  const state: SyncState = {};
  const deps = localDeps(local);
  fs.writeFileSync(path.join(host, "a.txt"), "edited on host\n");
  fs.writeFileSync(path.join(host, "new.txt"), "untracked\n");
  fs.mkdirSync(path.join(host, "node_modules"));
  fs.writeFileSync(path.join(host, "node_modules/x.js"), "ignored");
  expect(await syncTick(local, state, deps)).toMatchObject({ landed: true });
  expect(fs.readFileSync(path.join(local, "a.txt"), "utf-8")).toBe("edited on host\n");
  expect(fs.readFileSync(path.join(local, "new.txt"), "utf-8")).toBe("untracked\n");
  expect(fs.existsSync(path.join(local, "node_modules"))).toBe(false);
  expect(git(local, "status", "--porcelain").split("\n").sort()).toEqual(["?? new.txt", "M a.txt"]);
  expect(await syncTick(local, state, deps)).toEqual({ landed: false, reason: "unchanged" });

  git(host, "add", "-A");
  git(host, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "on host");
  fs.rmSync(path.join(host, "new.txt"));
  git(host, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "removed");
  const landed = await syncTick(local, state, deps);
  expect(landed).toMatchObject({ landed: true, changed: ["new.txt"] });
  expect(git(local, "rev-parse", "HEAD")).toBe(git(host, "rev-parse", "HEAD"));
  expect(fs.existsSync(path.join(local, "new.txt"))).toBe(false);
  expect(git(local, "status", "--porcelain")).toBe("");

  fs.writeFileSync(path.join(local, "a.txt"), "my laptop edit\n");
  fs.writeFileSync(path.join(host, "a.txt"), "host moves on\n");
  expect(await syncTick(local, state, deps)).toEqual({ landed: false, reason: "local-edit", files: ["a.txt"] });
  expect(fs.readFileSync(path.join(local, "a.txt"), "utf-8")).toBe("my laptop edit\n");
});
