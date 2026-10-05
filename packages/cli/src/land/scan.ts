/**
 * What every worktree holds that main does not, judged by content.
 *
 * Commit ancestry cannot answer it here: main's history was rewritten after
 * April 2026, so a worktree cut before or after that reads thousands of
 * commits "ahead" whether or not its work landed, and a rebase or `git apply`
 * landing gives the same change a new SHA anyway. So each worktree's own work
 * is taken as the diff from the commit it was created at (its reflog's first
 * entry) to its working tree, untracked files included, and each file in it
 * is compared with main:
 *
 *   same      the file's content already equals main's
 *   absorbed  main and the worktree both changed it, and main already holds
 *             the worktree's change: its added lines, without its removed ones
 *   only      main has not touched the file since the worktree was cut: only
 *             the worktree changed it, so it lands cleanly
 *   both      main and the worktree both changed it, and main lacks the
 *             worktree's change: landing it takes judgment
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
import { execFileAsync, spawn } from "../proc.js";

/** A tree touched this recently is treated as in use whatever the roster says. */
export const ACTIVE_MS = 2 * 60 * 60_000;
/** A finished tree untouched this long is stale: archived and released, never landed. */
export const STALE_MS = 7 * 24 * 60 * 60_000;
/** A roster row counts as a live owner when it is still active and was updated this recently. */
export const LIVE_OWNER_MS = 3 * 24 * 60 * 60_000;

export type FileVerdict = "same" | "absorbed" | "only" | "both";

export type TreeVerdict =
  /** A live session or process is in it, it is locked, or it changed within ACTIVE_MS. */
  | "live"
  /** The repo's main checkout: where landing goes, never pruned. */
  | "primary"
  /** It holds no change of its own. */
  | "empty"
  /** Main already holds every change it made. */
  | "landed"
  /** Finished, untouched for STALE_MS, and still holding changes: archived, not landed. */
  | "stale"
  /** Finished recently with changes only it has: land them. */
  | "ready"
  /** Finished recently, and its changes collide with newer work on main. */
  | "review";

/** Verdicts whose tree `cast land prune` archives and removes. */
export const PRUNABLE: ReadonlySet<TreeVerdict> = new Set(["empty", "landed", "stale"]);

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
  /** Most recent of the tree's HEAD reflog and its changed files' mtimes, in ms. */
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
 * Two kinds of row are wiring, not work, and are dropped: a gitlink the base
 * did not have (a worktree nested inside this one, which `git add -A` records
 * as an embedded repo), and a `node_modules` symlink into another checkout,
 * which `.gitignore`'s `node_modules/` does not match.
 */
export function parseRawDiff(out: string): Array<{ path: string; src: string; dst: string; status: string }> {
  const rows: Array<{ path: string; src: string; dst: string; status: string }> = [];
  for (const line of out.split("\n")) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*\t(.+)$/.exec(line);
    if (!m || (m[2] === "160000" && m[1] === "000000")) continue;
    if (m[2] === "120000" && path.basename(m[6]) === "node_modules") continue;
    rows.push({ src: m[3], dst: m[4], status: m[5], path: m[6] });
  }
  return rows;
}

const ZERO = /^0+$/;

/**
 * Classify one changed file against main's blob for the same path (undefined =
 * main has no such file). "both" may still turn out "absorbed" once the
 * contents are read (absorbedInto).
 */
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

/** Lines shorter than this (braces, blank lines) say nothing about whose change a file holds. */
const MEANINGFUL = 4;
/** Share of the tree's added and removed lines main must agree with for its change to count as absorbed. */
export const ABSORBED_SHARE = 0.9;

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l.length >= MEANINGFUL);

/**
 * Whether main already holds the change a tree made to a file: most lines the
 * tree added are in main's version, and most lines it removed are gone from it.
 * Line sets, not a diff: main may have moved or reworded the code around them.
 */
export function absorbedInto(base: string, tree: string, main: string): boolean {
  const baseSet = new Set(lines(base));
  const treeSet = new Set(lines(tree));
  const mainSet = new Set(lines(main));
  const added = [...treeSet].filter((l) => !baseSet.has(l));
  const removed = [...baseSet].filter((l) => !treeSet.has(l));
  const agrees = (hits: number, total: number) => total === 0 || hits / total >= ABSORBED_SHARE;
  if (added.length + removed.length === 0) return true;
  return agrees(added.filter((l) => mainSet.has(l)).length, added.length) &&
    agrees(removed.filter((l) => !mainSet.has(l)).length, removed.length);
}

/** Blobs larger than this are not read; their file stays "both". */
const MAX_BLOB = 2 * 1024 * 1024;

/** Read blobs by sha with one `git cat-file --batch`. Missing, binary or oversized ones are left out. */
export async function readBlobs(cwd: string, shas: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(shas.filter((s) => s && !ZERO.test(s)))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const child = spawn("git", ["-C", cwd, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout!.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => child.on("close", () => resolve()));
  child.stdin!.end(wanted.join("\n") + "\n");
  await done;
  const buf = Buffer.concat(chunks);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString();
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) { at = nl + 1; continue; } // "<sha> missing"
    const size = Number(m[3]);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    if (m[2] === "blob" && size <= MAX_BLOB && !body.subarray(0, 8000).includes(0)) out.set(m[1], body.toString("utf-8"));
    at = nl + 1 + size + 1;
  }
  return out;
}

function mtime(p: string): number {
  try { return fs.lstatSync(p).mtimeMs; } catch { return 0; }
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
  now: number;
}

/** Why a tree is in use, or null when it is finished. */
export function inUseReason(f: VerdictFacts): string | null {
  const quiet = f.now - f.lastActivity;
  if (f.locked) return "locked worktree";
  if (f.liveOwner) return "its session is still at work";
  if (f.processInside) return "a running process sits in it";
  if (quiet < ACTIVE_MS) return `changed ${Math.round(quiet / 60_000)}m ago`;
  return null;
}

/** The tree's verdict and a line on why. Pure: every git and roster fact comes in. */
export function treeVerdict(f: VerdictFacts): { verdict: TreeVerdict; reason: string } {
  const quiet = f.now - f.lastActivity;
  const inUse = inUseReason(f);
  if (f.primary) return { verdict: "primary", reason: `the repo's main checkout${inUse ? `, in use: ${inUse}` : ""}` };
  if (inUse) return { verdict: "live", reason: inUse };
  const { same, absorbed, only, both } = f.counts;
  if (same + absorbed + only + both === 0) return { verdict: "empty", reason: "no changes of its own" };
  if (only + both === 0) return { verdict: "landed", reason: `main already holds all ${same + absorbed} files it changed${absorbed ? ` (${absorbed} reworked since)` : ""}` };
  const open = `${only} files only it changed, ${both} where main lacks its change`;
  if (quiet >= STALE_MS) return { verdict: "stale", reason: `untouched for ${Math.floor(quiet / 86_400_000)}d; ${open}` };
  if (only > 0) return { verdict: "ready", reason: open };
  return { verdict: "review", reason: open };
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

  // The tree's own HEAD reflog: its last checkout or commit HERE. HEAD's commit
  // time would read a tree that never committed as old as the commit it was cut from.
  // %gd with --date=unix is the entry's own time ("HEAD@{1791215272}"); %ct would be the commit's.
  const headTime = Number(/\{(\d+)\}/.exec(await tryGit(entry.path, ["reflog", "-1", "--date=unix", "--format=%gd", "HEAD"]))?.[1]) * 1000 || 0;
  // Not the index's mtime: any `git status` (the daemon's worktree GC runs one) rewrites it.
  const fileTime = Math.max(0, ...files.filter((f) => f.status !== "D").map((f) => mtime(path.join(entry.path, f.path))));
  const lastActivity = Math.min(Date.now(), Math.max(headTime, fileTime));

  const ownerRow = ctx.roster ? ownerOf(entry.path, ctx.roster) : null;
  const vf: VerdictFacts = {
    primary: entry.primary,
    locked: entry.locked,
    liveOwner: !!ownerRow && ownerIsLive(ownerRow, ctx.now),
    processInside: ctx.processCwds.some((c) => c === entry.path || c.startsWith(`${entry.path}/`)),
    lastActivity,
    counts: { same: 0, absorbed: 0, only: 0, both: 0 },
    now: ctx.now,
  };
  // Reading contents only matters where it can change the verdict: not for a
  // tree in use, nor for one past the stale line, which is released either way.
  if (entry.primary || (!inUseReason(vf) && ctx.now - lastActivity < STALE_MS)) {
    // A file both sides changed is absorbed when main already holds the tree's change.
    const contested = rows.map((r, i) => ({ ...r, i })).filter((r) => files[r.i].verdict === "both" && !ZERO.test(r.dst) && ctx.mainBlobs.has(r.path));
    const blobs = await readBlobs(entry.path, contested.flatMap((r) => [r.src, r.dst, ctx.mainBlobs.get(r.path)!]));
    for (const r of contested) {
      const tree = blobs.get(r.dst);
      const main = blobs.get(ctx.mainBlobs.get(r.path)!);
      const base = ZERO.test(r.src) ? "" : blobs.get(r.src);
      if (tree !== undefined && main !== undefined && base !== undefined && absorbedInto(base, tree, main)) {
        files[r.i].verdict = "absorbed";
      }
    }
  }
  for (const f of files) vf.counts[f.verdict]++;
  const counts = vf.counts;
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
export async function scanRepo(root: string, opts: { roster: RosterRow[] | null; processCwds: string[]; concurrency?: number; fetch?: boolean; now?: number; only?: string[] }): Promise<RepoScan> {
  const origin = await tryGit(root, ["remote", "get-url", "origin"]);
  if (opts.fetch !== false && origin) await tryGit(root, ["fetch", "--quiet", "origin"], { timeoutMs: 60_000 });
  const defaultBranch = (await tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) || "origin/main";
  const mainRef = origin ? defaultBranch : "HEAD";
  const repo = path.basename(root);
  const now = opts.now ?? Date.now();
  const ctx: ScanContext = {
    repo,
    mainRef,
    mainBlobs: await treeBlobs(root, mainRef),
    roster: opts.roster,
    processCwds: opts.processCwds,
    now,
  };
  // `only`: the named trees and those nested above or below them, whose verdicts decide whether a named one may go.
  const related = (p: string) => !opts.only || opts.only.some((o) => p === o || p.startsWith(`${o}/`) || o.startsWith(`${p}/`));
  const entries = parseWorktreeList(await git(root, ["worktree", "list", "--porcelain"])).filter((e) => e.primary || related(e.path));
  const errors: RepoScan["errors"] = [];
  const trees = (await mapLimit(entries, opts.concurrency ?? 4, (e) =>
    scanTree(e, ctx).catch((err) => { errors.push({ path: e.path, error: String(err?.message ?? err).split("\n")[0] }); return null; }),
  )).filter((t): t is TreeReport => !!t);
  return { repo, root, origin, mainRef, trees, errors };
}
