/**
 * What every worktree holds that main does not, judged by content.
 *
 * Commit ancestry cannot answer it here: main's history was rewritten after
 * April 2026, so a worktree cut before or after that reads thousands of
 * commits "ahead" whether or not its work landed, and a rebase or `git apply`
 * landing gives the same change a new SHA anyway. So each worktree's own work
 * is taken as the diff from the commit it was created at (its reflog's first
 * entry) to its working tree, untracked files included, and each file in it
 * is compared with main by blob:
 *
 *   same  the file's content already equals main's
 *   only  main has not touched the file since the worktree was cut: only the
 *         worktree changed it, so it lands cleanly
 *   both  main and the worktree both changed it
 *
 * The tree's verdict follows from those and from who is still in it. Only a
 * finished tree is ever proposed for landing or pruning: one a live session
 * owns, a process sits in, or that changed within ACTIVE_MS is "live" and
 * left alone.
 *
 * All index work happens in a private copy of the worktree's index, so a scan
 * never changes what a session has staged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "../proc.js";

/** A tree touched this recently is treated as in use whatever the roster says. */
export const ACTIVE_MS = 2 * 60 * 60_000;
/** A finished tree untouched this long is stale: archived and released, never landed. */
export const STALE_MS = 7 * 24 * 60 * 60_000;
/** A roster row counts as a live owner when it is still active and was updated this recently. */
export const LIVE_OWNER_MS = 3 * 24 * 60 * 60_000;

export type FileVerdict = "same" | "only" | "both";

export type TreeVerdict =
  /** A live session or process is in it, it is locked, or it changed within ACTIVE_MS. */
  | "live"
  /** The repo's main checkout: where landing goes, never pruned. */
  | "primary"
  /** It holds no change of its own. */
  | "empty"
  /** Every file it changed already matches main. */
  | "landed"
  /** Nothing only it has, and main changed every file it touched after it went quiet. */
  | "superseded"
  /** Finished, untouched for STALE_MS, and still holding changes: archived, not landed. */
  | "stale"
  /** Finished recently with changes only it has: land them. */
  | "ready"
  /** Finished recently, and its changes collide with newer work on main. */
  | "review";

/** Verdicts whose tree `cast land prune` archives and removes. */
export const PRUNABLE: ReadonlySet<TreeVerdict> = new Set(["empty", "landed", "superseded", "stale"]);

export interface RosterRow {
  short_id?: string;
  title?: string | null;
  work_state?: string | null;
  status?: string | null;
  project_path?: string | null;
  worktree_name?: string | null;
  updated_at?: number | null;
}

export interface TreeFile {
  path: string;
  verdict: FileVerdict;
  /** A = added, D = deleted, M = modified, relative to the tree's base. */
  status: string;
}

export interface TreeReport {
  repo: string;
  path: string;
  branch: string;
  head: string;
  /** The commit the tree's own work is measured from. */
  base: string;
  primary: boolean;
  /** Why the tree is in use (a live session, a process, recent edits), or null when finished. */
  inUse: string | null;
  verdict: TreeVerdict;
  /** One line on why the verdict, for a person. */
  reason: string;
  /** Most recent of the tree's HEAD reflog, its index and every changed file, in ms. */
  lastActivity: number;
  owner: { short_id: string; title: string | null; work_state: string | null } | null;
  counts: Record<FileVerdict, number>;
  files: TreeFile[];
}

async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  });
  return String(stdout);
}

const tryGit = (cwd: string, args: string[], opts?: Parameters<typeof git>[2]) => git(cwd, args, opts).then((s) => s.trim()).catch(() => "");

export interface WorktreeEntry { path: string; branch: string; head: string; locked: boolean; primary: boolean }

/** `git worktree list --porcelain`, the main checkout first. Entries whose directory is gone are dropped. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!wt) continue;
    if (lines.some((l) => l.startsWith("prunable"))) continue;
    entries.push({
      path: wt,
      head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
      branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "",
      locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      primary: entries.length === 0,
    });
  }
  return entries;
}

/**
 * The commit a worktree was created at: the first entry of its branch's
 * reflog, else of its own HEAD reflog; for the main checkout, where it forked
 * from origin/main. Falls back to the merge base when the reflog is gone.
 */
export async function worktreeBase(entry: WorktreeEntry, mainRef: string): Promise<string> {
  if (!entry.primary) {
    for (const ref of [entry.branch, "HEAD"].filter(Boolean)) {
      const first = (await tryGit(entry.path, ["reflog", "show", "--format=%H", ref])).split("\n").filter(Boolean).pop();
      if (first && (await tryGit(entry.path, ["cat-file", "-e", `${first}^{commit}`]).then(() => true))) return first;
    }
  }
  return tryGit(entry.path, ["merge-base", "HEAD", mainRef]);
}

/**
 * `git diff --raw` lines: `:<mode> <mode> <src blob> <dst blob> <status>\t<path>`.
 * A gitlink the base did not have is a worktree nested inside this one
 * (`git add -A` records it as an embedded repo), not a change: dropped.
 */
export function parseRawDiff(out: string): Array<{ path: string; src: string; dst: string; status: string }> {
  const rows: Array<{ path: string; src: string; dst: string; status: string }> = [];
  for (const line of out.split("\n")) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/.exec(line);
    if (!m || (m[2] === "160000" && m[1] === "000000")) continue;
    rows.push({ src: m[3], dst: m[4], status: m[5], path: m[6] });
  }
  return rows;
}

const ZERO = /^0+$/;

/** Classify one changed file against main's blob for the same path (undefined = main has no such file). */
export function fileVerdict(src: string, dst: string, mainBlob: string | undefined): FileVerdict {
  const worktree = ZERO.test(dst) ? undefined : dst;
  const base = ZERO.test(src) ? undefined : src;
  if (worktree === mainBlob) return "same";
  if (mainBlob === base) return "only";
  return "both";
}

/** Every blob on a ref, path to sha: one call per repo and ref. */
export async function treeBlobs(cwd: string, ref: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const line of (await git(cwd, ["ls-tree", "-r", "--full-tree", ref])).split("\n")) {
    const m = /^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

/**
 * Write the tree's working state, untracked files included, into a private
 * index, and hand it to `fn`. The worktree's own index is copied, never written.
 */
export async function withWorkingIndex<T>(tree: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-land-"));
  try {
    const index = path.join(tmp, "index");
    const own = (await tryGit(tree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    try { fs.copyFileSync(own, index); } catch { /* a fresh index is built from scratch */ }
    const env = { GIT_INDEX_FILE: index };
    await git(tree, ["add", "-A", "."], { env });
    return await fn(env);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The tree's own changes as raw diff rows, base to working state. */
export async function treeChanges(tree: string, base: string) {
  return withWorkingIndex(tree, async (env) =>
    parseRawDiff(await git(tree, ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", base], { env })),
  );
}

/** Of `files`, those main changed after `since` (ms): one `git log` for the set. */
export async function filesChangedOnMainSince(cwd: string, mainRef: string, since: number, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const out = await tryGit(cwd, ["log", `--since=${Math.floor(since / 1000)}`, "--format=", "--name-only", mainRef, "--", ...files]);
  return new Set(out.split("\n").filter(Boolean));
}

function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

/** The roster row that owns a tree: one whose project path is the tree or inside it, or that names its codecast worktree. */
export function ownerOf(tree: string, roster: RosterRow[]): RosterRow | null {
  const name = /\/\.codecast\/worktrees\/([^/]+)$/.exec(tree)?.[1];
  return roster.find((r) =>
    (r.project_path && (r.project_path === tree || r.project_path.startsWith(`${tree}/`))) ||
    (name && r.worktree_name === name),
  ) ?? null;
}

/** Whether a roster row is still at work: active, and updated within LIVE_OWNER_MS. */
export function ownerIsLive(row: RosterRow, now: number): boolean {
  if (row.status === "completed") return false;
  if (!["working", "dormant", "needs_input", "needs-input"].includes(row.work_state ?? "")) return false;
  return now - (row.updated_at ?? 0) < LIVE_OWNER_MS;
}

export interface VerdictFacts {
  primary: boolean;
  locked: boolean;
  liveOwner: boolean;
  processInside: boolean;
  lastActivity: number;
  counts: Record<FileVerdict, number>;
  /** Every `both` file was changed on main after the tree's last activity. */
  bothAllNewerOnMain: boolean;
  now: number;
}

/** The tree's verdict and a line on why. Pure: every git and roster fact comes in. */
/** Why a tree is in use, or null when it is finished. */
export function inUseReason(f: VerdictFacts): string | null {
  const quiet = f.now - f.lastActivity;
  if (f.locked) return "locked worktree";
  if (f.liveOwner) return "its session is still at work";
  if (f.processInside) return "a running process sits in it";
  if (quiet < ACTIVE_MS) return `changed ${Math.round(quiet / 60_000)}m ago`;
  return null;
}

export function treeVerdict(f: VerdictFacts): { verdict: TreeVerdict; reason: string } {
  const quiet = f.now - f.lastActivity;
  const inUse = inUseReason(f);
  if (f.primary) return { verdict: "primary", reason: `the repo's main checkout${inUse ? `, in use: ${inUse}` : ""}` };
  if (inUse) return { verdict: "live", reason: inUse };
  const { same, only, both } = f.counts;
  if (same + only + both === 0) return { verdict: "empty", reason: "no changes of its own" };
  if (only + both === 0) return { verdict: "landed", reason: `all ${same} changed files already match main` };
  if (only === 0 && f.bothAllNewerOnMain) return { verdict: "superseded", reason: `main rewrote all ${both} files it touched after it went quiet` };
  if (quiet >= STALE_MS) return { verdict: "stale", reason: `untouched for ${Math.round(quiet / 86_400_000)}d; ${only} files only it has, ${both} that main also changed` };
  if (only > 0) return { verdict: "ready", reason: `${only} files only it has${both ? `, ${both} that main also changed` : ""}` };
  return { verdict: "review", reason: `${both} files that main also changed, and it is newer than main's changes` };
}

export interface ScanContext {
  repo: string;
  mainRef: string;
  mainBlobs: Map<string, string>;
  roster: RosterRow[] | null;
  processCwds: string[];
  now: number;
}

export async function scanTree(entry: WorktreeEntry, ctx: ScanContext): Promise<TreeReport> {
  const base = await worktreeBase(entry, ctx.mainRef);
  const rows = base ? await treeChanges(entry.path, base) : [];
  const files: TreeFile[] = rows.map((r) => ({ path: r.path, status: r.status, verdict: fileVerdict(r.src, r.dst, ctx.mainBlobs.get(r.path)) }));
  const counts: Record<FileVerdict, number> = { same: 0, only: 0, both: 0 };
  for (const f of files) counts[f.verdict]++;

  // The tree's own HEAD reflog: its last checkout or commit HERE. HEAD's commit
  // time would read a tree that never committed as old as the commit it was cut from.
  // %gd with --date=unix is the entry's own time ("HEAD@{1791215272}"); %ct would be the commit's.
  const headTime = Number(/\{(\d+)\}/.exec(await tryGit(entry.path, ["reflog", "-1", "--date=unix", "--format=%gd", "HEAD"]))?.[1]) * 1000 || 0;
  const indexTime = mtime(await tryGit(entry.path, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  const fileTime = Math.max(0, ...files.filter((f) => f.status !== "D").map((f) => mtime(path.join(entry.path, f.path))));
  const lastActivity = Math.max(headTime, indexTime, fileTime);

  const both = files.filter((f) => f.verdict === "both").map((f) => f.path);
  const newer = await filesChangedOnMainSince(entry.path, ctx.mainRef, lastActivity, both);
  const ownerRow = ctx.roster ? ownerOf(entry.path, ctx.roster) : null;
  const vf: VerdictFacts = {
    primary: entry.primary,
    locked: entry.locked,
    liveOwner: !!ownerRow && ownerIsLive(ownerRow, ctx.now),
    processInside: ctx.processCwds.some((c) => c === entry.path || c.startsWith(`${entry.path}/`)),
    lastActivity,
    counts,
    bothAllNewerOnMain: both.length > 0 && both.every((f) => newer.has(f)),
    now: ctx.now,
  };
  const { verdict, reason } = treeVerdict(vf);
  return {
    repo: ctx.repo,
    path: entry.path,
    branch: entry.branch,
    head: entry.head,
    base,
    primary: entry.primary,
    inUse: inUseReason(vf),
    verdict,
    reason,
    lastActivity,
    owner: ownerRow ? { short_id: ownerRow.short_id ?? "", title: ownerRow.title ?? null, work_state: ownerRow.work_state ?? null } : null,
    counts,
    files,
  };
}

/** Every process's working directory, from one lsof call; empty when lsof is unavailable. */
export async function processCwds(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-Fn"], { encoding: "utf-8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    return String(stdout).split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  } catch (err: any) {
    // lsof exits 1 when some processes cannot be read, with the rest on stdout.
    const out = String(err?.stdout ?? "");
    return out.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface RepoScan {
  repo: string;
  root: string;
  origin: string;
  mainRef: string;
  trees: TreeReport[];
  errors: Array<{ path: string; error: string }>;
}

/** Scan every worktree of one repo. `roster` null means the owner roster could not be read. */
export async function scanRepo(root: string, opts: { roster: RosterRow[] | null; processCwds: string[]; concurrency?: number; fetch?: boolean; now?: number }): Promise<RepoScan> {
  const origin = await tryGit(root, ["remote", "get-url", "origin"]);
  if (opts.fetch !== false && origin) await tryGit(root, ["fetch", "--quiet", "origin"], { timeoutMs: 60_000 });
  const defaultBranch = (await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) || "origin/main";
  const mainRef = origin ? defaultBranch : "HEAD";
  const repo = path.basename(root);
  const ctx: ScanContext = {
    repo,
    mainRef,
    mainBlobs: await treeBlobs(root, mainRef),
    roster: opts.roster,
    processCwds: opts.processCwds,
    now: opts.now ?? Date.now(),
  };
  const entries = parseWorktreeList(await git(root, ["worktree", "list", "--porcelain"]));
  const errors: RepoScan["errors"] = [];
  const trees = (await mapLimit(entries, opts.concurrency ?? 4, (e) =>
    scanTree(e, ctx).catch((err) => { errors.push({ path: e.path, error: String(err?.message ?? err).split("\n")[0] }); return null; }),
  )).filter((t): t is TreeReport => !!t);
  return { repo, root, origin, mainRef, trees, errors };
}
