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
 * Slots are a queue, not a refusal. An ask that needs a new watcher while
 * every slot is taken waits its turn, oldest ask first, and starts when a
 * slot frees: a watcher between passes, or a pass nobody waits on any more.
 * A pass is protected only while someone waits on it (an asker refreshes
 * `askedAt` while it waits), so a first pass whose asker gave up does not
 * hold its slot forever on a loaded machine.
 *
 * Which programs a tree carries is the tree's own business, read from
 * `.codecast/check.toml` (a `[projects]` table of name = tsconfig path;
 * tracked, so a worktree inherits it). A tree without one is checked from
 * the tsconfig nearest the caller's directory, and any project can be named
 * by the path of its directory or tsconfig.
 */

import { codecastPath } from "./codecastDir.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "./proc.js";
import { acquireFileLock } from "./lockFile.js";
import { isPidAlive } from "./workspace/chrome.js";
import { startLaunchdJob, unloadOwnLaunchdJob } from "./launchdJob.js";

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

/** How often a waiting asker refreshes `askedAt`, and how long without one leaves a running pass unwanted. */
export const ASK_HEARTBEAT_MS = 30_000;
export const WANTED_MS = 5 * 60_000;

/** A running pass someone still waits on: never stopped to make room. */
export function isWanted(state: Pick<WatchState, "inProgress" | "askedAt" | "startedAt">, now = Date.now()): boolean {
  return state.inProgress && now - (state.askedAt ?? state.startedAt) <= WANTED_MS;
}

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
  /** The compiler this watcher runs. Absent means the tree had none and PATH's tsc is in use. */
  tsc?: string;
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
  return codecastPath("typecheck");
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
  const previous = readWatchState(dir);
  if (previous?.pid === state.pid && previous.startedAt === state.startedAt) {
    state = { ...state, askedAt: Math.max(state.askedAt ?? 0, previous.askedAt ?? 0) };
  }
  const tmp = `${statePath(dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath(dir));
}

/**
 * The TypeScript the project itself would run: the first `node_modules/.bin/tsc`
 * walking up from the tsconfig's own directory to the tree root, which is how
 * node resolution and `bunx tsc` find it. Only two of those directories used to
 * be tried, so a project whose deps are installed one level above it (a package
 * inside a workspace) fell through to whatever `tsc` was on PATH — a different
 * compiler, with different lib and types resolution. In one worktree that
 * reported 1969 errors against 0 from the right binary (2026-09-18).
 *
 * Null when the tree has none, so the caller can say it is using a global tsc
 * instead of silently reporting another compiler's opinion as the project's.
 */
export function tscInTree(root: string, tsconfig: string): string | null {
  const top = path.resolve(root);
  let dir = path.dirname(path.resolve(root, tsconfig));
  for (;;) {
    const candidate = path.join(dir, "node_modules/.bin/tsc");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === top || !dir.startsWith(top)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project's own tsc, else whatever is on PATH. */
export function tscBinary(root: string, tsconfig: string): string {
  return tscInTree(root, tsconfig) ?? "tsc";
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
  const own = tscInTree(root, tsconfig);
  const state: WatchState = { pid: process.pid, project, tsconfig, root, startedAt: Date.now(), inProgress: true, askedAt: Date.now(), ...(own ? { tsc: own } : {}) };
  writeWatchState(dir, state);
  const reduce = watchReducer(dir, state);
  const child = spawn(own ?? "tsc", ["--noEmit", "--watch", "--preserveWatchOutput", "--pretty", "false", "-p", path.join(root, tsconfig)], {
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
    unloadOwnLaunchdJob();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  clearInterval(idle);
  try {
    fs.rmSync(statePath(dir), { force: true });
  } catch {}
  unloadOwnLaunchdJob();
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

/**
 * Respawn ourselves as the watcher, logging to the watch dir: as an
 * Interactive launchd job where launchd takes one, so the build does not
 * inherit the agent tree's utility clamp (launchdJob.ts), else detached.
 */
export const startDetachedWatcher: WatcherStarter = (root, { name, tsconfig }) => {
  const dir = watchDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = viaRuntime ? [process.argv[1], "check-watch", root, name, tsconfig] : ["check-watch", root, name, tsconfig];
  const label = `sh.codecast.check.${path.basename(path.dirname(dir))}.${name}`.replace(/[^A-Za-z0-9._-]/g, "_");
  if (startLaunchdJob({ label, argv: [process.execPath, ...args], plistPath: path.join(dir, "watcher.plist"), logPath: logPath(dir) })) return;
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
 * the watcher when none runs (queued for a slot when the machine is full).
 * `budgetMs` bounds the whole ask, queue included; a watcher that is still
 * building past it is reported as such.
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
  const deadline = Date.now() + budget;
  let started = false;
  let state: WatchState | null;
  const release = await acquireFileLock(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
  try {
    state = readWatchState(dir);
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
  } finally {
    release();
  }
  if (!state || !isPidAlive(state.pid)) started = await startWhenSlotFrees(target, root, { ...opts, start: opts.start ?? startDetachedWatcher, note, kill, deadline });
  // Mark the ask (keeps the watcher alive), then let a change that landed a
  // moment ago reach tsc before trusting the last pass.
  const askedAt = Date.now();
  const current = readWatchState(dir);
  if (current) writeWatchState(dir, { ...current, askedAt });
  await sleep(SETTLE_MS);
  let noted = false;
  let beat = askedAt;
  for (;;) {
    const s = readWatchState(dir);
    if (!s) throw new Error(`the ${project} typecheck watcher went away; its log is ${logPath(dir)}`);
    // Keep the pass wanted while this ask waits on it, so the queue never takes its slot.
    if (Date.now() - beat >= ASK_HEARTBEAT_MS) {
      beat = Date.now();
      writeWatchState(dir, { ...s, askedAt: beat });
    }
    if (!s.inProgress && s.finishedAt) {
      const diagnostics = fs.existsSync(outputPath(dir)) ? fs.readFileSync(outputPath(dir), "utf-8") : "";
      // A global tsc resolves libs and types its own way, so its errors are not
      // the project's. Say so rather than let a wall of them read as real. The
      // tree is asked now rather than trusting the state file, which a watcher
      // started by an older CLI wrote without this field.
      if ((s.errors ?? 0) > 0 && !tscInTree(root, target.tsconfig)) {
        note(`${project} was checked by the tsc on PATH: this tree installs none above ${s.tsconfig}, and a different compiler reports different errors. Install the project's dependencies, then \`cast check --fresh ${project}\`.`);
      }
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
 * Stop the least recently asked watchers until one more fits under `max`:
 * watchers between passes first, then passes nobody waits on. Returns what
 * was stopped, or null when every slot holds a wanted pass (nothing is
 * stopped then). A watcher's state file goes with it, so a later ask for
 * that project starts a fresh one.
 */
export function makeRoom(max: number, kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM"), now = Date.now()): Array<WatchState & { dir: string }> | null {
  const byAsk = (a: WatchState, b: WatchState) => (a.askedAt ?? a.startedAt) - (b.askedAt ?? b.startedAt);
  const live = listWatchers();
  const needed = Math.max(0, live.length - max + 1);
  const eligible = [...live.filter((w) => !w.inProgress).sort(byAsk), ...live.filter((w) => w.inProgress && !isWanted(w, now)).sort(byAsk)];
  if (eligible.length < needed) return null;
  const evicted: Array<WatchState & { dir: string }> = [];
  for (const victim of eligible.slice(0, needed)) {
    try {
      kill(victim.pid);
    } catch {}
    fs.rmSync(statePath(victim.dir), { force: true });
    evicted.push(victim);
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// The slot queue: asks that need a new watcher wait their turn, oldest first
// ---------------------------------------------------------------------------

export const queueDir = (): string => path.join(checkHome(), "queue");

interface QueueTicket {
  pid: number;
  root: string;
  project: string;
  at: number;
  file: string;
}

/** Live tickets, oldest first; a ticket whose asker died is cleared. */
export function listQueue(): QueueTicket[] {
  const dir = queueDir();
  if (!fs.existsSync(dir)) return [];
  const out: QueueTicket[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf-8")) as Omit<QueueTicket, "file">;
      if (isPidAlive(t.pid)) out.push({ ...t, file });
      else fs.rmSync(file, { force: true });
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
}

/** How long a program keeps its place in the queue across asks that gave up and asked again. */
export const QUEUE_PLACE_MS = 60 * 60_000;
const queuedAtPath = (dir: string): string => path.join(dir, "queued_at");

/** When this program first joined the queue, so a re-ask keeps its place rather than going to the back. */
function queuePlace(dir: string, now = Date.now()): number {
  try {
    const at = parseInt(fs.readFileSync(queuedAtPath(dir), "utf-8"), 10);
    if (at && now - at < QUEUE_PLACE_MS) return at;
  } catch {}
  fs.writeFileSync(queuedAtPath(dir), String(now));
  return now;
}

/**
 * Start the project's watcher once a slot is free and every earlier ask has
 * had its turn. An ask for a project whose watcher another asker started
 * meanwhile leaves the queue and rides that watcher. Returns whether this
 * call started it.
 */
async function startWhenSlotFrees(
  target: CheckProject,
  root: string,
  opts: { start: WatcherStarter; note: (line: string) => void; kill: (pid: number) => void; maxWatchers?: number; deadline: number },
): Promise<boolean> {
  const project = target.name;
  const dir = watchDir(root, project);
  const max = opts.maxWatchers ?? MAX_WATCHERS;
  fs.mkdirSync(queueDir(), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const at = queuePlace(dir);
  const file = path.join(queueDir(), `${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, root, project, at }));
  let lastAhead = -1;
  try {
    for (;;) {
      const release = await acquireFileLock(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
      try {
        const state = readWatchState(dir);
        if (state && isPidAlive(state.pid)) {
          fs.rmSync(queuedAtPath(dir), { force: true });
          return false;
        }
        const ahead = listQueue().findIndex((t) => t.file === file);
        if (ahead === 0) {
          const releaseCapacity = await acquireFileLock(path.join(checkHome(), "capacity.lock"), { describe: "cast check watcher start", waitMs: 60_000 });
          try {
            const evicted = makeRoom(max, opts.kill);
            if (evicted) {
              for (const w of evicted) opts.note(`stopped the ${w.project} watcher for ${w.root} (${w.inProgress ? "a pass nobody waits on" : "idle longest"}) to stay under ${max} watchers on this machine`);
              opts.start(root, target);
              fs.rmSync(queuedAtPath(dir), { force: true });
              opts.note(`starting the ${project} typecheck watcher for ${root} (first pass builds the whole program; later asks take seconds)`);
              const deadline = Date.now() + 30_000;
              while (Date.now() < deadline && !readWatchState(dir)) await sleep(200);
              if (!readWatchState(dir)) throw new Error(`the ${project} typecheck watcher did not start; its log is ${logPath(dir)}`);
              return true;
            }
          } finally {
            releaseCapacity();
          }
        }
        if (ahead !== lastAhead) {
          lastAhead = ahead;
          const busy = listWatchers().map((w) => w.project).join(", ");
          opts.note(ahead === 0
            ? `queued: all ${max} typecheck slots hold passes someone is waiting on (${busy}); starting when one finishes`
            : `queued: ${ahead} ask${ahead === 1 ? "" : "s"} ahead for the ${max} typecheck slots (${busy})`);
        }
      } finally {
        release();
      }
      if (Date.now() > opts.deadline) throw new Error(`the ${project} typecheck is still queued for a slot; every one of the ${max} slots holds a pass someone is waiting on. Ask again later; do not restart them with --fresh`);
      await sleep(1_000);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}
