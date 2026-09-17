/**
 * `cast check`: the typecheck, answered by one long lived watcher per tree
 * and tsconfig instead of a fresh `tsc` per session.
 *
 * A typecheck is a function of the tree. Building the program graph is the
 * expensive part (a thousand files, one to two gigabytes, minutes on a loaded
 * machine), and every session running its own `tsc --noEmit` rebuilds the
 * same graph: seventeen at once were measured on one checkout (2026-09-17),
 * which put the box into swap and starved everything else on it, Chrome's
 * extension included. `tsc --watch` keeps the graph in memory and re-checks
 * only what changed, in seconds, so one watcher serves any number of askers.
 *
 * The unit of sharing is the tree: sessions in the shared checkout share a
 * watcher; a worktree gets its own on first use. A watcher is a detached
 * `cast check-watch` process wrapping tsc's watch mode; it records each
 * pass in a state file (in progress, finished at, error count, the
 * diagnostics) that `cast check` reads. A watcher nobody has asked for in
 * a while exits on its own.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "./proc.js";
import { acquireFileLock } from "./lockFile.js";
import { isPidAlive } from "./workspace/chrome.js";

/** The projects a checkout carries, by the name a caller uses. */
export const CHECK_PROJECTS: Record<string, string> = {
  cli: "packages/cli/tsconfig.json",
  web: "packages/web/tsconfig.json",
  convex: "packages/convex/convex/tsconfig.json",
};

export interface WatchState {
  pid: number;
  project: string;
  tsconfig: string;
  root: string;
  startedAt: number;
  /** A pass is running: tsc saw a change and has not printed its summary yet. */
  inProgress: boolean;
  /** When the last pass finished, and what it found. */
  finishedAt?: number;
  errors?: number;
  /** When someone last asked; the watcher exits after IDLE_EXIT_MS without one. */
  askedAt?: number;
}

export const IDLE_EXIT_MS = 45 * 60_000;
/** After a request, how long a change may take to reach tsc's watcher before we trust the last pass. */
export const SETTLE_MS = 750;

export function repoRoot(cwd = process.cwd()): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 10_000 });
  const out = (r.stdout ?? "").trim();
  return out || cwd;
}

export function checkHome(): string {
  return path.join(process.env.CODECAST_DIR ?? path.join(os.homedir(), ".codecast"), "typecheck");
}

/** One directory per tree and project: the state, the log, the lock. */
export function watchDir(root: string, project: string): string {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return path.join(checkHome(), `${key}-${path.basename(root)}`, project);
}

export const statePath = (dir: string): string => path.join(dir, "state.json");
export const outputPath = (dir: string): string => path.join(dir, "diagnostics.txt");
export const logPath = (dir: string): string => path.join(dir, "watch.log");

export function readWatchState(dir: string): WatchState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), "utf-8")) as WatchState;
  } catch {
    return null;
  }
}

export function writeWatchState(dir: string, state: WatchState): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath(dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(dir));
}

/** The tsc next to the project (its own TypeScript version), else the root's. */
export function tscBinary(root: string, tsconfig: string): string {
  const candidates = [
    path.join(path.dirname(path.join(root, tsconfig)), "node_modules/.bin/tsc"),
    path.join(root, path.dirname(tsconfig).split("/").slice(0, 2).join("/"), "node_modules/.bin/tsc"),
    path.join(root, "node_modules/.bin/tsc"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? "tsc";
}

// ---------------------------------------------------------------------------
// The watcher: reads tsc's watch output and keeps the state file current
// ---------------------------------------------------------------------------

/** What one line of `tsc --watch` output means for the pass in flight. */
export type WatchEvent = { kind: "start" } | { kind: "done"; errors: number } | { kind: "line" };

export function classifyWatchLine(line: string): WatchEvent {
  if (/Starting compilation in watch mode|File change detected\. Starting incremental compilation/.test(line)) return { kind: "start" };
  const m = /Found (\d+) errors?\. Watching for file changes\./.exec(line);
  if (m) return { kind: "done", errors: parseInt(m[1], 10) };
  return { kind: "line" };
}

/**
 * Fold tsc's output into the state file, one line at a time. Diagnostics
 * of the pass in flight collect in `buffer` and land in the output file
 * when the pass ends, so a reader never sees half a pass.
 */
export function watchReducer(dir: string, state: WatchState) {
  let buffer: string[] = [];
  return (line: string): void => {
    const ev = classifyWatchLine(line);
    if (ev.kind === "start") {
      buffer = [];
      state.inProgress = true;
      writeWatchState(dir, state);
      return;
    }
    if (ev.kind === "done") {
      fs.writeFileSync(outputPath(dir), buffer.join("\n").trim() + "\n");
      buffer = [];
      state.inProgress = false;
      state.finishedAt = Date.now();
      state.errors = ev.errors;
      writeWatchState(dir, state);
      return;
    }
    // tsc's own timestamps and blank lines are noise; diagnostics keep their text.
    if (/^\s*$/.test(line) || /^\[\d{1,2}:\d{2}:\d{2}/.test(line)) return;
    buffer.push(line);
  };
}

/** The foreground body of the hidden `cast check-watch` command. */
export async function runWatcher(project: string, root: string): Promise<void> {
  const tsconfig = CHECK_PROJECTS[project];
  if (!tsconfig) throw new Error(`unknown project ${project}; one of ${Object.keys(CHECK_PROJECTS).join(", ")}`);
  const dir = watchDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const state: WatchState = { pid: process.pid, project, tsconfig, root, startedAt: Date.now(), inProgress: true, askedAt: Date.now() };
  writeWatchState(dir, state);
  const reduce = watchReducer(dir, state);
  const child = spawn(tscBinary(root, tsconfig), ["--noEmit", "--watch", "--preserveWatchOutput", "--pretty", "false", "-p", path.join(root, tsconfig)], {
    cwd: path.dirname(path.join(root, tsconfig)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let rest = "";
  const onData = (chunk: Buffer | string): void => {
    rest += String(chunk);
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) reduce(line);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const idle = setInterval(() => {
    const current = readWatchState(dir);
    const askedAt = current?.askedAt ?? state.startedAt;
    if (Date.now() - askedAt > IDLE_EXIT_MS) {
      child.kill("SIGTERM");
      clearInterval(idle);
    }
  }, 60_000);
  const stop = (): void => {
    child.kill("SIGTERM");
    try {
      fs.rmSync(statePath(dir), { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  clearInterval(idle);
  try {
    fs.rmSync(statePath(dir), { force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface CheckResult {
  project: string;
  errors: number;
  diagnostics: string;
  /** How old the pass is, and whether this call started the watcher. */
  passAgeMs: number;
  started: boolean;
}

export type WatcherStarter = (project: string, root: string) => void;

/** Respawn ourselves as the watcher, detached, logging to the watch dir. */
export const startDetachedWatcher: WatcherStarter = (project, root) => {
  const dir = watchDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = viaRuntime ? [process.argv[1], "check-watch", project, root] : ["check-watch", project, root];
  const log = fs.openSync(logPath(dir), "a");
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The current diagnostics for one project: from the running watcher's last
 * finished pass, waiting for the pass in flight when there is one, starting
 * the watcher when none runs. `budgetMs` bounds a first pass on a loaded
 * machine; a watcher that is still building past it is reported as such.
 */
export async function checkProject(
  project: string,
  root: string,
  opts: { start?: WatcherStarter; budgetMs?: number; fresh?: boolean; note?: (line: string) => void } = {},
): Promise<CheckResult> {
  if (!CHECK_PROJECTS[project]) throw new Error(`unknown project ${project}; one of ${Object.keys(CHECK_PROJECTS).join(", ")}`);
  const dir = watchDir(root, project);
  const budget = opts.budgetMs ?? 20 * 60_000;
  const note = opts.note ?? (() => {});
  let started = false;
  const release = await acquireFileLock(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
  try {
    let state = readWatchState(dir);
    if (state && opts.fresh) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {}
      state = null;
      await sleep(300);
    }
    if (!state || !isPidAlive(state.pid)) {
      (opts.start ?? startDetachedWatcher)(project, root);
      started = true;
      note(`starting the ${project} typecheck watcher for ${root} (first pass builds the whole program; later asks take seconds)`);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !(state = readWatchState(dir))) await sleep(200);
      if (!state) throw new Error(`the ${project} typecheck watcher did not start; its log is ${logPath(dir)}`);
    }
  } finally {
    release();
  }
  // Mark the ask (keeps the watcher alive), then let a change that landed a
  // moment ago reach tsc before trusting the last pass.
  const askedAt = Date.now();
  const current = readWatchState(dir);
  if (current) writeWatchState(dir, { ...current, askedAt });
  await sleep(SETTLE_MS);
  const deadline = askedAt + budget;
  let noted = false;
  for (;;) {
    const s = readWatchState(dir);
    if (!s) throw new Error(`the ${project} typecheck watcher went away; its log is ${logPath(dir)}`);
    if (!s.inProgress && s.finishedAt) {
      const diagnostics = fs.existsSync(outputPath(dir)) ? fs.readFileSync(outputPath(dir), "utf-8") : "";
      return { project, errors: s.errors ?? 0, diagnostics, passAgeMs: Date.now() - s.finishedAt, started };
    }
    if (Date.now() > deadline) throw new Error(`the ${project} typecheck is still running after ${Math.round(budget / 60_000)} min; the machine is loaded. Ask again, or read ${logPath(dir)}`);
    if (!noted && Date.now() - askedAt > 5_000) {
      noted = true;
      note(`waiting for the ${project} typecheck pass to finish…`);
    }
    await sleep(300);
  }
}

/** Every watcher on this machine, for `cast check status` and `stop`. */
export function listWatchers(): Array<WatchState & { dir: string }> {
  const out: Array<WatchState & { dir: string }> = [];
  const home = checkHome();
  if (!fs.existsSync(home)) return out;
  for (const tree of fs.readdirSync(home)) {
    for (const project of Object.keys(CHECK_PROJECTS)) {
      const dir = path.join(home, tree, project);
      const s = readWatchState(dir);
      if (s) out.push({ ...s, dir });
    }
  }
  return out;
}
