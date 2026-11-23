// What the Merge station (mergeStation.ts) holds on this machine while it
// works: the checkout's merge lock, and a worktree of its own to rebase and
// deploy from. The lease that orders deploys across machines is the server's
// (land/repoLease.ts).
//
// The lock makes rebase, before-merge deploys and the merge one critical
// section per checkout: two stations never share a scratch tree's sweep, and
// never interleave their convex deploys from here. It lives beside convex's
// own deploy lock, under the repository's common git dir, so every worktree
// of the checkout shares it.

import type { ChildProcess } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultExec } from "../lineMerge.js";

/** A checkout the station rebases and runs the before-merge steps in. `setup` installs what the steps need (the
 *  workspace's env files and dependencies); a merge with no step to run never pays for it, and `again` runs it anew
 *  when the dependencies changed under the tree. */
export type ScratchTree = { path: string; setup: (again?: boolean) => Promise<void>; release: () => Promise<void> };

const LOCK_POLL_MS = 2000;
const SCRATCH_PREFIX = "merge-scratch-";
/** Older than any Merge station may run (change.cast gives it 3600s, and a deploy it started may outlive it): a
 *  scratch tree this old has no step running in it, so the sweep may remove it. */
export const SCRATCH_STALE_MS = 3 * 3_600_000;
/** How long a step gets to stop after SIGTERM before its tree is left for the sweep instead. */
const STOP_GRACE_MS = 60_000;

// EPERM: the process lives but belongs to someone else; only "no such process" is dead.
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === "EPERM"; } };

const commonDir = (cwd: string) => defaultExec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).stdout.trim() || path.join(cwd, ".git");

/** The repository's main checkout, whichever worktree `cwd` is in: scratch trees go under it, never nested in a run's worktree. */
export function mainCheckout(cwd: string): string {
  const common = commonDir(cwd);
  if (path.basename(common) === ".git") return path.dirname(common);
  return defaultExec("git", ["rev-parse", "--show-toplevel"], cwd).stdout.trim() || cwd;
}

/** When a process started, as `ps` says it: with its pid, the identity a reused pid cannot fake. Empty when unknown. */
function startedAt(pid: number): string {
  return defaultExec("ps", ["-o", "lstart=", "-p", String(pid)], "/").stdout.trim().replace(/\s+/g, " ");
}

const readLock = (file: string): string | null => { try { return fs.readFileSync(file, "utf-8").trim(); } catch { return null; } };

/** The lock's holder is gone: its pid is dead, or now belongs to a process started at another time (a reboot reused
 *  it). A lock with no pid yet (its maker died between making and writing it) is gone once it is old. */
export function holderGone(content: string, file: string): boolean {
  const [pid, ...start] = content.split(" ");
  if (!Number(pid)) { try { return Date.now() - fs.statSync(file).mtimeMs > 30_000; } catch { return false; } }
  if (!alive(Number(pid))) return true;
  // A `ps` that answers nothing (a transient failure) proves nothing: only a different start time means a reused pid.
  const now = start.length ? startedAt(Number(pid)) : "";
  return now !== "" && now !== start.join(" ");
}

/**
 * Take the checkout's merge lock, waiting while a live station holds it. The lock is a file made with O_EXCL that
 * names its holder's pid and start time. A lock whose holder is gone is removed only under a takeover claim (a
 * directory made atomically, so one waiter at a time), and only when it still holds the content judged gone, so a
 * lock another waiter took meanwhile is never removed; then every waiter races on O_EXCL again. A station reads its
 * lock back to be sure it holds it, and tries again when it cannot.
 */
export async function takeMergeLock(cwd: string, log: (line: string) => void): Promise<() => void> {
  const lock = path.join(commonDir(cwd), "codecast", "merge.lock");
  const claim = `${lock}.takeover`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const me = `${process.pid} ${startedAt(process.pid)}`.trim();
  let told = "";
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, me);
      fs.closeSync(fd);
      if (readLock(lock) === me) break;
      continue;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
    const seen = readLock(lock);
    if (seen === null) continue;
    if (holderGone(seen, lock)) {
      try {
        fs.mkdirSync(claim);
      } catch {
        // Another waiter is taking it over; a claim its maker abandoned is cleared once old.
        try { if (Date.now() - fs.statSync(claim).mtimeMs > 30_000) fs.rmSync(claim, { recursive: true, force: true }); } catch {}
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      try { if (readLock(lock) === seen) fs.rmSync(lock, { force: true }); } finally { fs.rmSync(claim, { recursive: true, force: true }); }
      continue;
    }
    const pid = seen.split(" ")[0] || "unknown";
    if (told !== pid) { log(`waiting for the merge already running in this checkout (pid ${pid}) to finish`); told = pid; }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  const release = () => { if (readLock(lock) === me) fs.rmSync(lock, { force: true }); };
  process.once("exit", release);
  return release;
}

/** Release the scratch trees stations left behind (killed before their cleanup ran): only workspaces marked as the
 *  Merge station's own, older than any station runs, whose maker is gone. A workspace merely named like one is a
 *  person's and stays. Called under the merge lock. */
export async function sweepScratchTrees(repo: string, now = Date.now()): Promise<void> {
  const { listStates } = await import("../workspace/contract.js");
  const { releaseWorkspace } = await import("../workspace/lifecycle.js");
  for (const s of listStates(repo)) {
    const p = s.purpose;
    if (p?.kind !== "merge-scratch" || !s.name.startsWith(SCRATCH_PREFIX) || now - p.started_at < SCRATCH_STALE_MS || alive(p.pid)) continue;
    await releaseWorkspace(repo, s.name).catch(() => {});
    if (s.branch === `codecast/${s.name}`) defaultExec("git", ["branch", "-D", s.branch], repo);
  }
}

/** The steps running now, each in a process group of its own (runShell's onChild). */
const running = new Set<ChildProcess>();

export function trackStep(child: ChildProcess): void {
  running.add(child);
  child.once("close", () => running.delete(child));
}

/** Stop every running step's whole process group with SIGTERM (deploy.sh's launchd job boots itself out on it) and
 *  wait for each to end. False when one is still running after the grace: its tree must stay. */
export async function stopSteps(graceMs = STOP_GRACE_MS): Promise<boolean> {
  const live = [...running].filter((c) => c.exitCode === null && c.signalCode === null && c.pid);
  for (const c of live) { try { process.kill(-c.pid!, "SIGTERM"); } catch {} }
  const ended = await Promise.all(live.map((c) => new Promise<boolean>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), graceMs);
    c.once("close", () => { clearTimeout(timer); resolve(true); });
  })));
  return ended.every(Boolean);
}

/** The sha the merge landed as, once it has (merge.json is written first): a station stopped after that point still
 *  merged, and says so with exit 0, so the graph does not call a merged change "not merged". */
let landedAs: string | null = null;
export function noteLanded(sha: string): void { landedAs = sha; }

/** What production may be left on if the station is stopped now: set while a step goes out again from main to
 *  replace a deploy, so a stop in the middle says so on the way out. */
let restoring: string | null = null;
export function noteRestoring(what: string | null): void { restoring = what; }

/** On SIGTERM or SIGINT: stop the running step, then release the tree; a step that will not stop leaves its tree to
 *  the age-based sweep. Returns whether the tree was released. */
export async function shutDown(release: () => Promise<void>, graceMs = STOP_GRACE_MS): Promise<boolean> {
  if (!(await stopSteps(graceMs))) return false;
  await release();
  return true;
}

/** A worktree acquired the way a run's is (`cast ws`), marked as the station's own, without its setup until `setup`
 *  asks for it. Released on SIGTERM or SIGINT once its step has stopped; a SIGKILL leaves it to the sweep. */
export async function acquiredTree(repo: string, at: string): Promise<ScratchTree> {
  const { acquireWorkspace, healWorkspace, releaseWorkspace } = await import("../workspace/lifecycle.js");
  const name = `${SCRATCH_PREFIX}${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const branch = `codecast/${name}`;
  const purpose = { kind: "merge-scratch" as const, pid: process.pid, started_at: Date.now() };
  const { workspace } = await acquireWorkspace(repo, name, { branch, startPoint: at, purpose, noPorts: true, skipHooks: true, skipSetup: true });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.off(sig, onSignal);
    await releaseWorkspace(repo, name).catch(() => {});
    defaultExec("git", ["branch", "-D", branch], repo);
  };
  function onSignal(sig: NodeJS.Signals) {
    if (restoring) console.log(`stopped while ${restoring}: production may run a backend the default branch lacks until the next merge or deploy`);
    void shutDown(release).finally(() => {
      if (landedAs) { console.log(landedAs); process.exit(0); }
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, onSignal);
  let setUp = false;
  return {
    path: workspace.path,
    setup: async (again = false) => { if (!setUp || again) { await healWorkspace(repo, name); setUp = true; } },
    release,
  };
}
