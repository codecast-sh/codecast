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
 * An answer comes only from a pass that checked the files as they are on
 * disk: tsc records each file's content version in its build info, and the
 * asker compares those with the disk rather than trusting that tsc's file
 * watching heard every change in time.
 *
 * The unit of sharing is the tree: sessions in the shared checkout share a
 * watcher; a worktree gets its own on first use. A watcher is a detached
 * `cast check-watch` process wrapping tsc's watch mode; it records each
 * pass in a state file (in progress, finished at, error count, the
 * diagnostics) that `cast check` reads. A watcher nobody has asked for in
 * a while exits on its own, and a new one starts only when the memory it is
 * likely to take fits beside the live ones (watcherMemory.ts): each holds a
 * program in memory, and a fleet of worktrees could otherwise recreate the
 * pile this replaces.
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
import { CHECK_CONFIG_REL_PATH } from "./checkConfigPath.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "./proc.js";
import { acquireFileLock } from "./lockFile.js";
import { isPidAlive } from "./workspace/chrome.js";
import { startLaunchdJob, unloadOwnLaunchdJob } from "./launchdJob.js";
import { memoryDeath, oomKillCount } from "./repoNeed.js";
import { CHECK_HEAP_ENV, TSC_HEAP_MB, heapCapMb, heapDeath, isHeapFatal, isNativeFrame, tscNodeOptions } from "./checkHeap.js";
import { CheckFailure, deathKind, phantomErrors, type ModuleResolver } from "./checkOutcome.js";
import { peakOfPids, recordPeak, type Peak } from "./watcherMemory.js";
import { repoOf, startWhenSlotFrees } from "./checkCapacity.js";
import { tscFileVersion } from "./tscFileVersion.js";
export * from "./checkCapacity.js";

/** One program to check: its name (a path segment of the state dir) and its tsconfig, relative to the tree root. */
export interface CheckProject {
  name: string;
  tsconfig: string;
}


/** The parsed `.codecast/check.toml`, or null when the tree has none. */
function readCheckToml(root: string): Record<string, unknown> | null {
  const file = path.join(root, CHECK_CONFIG_REL_PATH);
  if (!fs.existsSync(file)) return null;
  try {
    return Bun.TOML.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: invalid TOML: ${(err as Error).message}`);
  }
}

/** The `[projects]` table of `.codecast/check.toml`, or null when the tree has none. */
export function readCheckConfig(root: string): CheckProject[] | null {
  const raw = readCheckToml(root);
  if (!raw) return null;
  const projects = raw.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: expected a [projects] table of name = "path/to/tsconfig.json"`);
  }
  const out: CheckProject[] = [];
  for (const [name, tsconfig] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof tsconfig !== "string" || !tsconfig.trim()) throw new Error(`${CHECK_CONFIG_REL_PATH}: projects.${name} must be a tsconfig path`);
    if (name === "checker") throw new Error(`${CHECK_CONFIG_REL_PATH}: checker is a top-level key; move it above [projects]`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${CHECK_CONFIG_REL_PATH}: project name '${name}' may use letters, digits, dot, dash and underscore only`);
    out.push({ name, tsconfig });
  }
  return out;
}

/** What checks the tree: a tsc watcher per project, or, with top-level `checker = "bun"`, one `bun check` per ask (checkBun.ts). */
export type Checker = "tsc" | "bun";

export function readChecker(root: string): Checker {
  const checker = readCheckToml(root)?.checker;
  if (checker === undefined || checker === "tsc" || checker === "bun") return checker ?? "tsc";
  throw new Error(`${CHECK_CONFIG_REL_PATH}: checker must be "tsc" or "bun", not ${JSON.stringify(checker)}`);
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
    // A path reads from the caller's directory first, then from the tree root,
    // the way the config and the docs write paths (`outreach/backend` from inside outreach/backend).
    const bases = [path.resolve(cwd, name), path.resolve(root, name)];
    const isFile = /tsconfig[^/]*\.json$/.test(name);
    // A directory a configured project lives in is that project, whatever its
    // tsconfig is called (cli's is tsconfig.typecheck.json; the folder's plain
    // tsconfig.json is a different program with errors of its own).
    if (!isFile) {
      for (const abs of bases) {
        const relDir = path.relative(root, abs) || ".";
        const owners = fs.existsSync(abs) ? (configured ?? []).filter((p) => path.dirname(path.normalize(p.tsconfig)) === relDir) : [];
        if (owners.length === 1) return owners[0];
      }
    }
    const candidates = bases.map((abs) => (isFile ? abs : path.join(abs, "tsconfig.json")));
    const file = candidates.find((f) => fs.existsSync(f)) ?? candidates[0];
    // Inside by path, not by string prefix: a sibling worktree (`repo-wt/`) starts with the tree's own path.
    const rel = path.relative(root, file);
    if (fs.existsSync(file) && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      // A path to a configured project's tsconfig is that project: its own
      // name would start a second watcher holding the same program.
      return configured?.find((p) => path.normalize(p.tsconfig) === rel) ?? { name: slugOf(path.dirname(rel)), tsconfig: rel };
    }
    const known = configured?.map((p) => p.name).join(", ");
    if (fs.existsSync(file)) {
      throw new Error(`'${name}' is outside this tree (${root}); a watcher belongs to one tree, so run cast check from inside that folder (cd ${path.dirname(file)} && cast check)`);
    }
    throw new Error(`unknown project '${name}': ${known ? `one of ${known}, or ` : ""}a directory with a tsconfig.json, or a tsconfig path`);
  });
}

/**
 * Repo-relative paths in a project's program, read from its watcher's build
 * info (tsc writes every file of the program there). Before the project's
 * first pass on this tree (a worktree a line run just made), the list comes
 * from another checkout of the same repository whose watcher has one: the
 * program is the same give or take what a change adds, so a file one project
 * imports from another's folder still counts for it. Null when no checkout has
 * one.
 */
export function programFiles(root: string, project: CheckProject): Set<string> | null {
  return builtProgramFiles(root, project) ?? otherCheckouts(root).map((tree) => builtProgramFiles(tree, project)).find(Boolean) ?? null;
}

/** The repository's other checkouts, its main one first (git worktree list). */
function otherCheckouts(root: string): string[] {
  try {
    const self = fs.realpathSync(root);
    return gitLines(root, ["worktree", "list", "--porcelain"])
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((t) => fs.existsSync(t) && fs.realpathSync(t) !== self);
  } catch {
    return [];
  }
}

function builtProgramFiles(root: string, project: CheckProject): Set<string> | null {
  const dir = watchDir(root, project.name);
  const program = readBuildInfo(dir);
  if (!program) return null;
  const files = new Set<string>();
  for (const name of program.fileNames) {
    if (typeof name !== "string") continue;
    const rel = path.relative(root, path.resolve(dir, name));
    if (!rel.startsWith("..")) files.add(rel.split(path.sep).join("/"));
  }
  return files;
}

/** The program a watcher's last pass recorded: its files, and what tsc knew of each. */
function readBuildInfo(dir: string): { fileNames: unknown[]; fileInfos: unknown[]; root: unknown[] } | null {
  type Program = { fileNames?: unknown; fileInfos?: unknown; root?: unknown };
  try {
    const info = JSON.parse(fs.readFileSync(buildInfoPath(dir), "utf-8")) as Program & { program?: Program };
    // TypeScript before 5.6 nests the program under `program`.
    const { fileNames, fileInfos, root } = info.program ?? info;
    return Array.isArray(fileNames) ? { fileNames, fileInfos: Array.isArray(fileInfos) ? fileInfos : [], root: Array.isArray(root) ? root : [] } : null;
  } catch {
    return null;
  }
}

/**
 * The projects a set of changed files can affect: a project whose program
 * holds one of them, or, for a file no program has seen yet (new, or a
 * project never built here), one whose tsconfig sits above it.
 */
export function projectsTouching(root: string, projects: CheckProject[], changed: string[]): CheckProject[] {
  const code = changed.filter((f) => /\.(m|c)?[jt]sx?$|(^|\/)(tsconfig[^/]*|package)\.json$/.test(f));
  if (!code.length) return [];
  return projects.filter((p) => {
    const files = programFiles(root, p);
    const dir = path.dirname(p.tsconfig);
    const under = (f: string) => dir === "." || f.startsWith(`${dir}/`);
    return code.some((f) => files?.has(f) || ((!files || !files.has(f)) && under(f) && !otherProjectOwns(root, projects, p, f)));
  });
}

// ---------------------------------------------------------------------------
// Whether a pass checked the files on disk
// ---------------------------------------------------------------------------

/** Each file's stat and version when last read, so an unchanged file is not hashed on every ask. */
type DiskVersions = Record<string, [mtimeMs: number, size: number, ino: number, version: string]>;
const diskVersionsPath = (dir: string): string => path.join(dir, "disk-versions.json");

/**
 * The program's files whose content on disk is not what the last finished
 * pass checked. tsc records every file's version in the build info it writes
 * as a pass ends, so this compares the pass with the disk directly, whatever
 * tsc's file watching heard. Null when there is nothing to compare: no pass
 * has written build info, or it records no content versions.
 */
export function filesNotAsChecked(dir: string, now = Date.now()): string[] | null {
  const program = readBuildInfo(dir);
  if (!program) return null;
  const { fileNames, fileInfos } = program;
  let known: DiskVersions = {};
  try {
    known = JSON.parse(fs.readFileSync(diskVersionsPath(dir), "utf-8"));
  } catch {}
  const read: DiskVersions = {};
  const differ: string[] = [];
  let compared = 0;
  fileInfos.forEach((entry, i) => {
    const recorded = typeof entry === "string" ? entry : (entry as { version?: unknown } | null)?.version;
    const name = fileNames[i];
    if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded) || typeof name !== "string") return;
    compared++;
    const file = path.resolve(dir, name);
    let version: string;
    try {
      const st = fs.statSync(file);
      const was = known[file];
      version = was && was[0] === st.mtimeMs && was[1] === st.size && was[2] === st.ino ? was[3] : tscFileVersion(fs.readFileSync(file));
      // A file written within the clock's last two seconds can be written
      // again with the same stat, so its version is read afresh next time.
      if (now - st.mtimeMs > 2_000) read[file] = [st.mtimeMs, st.size, st.ino, version];
    } catch {
      differ.push(file);
      return;
    }
    if (version !== recorded) differ.push(file);
  });
  if (!compared) return null;
  try {
    const tmp = `${diskVersionsPath(dir)}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(read));
    fs.renameSync(tmp, diskVersionsPath(dir));
  } catch {}
  return differ;
}

type TypeScriptModule = typeof import("typescript");
const typescriptModules = new Map<string, TypeScriptModule | null>();

/** The TypeScript the project's tsc runs, loaded as a module so its config is read the way tsc reads it; null when the tree has none. */
function treeTypeScript(root: string, tsconfig: string): TypeScriptModule | null {
  const bin = tscInTree(root, tsconfig);
  if (!bin) return null;
  let lib: string;
  try {
    lib = path.join(path.dirname(fs.realpathSync(bin)), "../lib/typescript.js");
  } catch {
    return null;
  }
  if (!typescriptModules.has(lib)) {
    try {
      typescriptModules.set(lib, createRequire(lib)(lib) as TypeScriptModule);
    } catch {
      typescriptModules.set(lib, null);
    }
  }
  return typescriptModules.get(lib) ?? null;
}

/**
 * What changed that the last pass's build info does not list: a file the
 * config's globs take in now and the pass did not (a new file nothing
 * imports yet), and a config file written since the pass began (the
 * tsconfig and every config it extends). Empty when the tree's TypeScript
 * cannot be loaded or the build info names no roots.
 */
export function unlistedChanges(dir: string, root: string, tsconfig: string, passStartedAt?: number): string[] {
  const program = readBuildInfo(dir);
  const ts = program?.root.length ? treeTypeScript(root, tsconfig) : null;
  if (!program || !ts) return [];
  const key = (file: string) => (ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase());
  const recorded = new Set<string>();
  const add = (id: unknown) => {
    const name = typeof id === "number" ? program.fileNames[id - 1] : null;
    if (typeof name === "string") recorded.add(key(path.resolve(dir, name)));
  };
  for (const entry of program.root) {
    if (typeof entry === "number") add(entry);
    else if (Array.isArray(entry) && typeof entry[0] === "number" && typeof entry[1] === "number") for (let id = entry[0]; id <= entry[1]; id++) add(id);
  }
  const config = path.join(root, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return [];
  const changed = parsed.fileNames.filter((f) => !recorded.has(key(f)));
  if (passStartedAt) {
    const extended = (parsed.options.configFile as { extendedSourceFiles?: string[] } | undefined)?.extendedSourceFiles ?? [];
    for (const file of [config, ...extended]) {
      try {
        if (fs.statSync(file).mtimeMs >= passStartedAt) changed.push(file);
      } catch {}
    }
  }
  return changed;
}

/** A git command's output lines in `root`; throws with git's message when it fails (a bad ref). */
export function gitLines(root: string, args: string[]): string[] {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(String(r.stderr || `git ${args[0]} failed`).trim());
  return String(r.stdout).split("\n").filter(Boolean);
}

/** Another project's program already holds `f`, so a nested project's tsconfig above it says nothing. */
function otherProjectOwns(root: string, projects: CheckProject[], self: CheckProject, f: string): boolean {
  return projects.some((q) => q !== self && !!programFiles(root, q)?.has(f));
}

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
  /** When the running or last pass started, as the watcher heard it. */
  passStartedAt?: number;
  /** When the last pass finished, and what it found. */
  finishedAt?: number;
  errors?: number;
  /** When someone last asked; the watcher exits after IDLE_EXIT_MS without one. */
  askedAt?: number;
  /** When the first pass finished: the build an asker waited for. */
  firstFinishedAt?: number;
  /** The compiler this watcher runs. Absent means the tree had none and PATH's tsc is in use. */
  tsc?: string;
  /** The repository the tree checks out (its main checkout), which learned sizes are kept under. Absent from watchers older than memory admission. */
  repo?: string;
  /** The most memory the watcher and its tsc have held, as of its last pass. */
  peakRssBytes?: number;
  /** A one-shot `bun check` run (checkBun.ts), not a watcher: the ask that started it knows it by runId. */
  checker?: "bun";
  runId?: string;
  /** The tree the run checks (treeSignature), so an ask on the same tree shares it. */
  tree?: string;
}

export const IDLE_EXIT_MS = 45 * 60_000;
/** How long a pass nobody asks about may run before its watcher gives it up. */
export const STUCK_PASS_MS = 30 * 60_000;

/**
 * Why a watcher should exit now, or null.
 *
 * gone: its tree or tsconfig no longer exists (a scratch dir, a removed
 * worktree), so nobody can ask about it again.
 *
 * idle: nobody has asked in IDLE_EXIT_MS, measured from the later of the
 * last ask and the first finished pass. Later passes do not count: an agent
 * editing the tree triggers them without anyone asking, and two such
 * watchers burned 150% CPU for nobody (2026-10-14).
 *
 * stuck: a pass in flight, unasked for IDLE_EXIT_MS and running longer than
 * STUCK_PASS_MS. A pass someone waits on is never given up: on a loaded
 * machine a first pass can outlive the idle window, and a watcher that quit
 * then threw the whole build away (2026-09-17). A waiting asker refreshes
 * askedAt every ASK_HEARTBEAT_MS, so only a pass nobody asks about qualifies;
 * watchers stuck "checking" for hours held memory for nobody (2026-11-21).
 * Last ask is the only measure of interest: an Agent-tool subagent works in
 * a worktree with no process of its own there.
 */
export function watcherExit(state: Pick<WatchState, "inProgress" | "askedAt" | "firstFinishedAt" | "startedAt" | "passStartedAt">, treeExists: boolean, now = Date.now()): "gone" | "idle" | "stuck" | null {
  if (!treeExists) return "gone";
  const last = Math.max(state.askedAt ?? 0, state.firstFinishedAt ?? 0, state.startedAt);
  if (now - last <= IDLE_EXIT_MS) return null;
  if (!state.inProgress) return "idle";
  return now - (state.passStartedAt ?? state.startedAt) > STUCK_PASS_MS ? "stuck" : null;
}
/**
 * How long a pass that did not check the tree on disk may wait for tsc to
 * start one that does, before the watcher counts as having lost track of it.
 * tsc starts a pass a quarter second after it hears of a change.
 */
export const UNSEEN_GRACE_MS = 15_000;
/** How long a watcher's recorded pid may be dead before an ask stops waiting on it. */
export const DEAD_GRACE_MS = 5_000;

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
/** tsc's incremental state for the program, rewritten by tsc after every pass. */
export const buildInfoPath = (dir: string): string => path.join(dir, "tsbuildinfo");

/**
 * The checkout a worktree was made from: the directory holding the shared
 * git dir. Null for a tree that is its own main checkout, or outside git.
 */
export function mainCheckoutOf(root: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf-8", timeout: 10_000 });
  const common = (r.stdout ?? "").trim();
  if (!common || path.basename(common) !== ".git") return null;
  const main = path.dirname(common);
  return path.resolve(main) === path.resolve(root) ? null : main;
}

/**
 * Re-home another tree's tsc build info onto this tree. tsc records every
 * file of the program by its path relative to the build info, and reuses a
 * file's check only when the path and the content hash both match. A file
 * of the donor tree maps to the same relative path here, except one this
 * tree reaches through a symlink back into the donor (the shared
 * node_modules a worktree links to): that stays the donor's path, which is
 * where tsc resolves it from here too. Content tsc finds changed is checked
 * again, so a stale or wrong mapping costs time, never a missed error.
 */
export function rebaseBuildInfo(text: string, from: { root: string; dir: string }, to: { root: string; dir: string }): string | null {
  let info: { fileNames?: unknown };
  try {
    info = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(info.fileNames)) return null;
  const real = (p: string): string | null => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  info.fileNames = info.fileNames.map((name) => {
    if (typeof name !== "string") return name;
    const donorFile = path.resolve(from.dir, name);
    const rel = path.relative(from.root, donorFile);
    let target = donorFile;
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const here = path.join(to.root, rel);
      const shared = real(here);
      target = shared !== null && shared === real(donorFile) && here !== shared ? donorFile : here;
    }
    return path.relative(to.dir, target);
  });
  return JSON.stringify(info);
}

/**
 * A tree's first watcher starts from its main checkout's last pass instead
 * of from nothing: a fresh worktree differs from main in a handful of files,
 * so tsc re-checks those and their dependents and trusts the rest. A fleet
 * of worktrees each building a 2 to 6 GB program cold is what swapped this
 * machine for a night (2026-10-02). Best effort: any failure leaves a cold
 * build, the old behaviour.
 */
export function seedBuildInfo(root: string, project: string): boolean {
  const dir = watchDir(root, project);
  if (fs.existsSync(buildInfoPath(dir))) return false;
  const main = mainCheckoutOf(root);
  if (!main) return false;
  const donorDir = watchDir(main, project);
  let text: string;
  try {
    text = fs.readFileSync(buildInfoPath(donorDir), "utf-8");
  } catch {
    return false;
  }
  const rebased = rebaseBuildInfo(text, { root: main, dir: donorDir }, { root, dir });
  if (!rebased) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(buildInfoPath(dir), rebased);
  return true;
}

/**
 * Remove the state file only while it is still `pid`'s. A watcher stopped to
 * make way for a new one (--fresh) can get to its cleanup after the new one
 * has written its state, and removing that made the ask report a healthy new
 * watcher as gone (seen at load 240, 2026-11-13).
 */
export function removeOwnState(dir: string, pid: number): void {
  const s = readWatchState(dir);
  if (!s || s.pid === pid) fs.rmSync(statePath(dir), { force: true });
}

/** What makes a process a watcher: its command line runs `cast check-watch`. Tests that stand in for a watcher with their own pid widen it. */
export const watcherIdentity = { matches: (command: string, _pid: number): boolean => /\bcheck-watch\b/.test(command) };

/** Which of `pids` run `cast check-watch`, from one ps; null when ps cannot say (then every pid is taken at its word). */
function watcherPids(pids: number[]): Set<number> | null {
  if (!pids.length) return new Set();
  const r = spawnSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], { encoding: "utf-8", timeout: 5_000 });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  const out = new Set<number>();
  for (const line of String(r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && watcherIdentity.matches(m[2]!, Number(m[1]))) out.add(Number(m[1]));
  }
  return out;
}

/** The pid runs `cast check-watch`, not some program that inherited a dead watcher's pid. */
export function isWatcherProcess(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
  // ps itself failing (timed out, not run) says nothing either way, so the pid is still treated as the watcher.
  if (r.error || (r.status !== 0 && r.status !== 1)) return true;
  const command = String(r.stdout ?? "").trim();
  return !!command && watcherIdentity.matches(command, pid);
}

/** The launchd label a tree's watcher for one project runs under. */
export const watcherLabel = (dir: string): string => `sh.codecast.check.${path.basename(path.dirname(dir))}.${path.basename(dir)}`.replace(/[^A-Za-z0-9._-]/g, "_");

/** launchd still runs or holds `label`: a job its old process is unloading would kill or block a successor under the same label. */
export function launchdHolds(label: string): "running" | "loaded" | "gone" {
  if (process.platform !== "darwin" || process.getuid === undefined) return "gone";
  const r = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf-8", timeout: 5_000 });
  if (r.status !== 0) return "gone";
  return /\bstate = running\b/.test(String(r.stdout ?? "")) ? "running" : "loaded";
}

/**
 * Stop a watcher and wait until it and its launchd job are gone, so neither
 * its cleanup nor its job's unload can land on the successor: the successor
 * reuses the label, and launchd leaves a running job alone and lets a late
 * unload kill the new one. Bounded: what outlives the wait is left to finish
 * on its own.
 */
export async function stopWatcher(dir: string, pid: number, kill: (pid: number) => void, waitMs = 10_000): Promise<void> {
  // A state file can outlive its watcher (killed outright, a reboot) and name a pid another program now has.
  if (!isPidAlive(pid) || !isWatcherProcess(pid)) return removeOwnState(dir, pid);
  try {
    kill(pid);
  } catch {}
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isPidAlive(pid)) await new Promise((r) => setTimeout(r, 100));
  // A pid the system has since given to another program is not this watcher, and nobody should be told to kill it.
  if (isPidAlive(pid)) {
    // Its process group holds its tsc too: killing the watcher alone would orphan a tsc no admission can see.
    const pgid = Number(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }).stdout?.trim()) || undefined;
    throw new CheckFailure(`the old ${path.basename(dir)} watcher (pid ${pid}) did not stop within ${Math.round(waitMs / 1000)}s`, "stuck", { pid, pgid });
  }
  // A watcher unloads its own job on the way out with a detached launchctl call; until that lands, a successor under
  // the same label would be left alone (still running) or killed by it (bootstrapped first). Bounded, for a watcher
  // killed outright, which never unloads: the start reloads a job left loaded.
  const label = watcherLabel(dir);
  const settle = Date.now() + 5_000;
  while (Date.now() < settle && launchdHolds(label) !== "gone") await new Promise((r) => setTimeout(r, 250));
  removeOwnState(dir, pid);
}

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
export function watchReducer(dir: string, state: WatchState, hooks: { onStart?: () => void; onDone?: () => void } = {}) {
  let buffer: string[] = [];
  return (line: string): void => {
    const ev = classifyWatchLine(line);
    if (ev.kind === "start") {
      buffer = [];
      state.inProgress = true;
      state.passStartedAt = Date.now();
      hooks.onStart?.();
      writeWatchState(dir, state);
      return;
    }
    if (ev.kind === "done") {
      fs.writeFileSync(outputPath(dir), buffer.join("\n").trim() + "\n");
      buffer = [];
      state.inProgress = false;
      state.finishedAt = Date.now();
      state.firstFinishedAt ??= state.finishedAt;
      state.errors = ev.errors;
      hooks.onDone?.();
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
  const repo = repoOf(root);
  const state: WatchState = { pid: process.pid, project, tsconfig, root, repo, startedAt: Date.now(), inProgress: true, askedAt: Date.now(), ...(own ? { tsc: own } : {}) };
  // Marks where this watcher's log begins, so an ask never reads an earlier watcher's last words as this one's.
  console.log(`watcher ${process.pid} started (${new Date(state.startedAt).toISOString()})`);
  writeWatchState(dir, state);
  // Peak memory of each pass, sampled while it runs, recorded when it ends (watcherMemory.ts).
  let passPeak = 0;
  let tscPid = 0;
  const sample = (): number => {
    passPeak = Math.max(passPeak, peakOfPids([process.pid, tscPid]));
    return passPeak;
  };
  const reduce = watchReducer(dir, state, {
    onStart: () => { passPeak = 0; },
    onDone: () => {
      state.peakRssBytes = Math.max(state.peakRssBytes ?? 0, sample());
      // The watcher's peak so far, not this pass's: an incremental pass after a full build (RSS off macOS can fall
      // between them) must not teach admission a size smaller than the build it will face again.
      recordPeak(repo, project, { at: Date.now(), bytes: state.peakRssBytes, outcome: "clean", root });
    },
  });
  // footprint's figure is a lifetime peak, so the sample at the pass's end (onDone) misses nothing; one a minute keeps a
  // long pass's peak current for admission. RSS (off macOS) is a figure of the moment, so it is sampled more often.
  const sampler = setInterval(() => { if (state.inProgress) sample(); }, process.platform === "darwin" ? 60_000 : 5_000);
  if (seedBuildInfo(root, project)) console.log(`seeded the first pass from ${mainCheckoutOf(root)}`);
  // Incremental: a restarted watcher (the slot cap stops idle ones) and a
  // seeded worktree re-check only what changed since the recorded pass.
  const oomBefore = oomKillCount();
  // Files are watched through their directories. tsc's default watches each
  // file's inode, and on Linux an inode replaced while something still holds
  // it open (git checkout swaps every file it changes) never reports its
  // deletion: the watch stays on the old inode, and tsc never hears of that
  // path again. A file under the include globs is also covered by its
  // directory's watch; one reached only by import is not (ct-62781: Union's
  // mobile program reaches ../backend, and an Implement round looped on
  // exports present on disk).
  const nodeOptions = tscNodeOptions(process.env.NODE_OPTIONS, process.env[CHECK_HEAP_ENV]);
  const child = spawn(own ?? "tsc", ["--noEmit", "--watch", "--watchFile", "useFsEventsOnParentDirectory", "--preserveWatchOutput", "--pretty", "false", "--incremental", "--tsBuildInfoFile", buildInfoPath(dir), "-p", path.join(root, tsconfig)], {
    cwd: path.dirname(path.join(root, tsconfig)),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
  });
  tscPid = child.pid ?? 0;
  let rest = "";
  // The last lines tsc printed, so a tsc that dies (out of heap, killed) says why in watch.log.
  // Native stack frames stay out of it: V8 prints dozens after a fatal error,
  // and they pushed out the one line that said why (a full heap).
  const tail: string[] = [];
  let fatal: string | null = null;
  const onData = (chunk: Buffer | string): void => {
    rest += String(chunk);
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      reduce(line);
      if (isHeapFatal(line)) fatal = line;
      if (isNativeFrame(line)) continue;
      tail.push(line);
      if (tail.length > 20) tail.shift();
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const idle = setInterval(() => {
    const why = watcherExit(readWatchState(dir) ?? state, fs.existsSync(path.join(root, tsconfig)));
    if (!why) return;
    const detail = why === "gone" ? `its tree is gone (no ${tsconfig})` : why === "stuck" ? "a pass nobody asked about ran too long" : "";
    console.log(`exiting: ${detail || "nobody asked"}`);
    logWatcherEvent(why === "gone" ? "stop" : "idle-exit", { project, root }, detail);
    child.kill("SIGTERM");
    clearInterval(idle);
  }, 60_000);
  const stop = (): void => {
    child.kill("SIGTERM");
    try {
      removeOwnState(dir, process.pid);
    } catch {}
    unloadOwnLaunchdJob();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      console.log(`tsc exited (${signal ?? `code ${code}`}); its last lines:\n${[...tail, rest].filter((l) => l && !isNativeFrame(l)).join("\n")}`);
      // The last line is what an asker reads: a memory kill says so, with the machine's numbers.
      const killed = memoryDeath({ what: `the ${project} typecheck (tsc)`, killed: signal === "SIGKILL", oomBefore, oomAfter: oomKillCount(), repoRoot: root });
      const heap = heapDeath({ project, signal, fatal, nodeOptions });
      if (killed ?? heap) console.log(killed ?? heap);
      // A death by memory starts the learning over: the next watcher reserves the whole ceiling. A full heap is tsc's
      // own cap, not the machine's memory: recorded, but it neither resets the learning nor asks for the ceiling.
      if (killed ?? heap) recordPeak(repo, project, { at: Date.now(), bytes: Math.max(passPeak, state.peakRssBytes ?? 0, 1), outcome: killed ? "oom" : "heap", root });
      resolve();
    });
    // A tsc that never starts (none in the tree and none on PATH) emits only
    // this, never exit: without it the watcher would wait forever with a pass
    // marked in flight, and every ask would wait on it.
    child.on("error", (err) => {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT" && !own;
      console.log(missing
        ? `tsc did not start: this tree has no TypeScript installed (its dependencies are missing) and none is on PATH. Install them (the setup install in .codecast/workspace.toml, e.g. bun install), then ask again`
        : `tsc did not start: ${err.message}`);
      resolve();
    });
  });
  clearInterval(idle);
  clearInterval(sampler);
  try {
    removeOwnState(dir, process.pid);
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
  /** The answer is the watcher's first pass, built from the files on disk: nothing in it is left from a half-written tree. */
  firstPass: boolean;
  /** Errors that name an export or module present on disk (checkOutcome.ts), and two of them. */
  phantom: number;
  phantomExamples: string[];
  /** The tsc on PATH checked it: the tree installs none. */
  globalTsc: boolean;
  /** Answered by a `bun check` run, which took runMs. */
  checker?: "bun";
  runMs?: number;
}

export type WatcherStarter = (root: string, project: CheckProject) => void;

/**
 * Respawn ourselves as the watcher, logging to the watch dir: as an
 * Interactive launchd job where launchd takes one, so the build does not
 * inherit the agent tree's utility clamp (launchdJob.ts), else detached.
 */
export const startDetachedWatcher: WatcherStarter = (root, project) => startCheckProcess(root, project);

/** Start `cast check-watch` for a project, detached as above; `extra` turns it into a bun run (checkBun.ts). */
export function startCheckProcess(root: string, { name, tsconfig }: CheckProject, extra: string[] = []): void {
  const dir = watchDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = [...(viaRuntime ? [process.argv[1]] : []), "check-watch", root, name, tsconfig, ...extra];
  const label = watcherLabel(dir);
  // A cap the asker raised in NODE_OPTIONS reaches the watcher under launchd only by this name.
  const asked = heapCapMb(process.env.NODE_OPTIONS);
  if (asked && asked > TSC_HEAP_MB) process.env[CHECK_HEAP_ENV] = String(asked);
  if (startLaunchdJob({ label, argv: [process.execPath, ...args], plistPath: path.join(dir, "watcher.plist"), logPath: logPath(dir) })) return;
  const log = fs.openSync(logPath(dir), "a");
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  opts: { start?: WatcherStarter; budgetMs?: number; fresh?: boolean; note?: (line: string) => void; maxWatchers?: number; kill?: (pid: number) => void; protect?: ReadonlySet<string>; unseenGraceMs?: number; queueWaitMs?: number } = {},
): Promise<CheckResult> {
  const project = target.name;
  const dir = watchDir(root, project);
  const budget = opts.budgetMs ?? 20 * 60_000;
  const note = opts.note ?? (() => {});
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const deadline = Date.now() + budget;
  let started = false;
  let state: WatchState | null;
  const release = await lockFor(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
  try {
    state = readWatchState(dir);
    // A state file that outlived its watcher can name a pid another program now has; waiting on that would never end.
    if (state && isPidAlive(state.pid) && !isWatcherProcess(state.pid)) {
      removeOwnState(dir, state.pid);
      state = null;
    }
    // The tree's config now names a different tsconfig for this project than
    // the running watcher was built on (an entry corrected in
    // .codecast/check.toml). The old program would keep answering, so it is
    // replaced rather than trusted.
    if (state && (state.tsconfig !== target.tsconfig || state.checker)) {
      note(state.checker ? `${project} now checks with a tsc watcher; stopping its bun check run` : `the ${project} project now names ${target.tsconfig}, not ${state.tsconfig}; restarting its watcher`);
      await stopWatcher(dir, state.pid, kill);
      state = null;
    }
    if (state && opts.fresh) {
      await stopWatcher(dir, state.pid, kill);
      state = null;
    }
  } finally {
    release();
  }
  // A death is told by what the log gains from here: an earlier watcher's last words are not this one's.
  const logFrom = (() => { try { return fs.statSync(logPath(dir)).size; } catch { return 0; } })();
  if (!state || !isPidAlive(state.pid)) started = await startWhenSlotFrees(target, root, { ...opts, start: opts.start ?? startDetachedWatcher, note, kill, deadline });
  // Mark the ask, which keeps the watcher alive.
  const askedAt = Date.now();
  const current = readWatchState(dir);
  if (current) writeWatchState(dir, { ...current, askedAt });
  let noted = false;
  let beat = askedAt;
  let deadSince: { pid: number; at: number } | null = null;
  // A finished pass that did not check the files on disk, and since when.
  let behind = null as { finishedAt: number; since: number } | null;
  for (;;) {
    const s = readWatchState(dir);
    if (!s) throw watcherDeath(project, dir, "went away", logFrom);
    // A watcher killed outright leaves its state behind, marked mid-pass. Its
    // pid can also change while it starts (it relaunches itself under
    // launchd), so only a pid that stays dead counts as gone.
    if (isPidAlive(s.pid)) deadSince = null;
    else if (!deadSince || deadSince.pid !== s.pid) deadSince = { pid: s.pid, at: Date.now() };
    else if (Date.now() - deadSince.at > DEAD_GRACE_MS) throw watcherDeath(project, dir, "died", logFrom);
    // Keep the pass wanted while this ask waits on it, so the queue never takes its slot.
    if (Date.now() - beat >= ASK_HEARTBEAT_MS) {
      beat = Date.now();
      writeWatchState(dir, { ...s, askedAt: beat });
    }
    // A finished pass answers only if it checked the tree as it is on disk.
    // A change can land after a pass read the file, or before tsc's debounce
    // let it start the next one; tsc then starts another, which this ask waits
    // for. A watcher that never does has lost track of the file, and the ask
    // says so rather than answer about a tree that no longer exists.
    const notAsChecked = !s.inProgress && s.finishedAt ? [...(filesNotAsChecked(dir) ?? []), ...unlistedChanges(dir, root, target.tsconfig, s.passStartedAt)] : [];
    if (!s.inProgress && s.finishedAt && notAsChecked.length) {
      const grace = opts.unseenGraceMs ?? UNSEEN_GRACE_MS;
      if (behind?.finishedAt !== s.finishedAt) behind = { finishedAt: s.finishedAt, since: Date.now() };
      else if (Date.now() - behind.since > grace) {
        const named = notAsChecked.slice(0, 3).map((f) => path.relative(root, f)).join(", ") + (notAsChecked.length > 3 ? ` and ${notAsChecked.length - 3} more` : "");
        throw new CheckFailure(`the ${project} typecheck watcher has not checked ${named} as it is on disk, and tsc started no pass in ${Math.round(grace / 1000)}s`, "stale");
      }
    }
    if (!s.inProgress && s.finishedAt && !notAsChecked.length) {
      const diagnostics = fs.existsSync(outputPath(dir)) ? fs.readFileSync(outputPath(dir), "utf-8") : "";
      // A global tsc resolves libs and types its own way, so its errors are not
      // the project's. Say so rather than let a wall of them read as real. The
      // tree is asked now rather than trusting the state file, which a watcher
      // started by an older CLI wrote without this field.
      const globalTsc = (s.errors ?? 0) > 0 && !tscInTree(root, target.tsconfig);
      if (globalTsc) note(`${project} was checked by the tsc on PATH: this tree installs none above ${s.tsconfig}, and a different compiler reports different errors`);
      const { phantom, examples } = (s.errors ?? 0) > 0 ? phantomErrors(diagnostics, path.dirname(path.join(root, target.tsconfig)), moduleResolver(root, target.tsconfig)) : { phantom: 0, examples: [] };
      return { project, errors: s.errors ?? 0, diagnostics, passAgeMs: Date.now() - s.finishedAt, started, firstPass: !s.firstFinishedAt || s.finishedAt === s.firstFinishedAt, phantom, phantomExamples: examples, globalTsc };
    }
    if (Date.now() > deadline) throw new CheckFailure(`the ${project} typecheck is still running after ${Math.round(budget / 60_000)} min; the machine is loaded (${logPath(dir)})`, "wait-elapsed");
    if (!noted && Date.now() - askedAt > 5_000) {
      noted = true;
      note(`waiting for the ${project} typecheck pass to finish… (a first pass on a big program takes minutes; if this call is cut off, the pass keeps running and the next ask picks it up)`);
    }
    await sleep(300);
  }
}

/** Module resolution as the project's own tsc does it (paths aliases, index files, .d.ts); undefined when the tree's TypeScript cannot be loaded. */
function moduleResolver(root: string, tsconfig: string): ModuleResolver | undefined {
  const ts = treeTypeScript(root, tsconfig);
  if (!ts) return undefined;
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, tsconfig), undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) return undefined;
  return (spec, fromFile) => ts.resolveModuleName(spec, fromFile, parsed.options, ts.sys).resolvedModule?.resolvedFileName ?? null;
}

/**
 * A lock `cast check` waits on, its timeout told apart: another live ask
 * holding it is contention (busy, ask again), a lock nobody can reclaim is
 * the tool's own failure.
 */
export async function lockFor(file: string, opts: Parameters<typeof acquireFileLock>[1]): Promise<() => void> {
  try {
    return await acquireFileLock(file, opts);
  } catch (err) {
    const message = (err as Error).message;
    throw new CheckFailure(message, /\bhas held\b|\bwas still taking\b/.test(message) ? "locked" : "infra", { lock: file });
  }
}

/** A watcher that stopped without an answer, named by the reason it logged last. */
export function watcherDeath(project: string, dir: string, how: string, fromByte = 0): CheckFailure {
  const logged = lastLogLine(dir, fromByte);
  // The watcher's own start lines say nothing about why it stopped.
  const last = logged && /^(watcher \d+ started \(|seeded the first pass from )/.test(logged) ? null : logged;
  const command = /NODE_OPTIONS=--max-old-space-size=\d+ cast check --fresh \S+/.exec(last ?? "")?.[0];
  return new CheckFailure(`the ${project} typecheck watcher ${how}: ${last ?? (logged || fromByte > 0 ? "it logged no reason" : "it left no log")} (${logPath(dir)})`, deathKind(last), { log: logPath(dir), command });
}

/**
 * The last thing a watcher wrote to its log, which names why it stopped.
 * Native stack frames are skipped: a log from an older watcher ends in dozens
 * of them after V8 aborts, and the last one (a dyld frame) said nothing.
 */
export function lastLogLine(dir: string, fromByte = 0): string | null {
  try {
    const line = fs.readFileSync(logPath(dir)).subarray(fromByte).toString("utf-8").trim().split("\n").filter((l) => l.trim() && !isNativeFrame(l)).pop();
    return line?.replace(/; its last lines:$/, "") ?? null;
  } catch {
    return null;
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
        removeOwnState(dir, s.pid);
        continue;
      }
      out.push({ ...s, dir });
    }
  }
  // A state file that outlived its watcher (a reboot, a kill -9) can name a pid another program now has:
  // that is no watcher to measure, count or stop.
  const programs = watcherPids(out.map((w) => w.pid));
  if (!programs) return out;
  const kept: Array<WatchState & { dir: string }> = [];
  for (const w of out) {
    if (programs.has(w.pid)) kept.push(w);
    else removeOwnState(w.dir, w.pid);
  }
  return kept;
}

/**
 * Stop every watcher on `tree` or a tree inside it. A watcher outlives the
 * session that asked for it by up to IDLE_EXIT_MS, and its tsc works inside
 * the tree all that time: a tree being set aside or released has nobody left
 * to ask, and its watchers would keep it in use. Returns what was stopped.
 */
export function stopWatchersIn(tree: string, kill: (pid: number) => void = (pid) => process.kill(pid, "SIGTERM")): Array<WatchState & { dir: string }> {
  const stopped = listWatchers().filter((w) => w.root === tree || w.root.startsWith(`${tree}/`));
  for (const w of stopped) {
    try {
      kill(w.pid);
    } catch {}
    fs.rmSync(statePath(w.dir), { force: true });
    logWatcherEvent("stop", w, "its tree was released");
  }
  return stopped;
}

/**
 * Every watcher start, eviction, stop and idle exit on this machine, one line each.
 * A program stopped to make room is rebuilt whole on its next ask, so this is
 * the cost the cap trades against memory, and the record that shows a cap
 * too small for the trees sharing it.
 */
export const eventsPath = (): string => path.join(checkHome(), "events.log");

export function logWatcherEvent(event: "start" | "evict" | "stop" | "idle-exit", w: { project: string; root: string }, detail = ""): void {
  try {
    fs.mkdirSync(checkHome(), { recursive: true });
    fs.appendFileSync(eventsPath(), `${new Date().toISOString()} ${event} ${w.project} ${w.root}${detail ? ` ${detail}` : ""}\n`);
  } catch {}
}
