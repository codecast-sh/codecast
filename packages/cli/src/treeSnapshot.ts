/**
 * Turn snapshots: a true file history of a checkout, one commit per turn, kept
 * in git and cheap enough to take at every turn end.
 *
 * The transcript records the edits an agent made through its Edit and Write
 * tools. It does not see an edit made by a shell command, a formatter, a test
 * that rewrites a fixture, or a person in their own editor. The working tree
 * is the only ground truth, so the daemon records the tree itself at the end
 * of every turn that could have touched files.
 *
 * Cost is the whole design. createWipSnapshot (wipSnapshot.ts) builds its
 * index from scratch with `read-tree HEAD`, so every tracked file is read and
 * hashed again: 1.8 s on this repo at rest and 170 to 198 s under a load
 * average of 250 (measured 2026-10-06). This module keeps ONE persistent index
 * per checkout under the git dir, seeded once from the real index, so a later
 * pass only lstat()s the tree and hashes the files whose stat changed: 0.18 s
 * at rest for 7,800 files, and 0.07 s when the caller names the paths that
 * changed. The real .git/index, HEAD and branch are never touched.
 *
 * Snapshots chain. Each commit has HEAD as its first parent, so every reader
 * that expects `snapshot^` to be the base commit (restoreWipSnapshot,
 * applySnapshotFastForward, `cast ws acquire --start-point`) keeps working,
 * and the previous snapshot as its second parent, so pushing the chain tip to
 * the hidden ref publishes the whole history of the checkout for free. The
 * chain restarts every CHAIN_DEPTH_CAP snapshots so an abandoned tail becomes
 * unreachable and git's own gc reclaims it.
 *
 * One snapshot describes one checkout, not one session: sessions that share a
 * working tree share its snapshots, and the server row for each session says
 * so (tree_snapshots.checkout_key).
 */

import fs from "node:fs";
import path from "node:path";
import {
  BRANCH_TRAILER,
  SNAPSHOT_IDENTITY,
  WIP_SNAPSHOT_SUBJECT,
  git,
  gitTry,
  parseSnapshotTrailer,
} from "./wipSnapshot.js";

export const CHAIN_DEPTH_CAP = 400;
/** How many changed paths a snapshot carries by name; the count is always exact. */
export const CHANGED_PATHS_CAP = 200;
const DEPTH_TRAILER = "codecast-depth";
const TAKEN_TRAILER = "codecast-taken-at";

export interface TurnSnapshot {
  /** The snapshot commit: first parent HEAD, second parent the previous snapshot when chained. */
  sha: string;
  tree: string;
  /** The checkout's HEAD at the time. */
  base: string;
  branch: string;
  /** The previous snapshot in the chain, when the tree had one and the chain did not restart. */
  prev?: string;
  /** 1 for the first snapshot of a chain. */
  depth: number;
  /** Paths that differ from the previous snapshot (or from HEAD for a chain's first), capped. */
  changedPaths: string[];
  changedCount: number;
  /** The tree differs from HEAD's. */
  dirty: boolean;
  /** True when the tree equals the previous snapshot's: `sha` is that snapshot, nothing new was written. */
  unchanged: boolean;
  takenAt: number;
  tookMs: number;
}

interface ChainHead {
  sha: string;
  tree: string;
  depth: number;
}

/** The per checkout state dir: inside the git dir, so a worktree gets its own and nothing is tracked. */
export async function snapshotStateDir(cwd: string): Promise<string | null> {
  const gitDir = await gitTry(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  return path.join(gitDir, "codecast");
}

function readHead(stateDir: string): ChainHead | null {
  try {
    const raw = fs.readFileSync(path.join(stateDir, "wip.head"), "utf8").trim().split(/\s+/);
    if (raw.length < 3) return null;
    const depth = Number(raw[2]);
    if (!/^[0-9a-f]{40}$/.test(raw[0]) || !/^[0-9a-f]{40}$/.test(raw[1]) || !Number.isFinite(depth)) return null;
    return { sha: raw[0], tree: raw[1], depth };
  } catch {
    return null;
  }
}

function writeHead(stateDir: string, head: ChainHead): void {
  const file = path.join(stateDir, "wip.head");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${head.sha} ${head.tree} ${head.depth}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read the chain head without taking a snapshot (what `cast diff --turns` starts from). */
export async function chainHead(cwd: string): Promise<ChainHead | null> {
  const dir = await snapshotStateDir(cwd);
  if (!dir) return null;
  const head = readHead(dir);
  if (!head) return null;
  // A pruned object store, a rewritten git dir: the head file must never
  // point at something git cannot show.
  if ((await gitTry(cwd, ["cat-file", "-e", `${head.sha}^{commit}`])) === null) return null;
  return head;
}

/**
 * Make sure the persistent index exists. Seeded from the real index when the
 * checkout has one: its stat cache is what makes the first pass cheap. A
 * checkout with no index yet (a bare seed) starts from HEAD's tree.
 */
async function ensureIndex(cwd: string, stateDir: string): Promise<string> {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const idx = path.join(stateDir, "wip.index");
  clearStaleLock(`${idx}.lock`);
  if (fs.existsSync(idx)) return idx;
  const gitDir = path.dirname(stateDir);
  const real = path.join(gitDir, "index");
  if (fs.existsSync(real)) {
    fs.copyFileSync(real, idx);
    // Keep the original's mtime: git re-hashes an entry whose mtime is not
    // older than the index file ("racily clean"), and a copy stamped now would
    // vouch for a same-size edit made in the same second as the real index.
    const st = fs.statSync(real);
    fs.utimesSync(idx, st.atime, st.mtime);
  } else {
    await git(cwd, ["read-tree", "HEAD"], { ...process.env, GIT_INDEX_FILE: idx });
  }
  return idx;
}

/** Longer than any pass takes: a full `add -A` measured 170 to 198 s at a load of 250. */
export const STALE_INDEX_LOCK_MS = 10 * 60_000;

/**
 * The persistent index is ours alone, so a lock on it older than any pass is
 * a git killed mid-write (an overloaded machine's restarts did it on
 * 2026-10-07), and left in place it fails every snapshot of the checkout
 * from then on.
 */
function clearStaleLock(lock: string): void {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > STALE_INDEX_LOCK_MS) fs.unlinkSync(lock);
  } catch {}
}

// One snapshot at a time per checkout: two turn ends landing together must
// not race on the index file.
const inflight = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (inflight.get(key) === run) inflight.delete(key);
  }
}

/**
 * Snapshot the working tree of `cwd` (any directory inside a checkout; the
 * checkout is what gets snapshotted). Returns null outside a repo or before
 * the first commit.
 *
 * `opts.paths`: when the caller knows which paths changed (the turn's Edit and
 * Write calls), only those are re-read; the rest of the index is trusted. Pass
 * nothing to walk the whole tree (still cheap: stat only).
 */
export async function createTurnSnapshot(
  cwd: string,
  opts: { paths?: string[]; exclude?: string[] } = {},
): Promise<TurnSnapshot | null> {
  const stateDir = await snapshotStateDir(cwd);
  if (!stateDir) return null;
  return serialized(stateDir, async () => {
    const started = Date.now();
    const head = await gitTry(cwd, ["rev-parse", "--verify", "HEAD"]);
    if (!head) return null;
    const idx = await ensureIndex(cwd, stateDir);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const excludes = (opts.exclude ?? []).map((p) => `:(exclude)${p}`);
    if (opts.paths?.length) {
      // `add -A` on a pathspec stages adds, edits and deletions of just those
      // paths, but it refuses the whole call for a path that matches nothing
      // (never on disk, never in the index) or that .gitignore excludes. The
      // tool calls that name these paths can name both (a file an agent
      // created then deleted in one turn; a .env it wrote), so filter first:
      // keep a path that is on disk or in the index, and drop the ignored.
      const named = await namedPathsToAdd(cwd, opts.paths, env);
      if (named.length) await git(cwd, ["add", "-A", "--", ...named, ...excludes], env);
    } else {
      await git(cwd, ["add", "-A", "--", ".", ...excludes], env);
    }
    const tree = await git(cwd, ["write-tree"], env);
    const branch = (await gitTry(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
    const headTree = await git(cwd, ["rev-parse", `${head}^{tree}`]);
    const dirty = tree !== headTree;

    let prev = readHead(stateDir);
    if (prev && (await gitTry(cwd, ["cat-file", "-e", `${prev.sha}^{commit}`])) === null) prev = null;
    const takenAt = Date.now();

    if (prev && prev.tree === tree) {
      return {
        sha: prev.sha, tree, base: head, branch, depth: prev.depth,
        changedPaths: [], changedCount: 0, dirty, unchanged: true, takenAt, tookMs: Date.now() - started,
      };
    }

    const chain = prev && prev.depth < CHAIN_DEPTH_CAP ? prev : null;
    const depth = chain ? chain.depth + 1 : 1;
    const message = [
      WIP_SNAPSHOT_SUBJECT,
      ``,
      `${BRANCH_TRAILER}: ${branch}`,
      `${DEPTH_TRAILER}: ${depth}`,
      `${TAKEN_TRAILER}: ${new Date(takenAt).toISOString()}`,
    ].join("\n");
    const parents = ["-p", head, ...(chain ? ["-p", chain.sha] : [])];
    const sha = await git(cwd, ["commit-tree", tree, ...parents, "-m", message], {
      ...process.env,
      ...SNAPSHOT_IDENTITY,
      GIT_AUTHOR_DATE: new Date(takenAt).toISOString(),
      GIT_COMMITTER_DATE: new Date(takenAt).toISOString(),
    });

    const against = chain ? chain.tree : headTree;
    const names = (await gitTry(cwd, ["diff-tree", "-r", "--name-only", against, tree])) ?? "";
    const changed = names ? names.split("\n").filter(Boolean) : [];

    writeHead(stateDir, { sha, tree, depth });
    return {
      sha, tree, base: head, branch, prev: chain?.sha, depth,
      changedPaths: changed.slice(0, CHANGED_PATHS_CAP), changedCount: changed.length,
      dirty, unchanged: false, takenAt, tookMs: Date.now() - started,
    };
  });
}

async function namedPathsToAdd(cwd: string, paths: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const rel = paths
    .map((p) => (path.isAbsolute(p) ? path.relative(cwd, p) : p))
    .filter((p) => p && !p.startsWith("..") && !path.isAbsolute(p));
  if (!rel.length) return [];
  const inIndex = new Set(((await gitTry(cwd, ["ls-files", "-z", "--", ...rel], env)) ?? "").split("\0").filter(Boolean));
  const present = rel.filter((p) => inIndex.has(p) || fs.existsSync(path.join(cwd, p)));
  if (!present.length) return [];
  // check-ignore reports untracked paths an ignore rule matches; tracked ones
  // are never reported, which is the rule add itself applies.
  const ignored = new Set(((await gitTry(cwd, ["check-ignore", "-z", "--stdin"], env, present.join("\0"))) ?? "").split("\0").filter(Boolean));
  return present.filter((p) => !ignored.has(p));
}

/** The chain of snapshots behind `sha`, newest first, read from the commits themselves. */
export async function listChain(cwd: string, sha: string, limit = 500): Promise<Array<{ sha: string; tree: string; base: string; prev?: string; depth: number; takenAt?: number; branch?: string }>> {
  const out: Array<{ sha: string; tree: string; base: string; prev?: string; depth: number; takenAt?: number; branch?: string }> = [];
  let cur: string | null = sha;
  while (cur && out.length < limit) {
    const raw = await gitTry(cwd, ["show", "-s", "--format=%T%n%P%n%B", cur]);
    if (!raw) break;
    const [tree, parentsLine, ...body] = raw.split("\n");
    const parents = (parentsLine ?? "").split(" ").filter(Boolean);
    const message = body.join("\n");
    if (!message.startsWith(WIP_SNAPSHOT_SUBJECT)) break;
    const taken = parseSnapshotTrailer(message, TAKEN_TRAILER);
    out.push({
      sha: cur, tree, base: parents[0], prev: parents[1], depth: Number(parseSnapshotTrailer(message, DEPTH_TRAILER) ?? 0),
      takenAt: taken ? Date.parse(taken) : undefined, branch: parseSnapshotTrailer(message, BRANCH_TRAILER),
    });
    cur = parents[1] ?? null;
  }
  return out;
}

/** A unified diff between two snapshots' trees (or a snapshot and its base). */
export async function diffSnapshots(cwd: string, from: string, to: string, opts: { stat?: boolean } = {}): Promise<string | null> {
  return gitTry(cwd, ["diff", ...(opts.stat ? ["--stat"] : []), `${from}^{tree}`, `${to}^{tree}`]);
}
