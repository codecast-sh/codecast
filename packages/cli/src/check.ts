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
 * a while exits on its own, and the machine keeps at most MAX_WATCHERS
 * alive: each holds a program in memory, and a fleet of worktrees could
 * otherwise recreate the pile this replaces.
 *
 * Which programs a tree carries is the tree's own business, read from
 * `.codecast/check.toml` (a `[projects]` table of name = tsconfig path;
 * tracked, so a worktree inherits it). A tree without one is checked from
 * the tsconfig nearest the caller's directory, and any project can be named
 * by the path of its directory or tsconfig.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "./proc.js";
import { acquireFileLock } from "./lockFile.js";
import { isPidAlive } from "./workspace/chrome.js";

/** One program to check: its name (a path segment of the state dir) and its tsconfig, relative to the tree root. */
export interface CheckProject {
  name: string;
  tsconfig: string;
}

export const CHECK_CONFIG_REL_PATH = ".codecast/check.toml";

/** The `[projects]` table of `.codecast/check.toml`, or null when the tree has none. */
export function readCheckConfig(root: string): CheckProject[] | null {
  const file = path.join(root, CHECK_CONFIG_REL_PATH);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: invalid TOML: ${(err as Error).message}`);
  }
  const projects = (raw as { projects?: unknown })?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: expected a [projects] table of name = "path/to/tsconfig.json"`);
  }
  const out: CheckProject[] = [];
  for (const [name, tsconfig] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof tsconfig !== "string" || !tsconfig.trim()) throw new Error(`${CHECK_CONFIG_REL_PATH}: projects.${name} must be a tsconfig path`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${CHECK_CONFIG_REL_PATH}: project name '${name}' may use letters, digits, dot, dash and underscore only`);
    out.push({ name, tsconfig });
  }
  return out;
}

/** A project name for a tree relative directory: "packages/cli" → "packages-cli", the root → "root". */
export function slugOf(relDir: string): string {
  const slug = relDir.replace(/^\.?\/?/, "").replace(/[\/\\]+/g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
  return slug || "root";
}

/** The tsconfig.json nearest `from`, walking up to the tree root; null when there is none on the way. */
export function nearestTsconfig(root: string, from: string): string | null {
  let dir = path.resolve(from);
  const top = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return path.relative(top, candidate);
    if (dir === top || !dir.startsWith(top)) return null;
    dir = path.dirname(dir);
  }
}

/**
 * The projects a call means. No names: every project the tree's config
 * lists, or, without a config, the program nearest the caller's directory.
 * A name is a configured project, or the path of a directory holding a
 * tsconfig.json, or the path of a tsconfig file.
 */
export function resolveProjects(root: string, names: string[], cwd = process.cwd()): CheckProject[] {
  const configured = readCheckConfig(root);
  if (!names.length) {
    if (configured) return configured.filter((p) => fs.existsSync(path.join(root, p.tsconfig)));
    const nearest = nearestTsconfig(root, cwd);
    if (!nearest) {
      throw new Error(
        `no tsconfig.json between ${cwd} and ${root}, and no ${CHECK_CONFIG_REL_PATH} names the tree's projects; ` +
          `name one by path (cast check packages/foo), or add a [projects] table to ${CHECK_CONFIG_REL_PATH}`,
      );
    }
    return [{ name: slugOf(path.dirname(nearest)), tsconfig: nearest }];
  }
  return names.map((name) => {
    const hit = configured?.find((p) => p.name === name);
    if (hit) return hit;
    const abs = path.resolve(cwd, name);
    const file = /tsconfig[^/]*\.json$/.test(abs) ? abs : path.join(abs, "tsconfig.json");
    if (fs.existsSync(file) && path.resolve(file).startsWith(path.resolve(root))) {
      const rel = path.relative(root, file);
      return { name: slugOf(path.dirname(rel)), tsconfig: rel };
    }
    const known = configured?.map((p) => p.name).join(", ");
    throw new Error(`unknown project '${name}': ${known ? `one of ${known}, or ` : ""}a directory with a tsconfig.json, or a tsconfig path`);
  });
}

/** Live watchers this machine keeps at most; the least recently asked is stopped to make room. */
export const MAX_WATCHERS = Math.max(1, parseInt(process.env.CAST_CHECK_MAX_WATCHERS ?? "", 10) || 6);

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

/**
 * Exit when nobody has asked in IDLE_EXIT_MS, measured from the later of
 * the last ask and the last finished pass. A pass in flight never counts as
 * idle: on a loaded machine a first pass can outlive the idle window, and a
 * watcher that quit then threw the whole build away (seen 2026-09-17).
 */
export function shouldIdleExit(state: Pick<WatchState, "inProgress" | "askedAt" | "finishedAt" | "startedAt">, now = Date.now()): boolean {
  if (state.inProgress) return false;
  const last = Math.max(state.askedAt ?? 0, state.finishedAt ?? 0, state.startedAt);
  return now - last > IDLE_EXIT_MS;
}
/** A big program needs more heap than node's default; the same figure the projects' own CI uses. */
export const TSC_NODE_OPTIONS = "--max-old-space-size=4096";
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
export async function runWatcher(root: string, project: string, tsconfig: string): Promise<void> {
  if (!fs.existsSync(path.join(root, tsconfig))) throw new Error(`no ${tsconfig} under ${root}`);
  const dir = watchDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const state: WatchState = { pid: process.pid, project, tsconfig, root, startedAt: Date.now(), inProgress: true, askedAt: Date.now() };
  writeWatchState(dir, state);
  const reduce = watchReducer(dir, state);
  const child = spawn(tscBinary(root, tsconfig), ["--noEmit", "--watch", "--preserveWatchOutput", "--pretty", "false", "-p", path.join(root, tsconfig)], {
    cwd: path.dirname(path.join(root, tsconfig)),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || TSC_NODE_OPTIONS },
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
    if (shouldIdleExit(readWatchState(dir) ?? state)) {
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

export type WatcherStarter = (root: string, project: CheckProject) => void;

/** Respawn ourselves as the watcher, detached, logging to the watch dir. */
export const startDetachedWatcher: WatcherStarter = (root, { name, tsconfig }) => {
  const dir = watchDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = viaRuntime ? [process.argv[1], "check-watch", root, name, tsconfig] : ["check-watch", root, name, tsconfig];
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
  target: CheckProject,
  root: string,
  opts: { start?: WatcherStarter; budgetMs?: number; fresh?: boolean; note?: (line: string) => void; maxWatchers?: number; kill?: (pid: number) => void } = {},
): Promise<CheckResult> {
  const project = target.name;
  const dir = watchDir(root, project);
  const budget = opts.budgetMs ?? 20 * 60_000;
  const note = opts.note ?? (() => {});
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  let started = false;
  const release = await acquireFileLock(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
  try {
    let state = readWatchState(dir);
    // The tree's config now names a different tsconfig for this project than
    // the running watcher was built on (an entry corrected in
    // .codecast/check.toml). The old program would keep answering, so it is
    // replaced rather than trusted.
    if (state && state.tsconfig !== target.tsconfig) {
      note(`the ${project} project now names ${target.tsconfig}, not ${state.tsconfig}; restarting its watcher`);
      try {
        kill(state.pid);
      } catch {}
      fs.rmSync(statePath(dir), { force: true });
      state = null;
      await sleep(300);
    }
    if (state && opts.fresh) {
      try {
        kill(state.pid);
      } catch {}
      state = null;
      await sleep(300);
    }
    if (!state || !isPidAlive(state.pid)) {
      for (const evicted of makeRoom(opts.maxWatchers ?? MAX_WATCHERS)) {
        note(`stopped the ${evicted.project} watcher for ${evicted.root} (idle longest) to stay under ${opts.maxWatchers ?? MAX_WATCHERS} watchers on this machine`);
      }
      (opts.start ?? startDetachedWatcher)(root, target);
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

/** Every live watcher on this machine, for `cast check-status` and the cap; a state file whose pid is gone is cleared. */
export function listWatchers(): Array<WatchState & { dir: string }> {
  const out: Array<WatchState & { dir: string }> = [];
  const home = checkHome();
  if (!fs.existsSync(home)) return out;
  for (const tree of fs.readdirSync(home)) {
    const treeDir = path.join(home, tree);
    if (!fs.statSync(treeDir).isDirectory()) continue;
    for (const project of fs.readdirSync(treeDir)) {
      const dir = path.join(treeDir, project);
      const s = readWatchState(dir);
      if (!s) continue;
      if (!isPidAlive(s.pid)) {
        fs.rmSync(statePath(dir), { force: true });
        continue;
      }
      out.push({ ...s, dir });
    }
  }
  return out;
}

/**
 * Stop the least recently asked watchers until one more fits under `max`.
 * Returns what was stopped. A watcher's state file goes with it, so a later
 * ask for that project starts a fresh one.
 */
export function makeRoom(max: number, kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM")): Array<WatchState & { dir: string }> {
  const live = listWatchers().sort((a, b) => (a.askedAt ?? a.startedAt) - (b.askedAt ?? b.startedAt));
  const evicted: Array<WatchState & { dir: string }> = [];
  while (live.length >= max && live.length) {
    const victim = live.shift()!;
    try {
      kill(victim.pid);
    } catch {}
    fs.rmSync(statePath(victim.dir), { force: true });
    evicted.push(victim);
  }
  return evicted;
}
