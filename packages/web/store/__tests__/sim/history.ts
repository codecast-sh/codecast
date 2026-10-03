// The multiplayer sim's run history (docs/architecture/multiplayer-sim-harness.md,
// section 3.12, and docs/architecture/evals-ui.md, section 3.7).
//
// Every `bun run sim` that runs scenarios writes one session folder:
//
//   <home>/sessions/<stamp>/session.json   SimSession: argv, gitHead, dirty, treePatch, startedAt, finishedAt, exit
//   <home>/sessions/<stamp>/runs.jsonl     one SimRunRow per scenario run
//   <home>/sessions/<stamp>/<scenario>-<mode>-<seed>/   a failure's artifacts (a pass's only with --keep)
//   <home>/trees/<sha256>.patch.gz         the uncommitted edits the session ran on, gzipped, by the sha of the patch
//
// <home> is $CODECAST_SIM_HOME, else ~/.local/share/codecast/sim. The runner
// (scripts/sim.ts) opens and closes the session; the test process finds it
// through SIM_SESSION and appends its runs (dsl.ts).
//
// A leaf: it imports no store, so the runner's --list stays instant.

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { SimRunRow, SimSession } from "@codecast/shared/contracts/evalsApi";

export const SIM_HOME_ENV = "CODECAST_SIM_HOME";
/** The newest sessions kept whole; older ones survive only when something in them failed. */
export const KEEP_SESSIONS = 200;
/** What the sim loads: a dirty file outside these cannot change a run. */
export const SIM_SOURCES = ["packages/web", "packages/convex", "packages/shared", "platform/packages"];

type Env = Record<string, string | undefined>;

export function simHome(env: Env = process.env): string {
  return env[SIM_HOME_ENV] || join(homedir(), ".local/share/codecast/sim");
}

export const sessionsDir = (home = simHome()) => join(home, "sessions");
export const treesDir = (home = simHome()) => join(home, "trees");
export const treePatchPath = (sha: string, home = simHome()) => join(treesDir(home), `${sha}.patch.gz`);

/** A folder name that sorts by time: the UTC start to the millisecond, then the pid. */
export function sessionStamp(at: Date, pid = process.pid): string {
  return `${at.toISOString().replace(/[:.]/g, "-")}-${pid}`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n");
  renameSync(tmp, path);
}

function git(root: string, args: string[], env?: Env): { ok: boolean; code: number; out: Buffer } {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore" });
  return { ok: r.exitCode === 0, code: r.exitCode ?? -1, out: r.stdout ?? Buffer.alloc(0) };
}

// A copy of the index with every untracked source file added as intent to
// add, so `git diff HEAD` against it shows new files with their content. The
// real index is never touched. dispose() removes the copy.
function shadowIndex(root: string): { env: Env; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sim-index-"));
  const index = join(dir, "index");
  const real = git(root, ["rev-parse", "--git-path", "index"]).out.toString().trim();
  if (real) copyFileSync(real.startsWith("/") ? real : join(root, real), index);
  const env = { GIT_INDEX_FILE: index };
  git(root, ["add", "--intent-to-add", "--", ...SIM_SOURCES], env);
  return { env, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TreeState {
  gitHead: string | null;
  /** Any tracked or untracked edit under SIM_SOURCES. */
  dirty: boolean;
}

/** HEAD and whether the sources differ from it. Quick: diff stops at the first difference. */
export function treeState(root: string): TreeState {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head.ok) return { gitHead: null, dirty: false };
  const shadow = shadowIndex(root);
  try {
    return { gitHead: head.out.toString().trim(), dirty: git(root, ["diff", "--quiet", "HEAD", "--", ...SIM_SOURCES], shadow.env).code === 1 };
  } finally {
    shadow.dispose();
  }
}

/**
 * Stores the uncommitted edits under SIM_SOURCES (untracked files included)
 * as trees/<sha256>.patch.gz and returns the sha, or null on a clean tree.
 * `git apply` of the unzipped patch on gitHead rebuilds the tree the run saw.
 */
export async function storeTreePatch(root: string, home = simHome()): Promise<string | null> {
  const shadow = shadowIndex(root);
  try {
    const env = { ...process.env, ...shadow.env };
    const proc = Bun.spawn(["git", "-C", root, "diff", "HEAD", "--binary", "--", ...SIM_SOURCES], { env, stdout: "pipe", stderr: "ignore" });
    const patch = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    if ((await proc.exited) !== 0 || patch.length === 0) return null;
    const sha = createHash("sha256").update(patch).digest("hex");
    const path = treePatchPath(sha, home);
    if (!existsSync(path)) {
      mkdirSync(treesDir(home), { recursive: true });
      writeFileSync(`${path}.${process.pid}.tmp`, gzipSync(patch));
      renameSync(`${path}.${process.pid}.tmp`, path);
    }
    return sha;
  } finally {
    shadow.dispose();
  }
}

export function readSession(dir: string): SimSession | null {
  try {
    return JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SimSession;
  } catch {
    return null;
  }
}

export function readRuns(dir: string): SimRunRow[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "runs.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as SimRunRow];
    } catch {
      return [];
    }
  });
}

/** Opens a session folder and writes its session.json; finishedAt and exit stay null until closeSession. */
export function openSession(argv: string[], tree: TreeState, opts: { home?: string; at?: Date } = {}): { dir: string; session: SimSession } {
  const at = opts.at ?? new Date();
  const id = sessionStamp(at);
  const dir = join(sessionsDir(opts.home), id);
  mkdirSync(dir, { recursive: true });
  const session: SimSession = { id, argv, gitHead: tree.gitHead, dirty: tree.dirty, treePatch: null, startedAt: at.toISOString(), finishedAt: null, exit: null };
  writeJsonAtomic(join(dir, "session.json"), session);
  return { dir, session };
}

export function closeSession(dir: string, session: SimSession, exit: number, treePatch: string | null, at = new Date()): SimSession {
  const done = { ...session, treePatch, finishedAt: at.toISOString(), exit };
  writeJsonAtomic(join(dir, "session.json"), done);
  return done;
}

/** One line of runs.jsonl; appends are atomic for lines this short, so parallel test files can share it. */
export function appendRun(dir: string, row: SimRunRow): void {
  appendFileSync(join(dir, "runs.jsonl"), JSON.stringify(row) + "\n");
}

const failed = (dir: string) => {
  const session = readSession(dir);
  return (session?.exit !== null && session?.exit !== undefined && session.exit !== 0) || readRuns(dir).some((r) => !r.passed);
};

/**
 * Keeps the `keep` newest sessions, and any older one with a failed run or a
 * nonzero exit; removes the rest, then every tree patch no kept session names.
 * A session with no finishedAt is left alone for a day (it may still be
 * running); after that it was killed, and counts like any other. Returns the
 * ids removed.
 */
export function pruneSessions(home = simHome(), keep = KEEP_SESSIONS, now = Date.now()): string[] {
  const root = sessionsDir(home);
  if (!existsSync(root)) return [];
  const ids = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  const removed: string[] = [];
  for (const id of ids.slice(keep)) {
    const dir = join(root, id);
    const session = readSession(dir);
    if (session && session.finishedAt === null && now - Date.parse(session.startedAt) < 86_400_000) continue;
    if (failed(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(id);
  }
  const trees = treesDir(home);
  if (removed.length && existsSync(trees)) {
    const named = new Set(readdirSync(root).map((id) => readSession(join(root, id))?.treePatch).filter(Boolean));
    for (const file of readdirSync(trees)) {
      const sha = file.replace(/\.patch\.gz$/, "");
      if (sha !== file && !named.has(sha)) rmSync(join(trees, file), { force: true });
    }
  }
  return removed;
}

const PROVENANCE = new Map<string, { gitHead?: string | null; dirty?: boolean }>();

/** The provenance a run's result.json carries, read once per process from SIM_SESSION's session.json. */
export function sessionProvenance(env: Env = process.env): { gitHead?: string | null; dirty?: boolean } {
  const dir = env.SIM_SESSION;
  if (!dir) return {};
  const cached = PROVENANCE.get(dir);
  if (cached) return cached;
  const session = readSession(dir);
  const out = session ? { gitHead: session.gitHead, dirty: session.dirty } : {};
  PROVENANCE.set(dir, out);
  return out;
}

