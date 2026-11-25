/**
 * `cast check` through `bun check` instead of a tsc watcher, for a tree whose
 * `.codecast/check.toml` sets `checker = "bun"` at its top level. A tree
 * without that key keeps the watcher (check.ts); nothing here runs for it.
 *
 * `bun check` (bun 1.4.4 and later) runs TypeScript's native compiler on
 * several threads and checks a program in seconds, so there is nothing to keep
 * warm: each ask runs one check and the process exits. What the watcher's
 * machinery gives still applies. A run is a short-lived `cast check-watch
 * --bun` process that writes the same state file a watcher does, marked
 * `checker: "bun"` and never finished, so the machine counts it as a cold
 * build of its own kind: it waits in the same queue as watcher starts for one
 * of a few bun-run slots and for free memory (bunRunFits, checkCapacity.ts),
 * never stops a watcher to make room, and shows in `cast check-status`.
 * It records its peak memory under the project like a watcher's first pass.
 *
 * Asks share a run: an ask that finds a run of the same project in flight,
 * started on the tree as it is now (the same HEAD and the same uncommitted
 * files with the same stat), waits for that run's result instead of starting
 * another. A run that started before a change is left to finish, and the ask
 * starts its own after it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "./proc.js";
import { memoryDeath, oomKillCount } from "./repoNeed.js";
import { CheckFailure, deathKind } from "./checkOutcome.js";
import { peakOfPids, recordPeak } from "./watcherMemory.js";
import { unloadOwnLaunchdJob } from "./launchdJob.js";
import { isPidAlive } from "./workspace/chrome.js";
import {
  ASK_HEARTBEAT_MS, DEAD_GRACE_MS, STUCK_PASS_MS, isWatcherProcess, lockFor, logPath, readWatchState, removeOwnState, repoOf, sleep,
  lastLogLine, startCheckProcess, startWhenSlotFrees, stopWatcher, watchDir, writeWatchState,
  type CheckProject, type CheckResult, type WatchState,
} from "./check.js";

/** The bun binary `cast check` runs; `bun` on PATH when unset. */
export const CHECK_BUN_ENV = "CAST_CHECK_BUN";
/** The first bun with `bun check`. */
export const BUN_CHECK_MIN_VERSION = "1.4.4";
/** Threads each run uses: a check is one of several on a shared machine, never the only thing on it. */
export const BUN_CHECK_THREADS = 4;

/**
 * The bun binary to run, as an absolute path: CAST_CHECK_BUN (a path, read
 * from the caller's directory, or a name looked up on PATH), else `bun` on
 * PATH; null when there is none. Absolute because the run starts elsewhere
 * (the tsconfig's directory, launchd's PATH).
 */
export function bunBinary(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const set = env[CHECK_BUN_ENV]?.trim();
  if (set?.includes("/")) return path.resolve(cwd, set);
  return Bun.which(set || "bun", { PATH: env.PATH ?? "" }) ?? (set || null);
}

const versionParts = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** `a` is at least `b`, as x.y.z versions; false when either does not parse. */
export function versionAtLeast(a: string, b: string): boolean {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

/**
 * Why `bin` cannot run `bun check`, as the failure an ask ends with (70, with
 * a hint naming the upgrade), or null when it can. Asked before an ask queues,
 * so a missing or old bun costs no slot.
 */
export function bunCheckUnavailable(bin: string | null, version: (bin: string) => string | null = bunVersion): CheckFailure | null {
  const where = process.env[CHECK_BUN_ENV]?.trim() ? `${CHECK_BUN_ENV}=${bin}` : "bun on PATH";
  if (!bin) return new CheckFailure(`this tree checks with bun check (checker = "bun"), and no bun is on PATH`, "no-bun");
  const v = version(bin);
  if (v === null) return new CheckFailure(`this tree checks with bun check (checker = "bun"), and ${where} did not run`, "no-bun");
  if (!versionAtLeast(v, BUN_CHECK_MIN_VERSION)) {
    return new CheckFailure(`this tree checks with bun check (checker = "bun"), which needs bun ${BUN_CHECK_MIN_VERSION} or newer; ${where} is ${v}`, "no-bun");
  }
  return null;
}

function bunVersion(bin: string): string | null {
  const r = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 10_000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? "").trim() || null;
}

/** The key a project's bun run peaks are learned under, apart from its tsc watcher's: the two compilers need different memory. */
export const bunPeakKey = (project: string): string => `${project}.bun-check`;

/** The command a run executes. */
export function bunCheckArgs(root: string, tsconfig: string): string[] {
  return ["check", "-p", path.join(root, tsconfig), "--no-pretty", "--all", "--no-script", "--threads", String(BUN_CHECK_THREADS)];
}

/** bun's environment for a run: CLAUDECODE or AGENT set switches its output to tagged blocks the parser does not read. */
export function bunCheckEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.CLAUDECODE;
  delete out.AGENT;
  return out;
}

/** One diagnostic's first line in tsc's `--pretty false` format, with or without a file position. */
const DIAGNOSTIC = /^(?:.+\(\d+,\d+\): )?error TS\d+: /;
/** bun's closing line: "Found 2 errors in 1 file, checked 3,475 files [..]" or "✓ No type errors in 83 files [..]". */
const SUMMARY = /^(?:Found ([\d,]+) errors?\b|✓ No type errors\b)/;

/**
 * What a run's output says, or null when it says nothing a verdict can rest
 * on. bun exits 1 both for type errors and for its own failures (an unknown
 * flag, a crash), so exit 1 is type errors only when diagnostics parsed.
 * A tsconfig problem (no inputs, a bad option) parses as a diagnostic, as it
 * does from tsc, and counts as an error the same way.
 */
export function parseBunCheck(output: string, exitCode: number | null): { errors: number; diagnostics: string } | null {
  const kept: string[] = [];
  let counted = 0;
  let found = 0;
  for (const line of output.split("\n")) {
    const summary = SUMMARY.exec(line.trim());
    if (summary) {
      found = Math.max(found, Number((summary[1] ?? "0").replace(/,/g, "")));
      continue;
    }
    if (!line.trim()) continue;
    if (DIAGNOSTIC.test(line)) counted++;
    kept.push(line);
  }
  if (exitCode === 0) return { errors: 0, diagnostics: "" };
  if (exitCode !== 1 || !counted) return null;
  return { errors: Math.max(counted, found), diagnostics: kept.join("\n") + "\n" };
}

/**
 * The tree as git sees it: HEAD, every uncommitted path (untracked included)
 * and every ignored entry git lists (an ignored directory as one entry), each
 * with its stat. Two asks with the same signature see the same files, so one
 * run answers both. An ignored directory counts by its own stat, which an
 * install or a generator that replaces files changes; an edit in place deep
 * inside one (node_modules, a codegen folder) during a run is not seen, which
 * `--fresh` covers. Null outside git or when git fails: then nothing is shared.
 * Never takes the index lock: forty sessions commit in this checkout.
 */
export function treeSignature(root: string): string | null {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf-8", timeout: 10_000, env });
  if (head.status !== 0) return null;
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional", "--no-renames"], { encoding: "utf-8", timeout: 30_000, maxBuffer: 256 * 1024 * 1024, env });
  if (status.status !== 0) return null;
  const hash = createHash("sha256").update(String(head.stdout).trim());
  for (const entry of String(status.stdout).split("\0")) {
    if (!entry) continue;
    const file = entry.slice(3);
    let stat = "-";
    try {
      const st = fs.statSync(path.join(root, file));
      stat = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {}
    hash.update(`\0${entry}\0${stat}`);
  }
  return hash.digest("hex");
}

/** A finished run, read by every ask that waited on it. */
export interface BunRunResult {
  runId: string;
  startedAt: number;
  finishedAt: number;
  errors?: number;
  diagnostics?: string;
  /** The run gave no verdict, and why (its last words, also in the log). */
  failure?: string;
}

/** One file per run, so a later run never overwrites the answer an ask is still waiting to read. */
export const bunResultsDir = (dir: string): string => path.join(dir, "bun-results");
export const bunResultPath = (dir: string, runId: string): string => path.join(bunResultsDir(dir), `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
/** How long a run's result stays for asks that waited on it. */
const RESULT_KEEP_MS = 60 * 60_000;

export function readBunResult(dir: string, runId: string): BunRunResult | null {
  try {
    return JSON.parse(fs.readFileSync(bunResultPath(dir, runId), "utf-8")) as BunRunResult;
  } catch {
    return null;
  }
}

function writeBunResult(dir: string, result: BunRunResult, now = Date.now()): void {
  const file = bunResultPath(dir, result.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(result));
  fs.renameSync(tmp, file);
  for (const name of fs.readdirSync(path.dirname(file))) {
    const old = path.join(path.dirname(file), name);
    try {
      if (now - fs.statSync(old).mtimeMs > RESULT_KEEP_MS) fs.rmSync(old, { force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// The run: `cast check-watch <root> <project> <tsconfig> --bun <bin> --run <id>`
// ---------------------------------------------------------------------------

/** The foreground body of one bun run: check once, leave the result, exit. */
export async function runBunCheck(root: string, project: string, tsconfig: string, bin: string, runId: string): Promise<void> {
  const dir = watchDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const repo = repoOf(root);
  const startedAt = Date.now();
  console.log(`bun run ${process.pid} started (${new Date(startedAt).toISOString()})`);
  const state: WatchState = {
    pid: process.pid, project, tsconfig, root, repo, startedAt, inProgress: true, askedAt: startedAt, passStartedAt: startedAt,
    checker: "bun", runId, tree: treeSignature(root) ?? undefined,
  };
  writeWatchState(dir, state);
  const finish = (result: Omit<BunRunResult, "runId" | "startedAt" | "finishedAt">): void => {
    writeBunResult(dir, { runId, startedAt, finishedAt: Date.now(), ...result });
    try {
      removeOwnState(dir, process.pid);
    } catch {}
    unloadOwnLaunchdJob();
  };
  const oomBefore = oomKillCount();
  const child = spawn(bin, bunCheckArgs(root, tsconfig), { cwd: path.dirname(path.join(root, tsconfig)), stdio: ["ignore", "pipe", "pipe"], env: bunCheckEnv() });
  let peak = 0;
  const sample = () => { peak = Math.max(peak, peakOfPids([child.pid ?? 0])); };
  const sampler = setInterval(sample, 250);
  let timedOut = false;
  const stuck = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, STUCK_PASS_MS);
  let output = "";
  child.stdout?.on("data", (c) => { output += String(c); });
  child.stderr?.on("data", (c) => { output += String(c); });
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
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => resolve({ error }));
  });
  sample();
  clearInterval(sampler);
  clearTimeout(stuck);
  if ("error" in ended) {
    const why = `bun check did not start: ${ended.error.message}`;
    console.log(why);
    return finish({ failure: why });
  }
  const took = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  const parsed = parseBunCheck(output, ended.code);
  if (parsed) {
    console.log(`bun check finished in ${took}: ${parsed.errors} error${parsed.errors === 1 ? "" : "s"}`);
    recordPeak(repo, bunPeakKey(project), { at: Date.now(), bytes: peak, outcome: "clean", root });
    return finish(parsed);
  }
  // Its own stuck timer's kill is not the machine's memory.
  const killed = timedOut ? undefined : memoryDeath({ what: `the ${project} typecheck (bun check)`, killed: ended.signal === "SIGKILL", oomBefore, oomAfter: oomKillCount(), repoRoot: root });
  if (killed) recordPeak(repo, bunPeakKey(project), { at: Date.now(), bytes: Math.max(peak, 1), outcome: "oom", root });
  const last = output.trim().split("\n").filter((l) => l.trim()).slice(-20).join("\n");
  console.log(`bun check exited (${ended.signal ?? `code ${ended.code}`}) after ${took} with no type errors to report; its last lines:\n${last}`);
  const why = timedOut ? `bun check ran past ${Math.round(STUCK_PASS_MS / 60_000)} min and was stopped` : killed ?? `bun check exited ${ended.signal ?? `with code ${ended.code}`} without reporting a type error: ${last.split("\n").pop() || "it printed nothing"}`;
  console.log(why);
  finish({ failure: why });
}

// ---------------------------------------------------------------------------
// The ask
// ---------------------------------------------------------------------------

/**
 * The diagnostics for one project from a bun run: one in flight on the same
 * tree when there is one, else a new run once a slot frees.
 */
export async function checkWithBun(
  target: CheckProject,
  root: string,
  opts: { budgetMs?: number; fresh?: boolean; note?: (line: string) => void; kill?: (pid: number) => void; protect?: ReadonlySet<string>; queueWaitMs?: number; bin?: string | null; start?: (root: string, project: CheckProject, bin: string, runId: string) => void; signature?: (root: string) => string | null } = {},
): Promise<CheckResult> {
  const bin = opts.bin === undefined ? bunBinary() : opts.bin;
  const unavailable = opts.bin === undefined ? bunCheckUnavailable(bin) : bin ? null : bunCheckUnavailable(null);
  if (unavailable) throw unavailable;
  const project = target.name;
  const dir = watchDir(root, project);
  const budget = opts.budgetMs ?? 20 * 60_000;
  const deadline = Date.now() + budget;
  const note = opts.note ?? (() => {});
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  const signature = opts.signature ?? treeSignature;
  const start = opts.start ?? ((r: string, t: CheckProject, b: string, id: string) => startCheckProcess(r, t, ["--bun", b, "--run", id]));
  const elapsed = () => new CheckFailure(`the ${project} typecheck (bun check) is still running after ${Math.round(budget / 60_000)} min; the machine is loaded (${logPath(dir)})`, "wait-elapsed");
  let fresh = !!opts.fresh;
  for (;;) {
    let runId: string | null = null;
    let busy: WatchState | null = null;
    const release = await lockFor(path.join(dir, "start.lock"), { describe: `cast check ${project}` });
    try {
      let s = readWatchState(dir);
      if (s && isPidAlive(s.pid) && !isWatcherProcess(s.pid)) {
        removeOwnState(dir, s.pid);
        s = null;
      }
      if (s && isPidAlive(s.pid)) {
        if (s.checker !== "bun") {
          note(`${project} now checks with bun check; stopping its tsc watcher`);
          await stopWatcher(dir, s.pid, kill);
        } else if (!fresh && s.runId && s.tsconfig === target.tsconfig && s.tree && s.tree === signature(root)) {
          runId = s.runId;
        } else {
          busy = s;
        }
      }
    } finally {
      release();
    }
    let started = false;
    if (!runId && busy) {
      // A run over an older tree, or one --fresh will not share: let it finish, then start one.
      note(`waiting for the ${project} bun check already running on an earlier tree to finish`);
      while (isPidAlive(busy.pid) && readWatchState(dir)?.runId === busy.runId) {
        if (Date.now() > deadline) throw elapsed();
        await sleep(200);
      }
      continue;
    }
    if (!runId) {
      const id = `${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      started = await startWhenSlotFrees(target, root, {
        start: (r, t) => start(r, t, bin!, id),
        isUp: () => readWatchState(dir)?.runId === id || readBunResult(dir, id) !== null,
        startNote: `running bun check for ${project} in ${root}`,
        bunRun: true,
        note, kill, deadline, protect: opts.protect, queueWaitMs: opts.queueWaitMs,
      });
      // Another ask started a run while this one queued: share it if it sees this tree.
      if (!started) continue;
      runId = id;
      fresh = false;
    } else {
      note(`sharing the ${project} bun check another ask started on this tree`);
    }
    return await waitForRun(target, root, runId, started, { deadline, note, elapsed });
  }
}

async function waitForRun(target: CheckProject, root: string, runId: string, started: boolean, o: { deadline: number; note: (line: string) => void; elapsed: () => CheckFailure }): Promise<CheckResult> {
  const project = target.name;
  const dir = watchDir(root, project);
  const logFrom = (() => { try { return fs.statSync(logPath(dir)).size; } catch { return 0; } })();
  let beat = 0;
  let gone: number | null = null;
  let noted = false;
  const askedAt = Date.now();
  for (;;) {
    const result = readBunResult(dir, runId);
    if (result) {
      if (result.failure !== undefined) throw new CheckFailure(`the ${project} typecheck (bun check) failed: ${result.failure} (${logPath(dir)})`, /out-of-memory killer|most likely for memory/.test(result.failure) ? "oom" : "died", { log: logPath(dir) });
      return {
        project, errors: result.errors ?? 0, diagnostics: result.diagnostics ?? "", passAgeMs: Date.now() - result.finishedAt, started, firstPass: true,
        phantom: 0, phantomExamples: [], globalTsc: false, checker: "bun", runMs: result.finishedAt - result.startedAt,
      };
    }
    const s = readWatchState(dir);
    const running = s?.runId === runId && isPidAlive(s.pid);
    if (running) {
      gone = null;
      // Keep the run wanted while this ask waits on it, so the queue never stops it to make room.
      if (Date.now() - beat >= ASK_HEARTBEAT_MS) {
        beat = Date.now();
        writeWatchState(dir, { ...s!, askedAt: beat });
      }
    } else {
      gone ??= Date.now();
      // The result lands before the state goes; a moment's grace covers reading between the two.
      if (Date.now() - gone > DEAD_GRACE_MS) {
        const last = lastLogLine(dir, logFrom);
        const why = last && !/^bun run \d+ started \(/.test(last) ? last : "it logged no reason";
        throw new CheckFailure(`the ${project} bun check stopped without a result: ${why} (${logPath(dir)})`, deathKind(last), { log: logPath(dir) });
      }
    }
    if (Date.now() > o.deadline) throw o.elapsed();
    if (!noted && Date.now() - askedAt > 5_000) {
      noted = true;
      o.note(`waiting for the ${project} bun check to finish…`);
    }
    await sleep(150);
  }
}
