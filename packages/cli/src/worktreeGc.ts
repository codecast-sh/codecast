/**
 * Worktree garbage collection: release a codecast worktree when its session
 * is gone, but never one that still holds work.
 *
 * Nothing removed worktrees before this; killed and dismissed sessions left
 * `.codecast/worktrees/<name>` (and its node_modules) behind forever, and
 * port indices drifted upward with them. The same code runs on a laptop and
 * on the cloud host, where accumulated worktrees are also disk cost.
 *
 * The rule: a worktree is released only when its tree is clean AND its
 * branch holds no content that is not already on origin's default branch.
 * Dirty or unpushed work is kept and logged; a person (or `cast ws destroy`)
 * decides about that. A worktree SEEDED from a laptop checkout (workspace
 * state carries startPoint/seedBase) is always dirty and always ahead of
 * origin/main by construction, so for it the question is different: has the
 * host made anything since the seed? HEAD still at the seed base and a tree
 * still equal to the seed snapshot means the laptop still holds all of it,
 * and the worktree is released (the workspace release drops the seed ref and
 * the branch). `releaseWorkspace` does the removal (teardown hooks,
 * Chrome, `git worktree remove`, state file) when the workspace module
 * tracks the worktree; any other worktree is renamed into a trash sibling
 * (releaseTree), so a removal never leaves a half-deleted checkout.
 *
 * "Not already on origin" is a question about content, not about commits.
 * Counting commits ahead of the base reads a squash merged branch as ahead
 * forever, so its worktree was never released. We merge the branch into the
 * base with `merge-tree --write-tree` instead and compare the resulting tree
 * to the base tree: an identical tree proves the branch adds nothing, however
 * its commits were rewritten. The commit count stays as the fallback for a
 * host whose git predates that flag (2.38). A subagent worktree whose working
 * tree is exactly what it last merged into its parent's checkout
 * (mergeBack.ts) is released too: the parent holds all of it.
 *
 * A line run's worktree (a run tree: its name is a run dir, runDirs.ts) is
 * judged by use instead: it goes once no live run and no live session works
 * in it, whatever it holds. Its branch stays, with every commit the run made;
 * what it left uncommitted is a finished run's scratch. Under the content rule
 * a failed, dissolved or unmerged run kept its worktree forever, a full
 * checkout with its installs each: two of Union's line hosts filled their
 * disks with 202 and 222 of them, and every run placed there failed at Start
 * (2026-10-24).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  createGitCapabilityStore,
  isUnsupportedMergeTreeWriteTreeError,
  type GitCapabilityStore,
} from "./gitCapability.js";
import { execFileAsync, spawn } from "./proc.js";
import { locateWorktree } from "./worktreeEnv.js";
import { moveToTrash } from "./workspace/trash.js";
import { treeGitDir } from "./land/hold.js";
import { runSide, type SnapshotResult } from "./cloud/syncSide.js";
import { MERGED_REF_PREFIX, worktreeMatchesMergedBack } from "./mergeBack.js";
import { lineRunsRoot, runTreeNames, runTreesOf } from "./workflow/runDirs.js";
import { readFrozenChange } from "./workflow/flowChangeFile.js";

/** The run trees of a checkout that a live run still works in, or null when that cannot be told. */
export type RunTreesInUse = (repoRoot: string) => Promise<ReadonlySet<string> | null>;

/**
 * Run trees in use, from the ids of the runs live on this machine (null: cannot
 * tell). The ids are read once and each checkout's trees once, however many
 * worktrees a sweep asks about.
 */
export function runTreesInUseVia(liveRunIds: () => Promise<ReadonlySet<string> | null>): RunTreesInUse {
  let ids: Promise<ReadonlySet<string> | null> | null = null;
  const byRepo = new Map<string, Set<string> | null>();
  return async (repoRoot) => {
    ids ??= liveRunIds().catch(() => null);
    const live = await ids;
    if (!live) return null;
    if (!byRepo.has(repoRoot)) byRepo.set(repoRoot, runTreesOf(repoRoot, live));
    return byRepo.get(repoRoot)!;
  };
}

export type GcVerdict =
  | { action: "released"; name: string; path: string }
  | { action: "kept"; name: string; path: string; reason: string }
  | { action: "skipped"; reason: string };

// Why: every git call here runs on the daemon's single loop (the kill path and
// the idle terminal reaper both release worktrees), so none of them may be a
// synchronous spawn — a sync `git fetch` alone stalls the HTTP server, the
// Convex subscriptions and tmux injection for its whole duration (ct-49542).
async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: timeoutMs,
    // A credential prompt on a fetch would sit on an open stdin until the
    // timeout; a GC has no one to answer it.
    // GIT_OPTIONAL_LOCKS=0: judging a checkout never writes to it; a `git status`
    // would otherwise refresh the index of a tree a session may still be using.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

export type WorktreeProbe = {
  dirty: boolean;
  /** Commits on the branch that origin's default branch does not have, or null when git could not tell. */
  aheadOfOrigin: number | null;
  /** True when merging the branch into the base changes the base tree not at all. */
  contentInBase: boolean;
  /**
   * Seeded worktrees only: the host changed something since the laptop seed
   * (a commit past the seed base, or a tree that differs from the snapshot).
   * null = not seeded, or the seed ref is gone / git failed (today's rules apply).
   */
  hostOnlyWork?: boolean | null;
};

/** Why a worktree must be kept, or null when it may go. Pure over git output. */
export function keepReason(probe: WorktreeProbe): string | null {
  if (probe.hostOnlyWork === false) return null;
  if (probe.hostOnlyWork === true) return "changes since the laptop seed";
  if (probe.dirty) return "uncommitted changes";
  // Why: a squash or rebase merge rewrites the commits, so the branch still
  // counts as ahead while its content is already on the base (ct-49542).
  if (probe.contentInBase) return null;
  if (probe.aheadOfOrigin === null) return "cannot tell whether its commits are on origin";
  if (probe.aheadOfOrigin > 0) return `${probe.aheadOfOrigin} commit(s) not on origin`;
  return null;
}

/** The default branch origin points at, or main. */
async function originDefault(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

/** One fetch per repository per this long, however many worktrees it releases. */
const FETCH_INTERVAL_MS = 5 * 60_000;
const fetchesByRepo = new Map<string, { at: number; run: Promise<void> }>();

/**
 * Refresh origin before judging the branch: the merge usually just happened.
 * A failure is not fatal — the probe then answers from the origin refs already
 * on disk, so an offline host still releases what it can prove is merged.
 */
async function fetchPrune(cwd: string, repoKey: string): Promise<void> {
  const now = Date.now();
  const prior = fetchesByRepo.get(repoKey);
  // Why: reaping a dozen idle sessions releases a dozen worktrees of one repo
  // within a second; without this they would each fetch the same remote.
  if (prior && now - prior.at < FETCH_INTERVAL_MS) return prior.run;
  const run = (async () => {
    try {
      if (!(await git(cwd, ["remote"])).split("\n").includes("origin")) return;
      await git(cwd, ["fetch", "--prune", "--quiet", "origin"], 10_000);
    } catch {
      /* offline or no remote: decide from the refs we already have */
    }
  })();
  fetchesByRepo.set(repoKey, { at: now, run });
  return run;
}

/**
 * True when merging `HEAD` into `baseOid` produces the base tree unchanged —
 * the branch's content is already there, squash merge included.
 */
async function contentAlreadyInBase(
  worktreePath: string,
  baseOid: string,
  caps: GitCapabilityStore,
): Promise<boolean> {
  let baseTree: string;
  try {
    baseTree = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${baseOid}^{tree}`]);
  } catch {
    return false;
  }
  try {
    return await caps.runWithFallback(
      "merge-tree-write-tree",
      async () => {
        const out = await git(worktreePath, ["merge-tree", "--write-tree", baseOid, "HEAD"]);
        const merged = out.split("\n")[0]?.trim();
        return Boolean(merged) && merged === baseTree;
      },
      () => false,
      isUnsupportedMergeTreeWriteTreeError,
    );
  } catch {
    // A conflicting merge exits non-zero: real content, not yet on the base.
    return false;
  }
}

/**
 * `startPoint`/`seedBase` (a seeded workspace's state) switch the verdict to
 * the host-only-work question; the other options belong to the fetch and
 * the merge-tree probe.
 */
export async function probeWorktree(
  worktreePath: string,
  opts: { capabilities?: GitCapabilityStore; repoKey?: string; startPoint?: string; seedBase?: string; fetch?: boolean } | null = {},
): Promise<WorktreeProbe> {
  opts ??= {};
  const dirty = (await git(worktreePath, ["status", "--porcelain"])).length > 0;
  if (opts.fetch !== false) await fetchPrune(worktreePath, opts.repoKey ?? worktreePath);
  let aheadOfOrigin: number | null = null;
  let contentInBase = false;
  try {
    const base = `origin/${await originDefault(worktreePath)}`;
    const baseOid = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    aheadOfOrigin = parseInt(await git(worktreePath, ["rev-list", "--count", `${baseOid}..HEAD`]), 10);
    if (Number.isNaN(aheadOfOrigin)) aheadOfOrigin = null;
    contentInBase =
      aheadOfOrigin === 0 ||
      (await contentAlreadyInBase(worktreePath, baseOid, opts.capabilities ?? createGitCapabilityStore()));
  } catch {
    aheadOfOrigin = null;
  }
  if (!opts.startPoint || !opts.seedBase) return { dirty, aheadOfOrigin, contentInBase };
  return { dirty, aheadOfOrigin, contentInBase, hostOnlyWork: await hostOnlyWorkSince(worktreePath, opts.startPoint, opts.seedBase) };
}

/**
 * Has the host made anything since the seed? A commit past the seed base is
 * work; otherwise the worktree's tree is written the same way the laptop's
 * snapshot was (temp index, same exclusions) and compared with the seed ref's.
 * null when the ref is gone or git fails: the caller falls through to the
 * dirty/ahead rules, which keep the worktree.
 */
async function hostOnlyWorkSince(worktreePath: string, startPoint: string, seedBase: string): Promise<boolean | null> {
  try {
    if ((await git(worktreePath, ["rev-parse", "HEAD"])) !== seedBase) return true;
    const seedTree = await git(worktreePath, ["rev-parse", `${startPoint}^{tree}`]);
    // Read the way the seed was taken (cloud/syncSide.ts), gitignored files included.
    return (await runSide<SnapshotResult>({ op: "snapshot", cwd: worktreePath })).tree !== seedTree;
  } catch {
    return null;
  }
}

/**
 * Release the worktree a session ran in, if it is a codecast worktree and
 * holds no work. `cwd` may be any path inside the worktree.
 */
export async function releaseSessionWorktree(
  cwd: string | undefined,
  log: (m: string) => void = () => {},
  isShared?: (worktreePath: string) => Promise<boolean>,
  runTreesInUse?: RunTreesInUse,
): Promise<GcVerdict> {
  if (!cwd) return { action: "skipped", reason: "no cwd" };
  const wt = locateWorktree(cwd);
  if (!wt) return { action: "skipped", reason: "not a codecast worktree" };
  const worktreePath = path.join(wt.repoRoot, ".codecast", "worktrees", wt.name);
  if (!fs.existsSync(worktreePath)) return { action: "skipped", reason: "already gone" };
  if (isShared) {
    try {
      if (await isShared(worktreePath)) {
        return { action: "kept", name: wt.name, path: worktreePath, reason: "another session uses this worktree" };
      }
    } catch {
      return { action: "kept", name: wt.name, path: worktreePath, reason: "cannot verify exclusive session ownership" };
    }
  }
  const runTree = !!runTreesInUse && runTreeNames(wt.repoRoot).has(wt.name);
  if (runTree) {
    const inUse = await runTreesInUse(wt.repoRoot).catch(() => null);
    const reason = !inUse ? "cannot tell whether a live run works in it" : inUse.has(wt.name) ? "a live run works in it" : null;
    if (reason) {
      log(`[WORKTREE-GC] kept ${wt.name}: ${reason}`);
      return { action: "kept", name: wt.name, path: worktreePath, reason };
    }
    // What the run left uncommitted goes onto its branch first; a tree off its branch keeps today's content rule.
    const off = await commitRunLeftovers(worktreePath, wt.name, "Left uncommitted in the run's worktree when the host swept it", path.join(lineRunsRoot(wt.repoRoot), wt.name)).catch((err) => `could not commit its leftovers: ${(err as Error).message.split("\n")[0]}`);
    const kept = off ? await contentKeepReason(worktreePath, wt.repoRoot) : null;
    if (kept) {
      log(`[WORKTREE-GC] kept ${wt.name}: ${kept} (${off})`);
      return { action: "kept", name: wt.name, path: worktreePath, reason: kept };
    }
    return removeWorktree(wt.repoRoot, wt.name, worktreePath, log, { keepBranch: true });
  }
  const reason = await contentKeepReason(worktreePath, wt.repoRoot);
  if (reason) {
    log(`[WORKTREE-GC] kept ${wt.name}: ${reason}`);
    return { action: "kept", name: wt.name, path: worktreePath, reason };
  }
  return removeWorktree(wt.repoRoot, wt.name, worktreePath, log, { keepBranch: false });
}

/**
 * Why a worktree's content must keep it, or null when main (or, for a
 * worker, its parent's checkout) already holds all of it: the content rule
 * every release goes through, from a session's kill, a run's end or the
 * daemon's sweep (land/sweep.ts). `repoRoot` keys the fetch, so releasing
 * ten worktrees of one repo fetches once.
 */
export async function contentKeepReason(worktreePath: string, repoRoot: string, opts: { fetch?: boolean } = {}): Promise<string | null> {
  let probe: WorktreeProbe;
  try {
    // A seeded workspace's state carries the seed the verdict is judged against.
    const ws = await import("./workspace/index.js");
    const wt = locateWorktree(worktreePath);
    const state = wt ? ws.readState(wt.repoRoot, wt.name) : null;
    probe = await probeWorktree(worktreePath, { repoKey: repoRoot, startPoint: state?.startPoint, seedBase: state?.seedBase, fetch: opts.fetch });
  } catch (err) {
    return `git probe failed: ${(err as Error).message.split("\n")[0]}`;
  }
  // A worker whose every change is already in its parent's checkout
  // (mergeBack.ts) holds nothing the parent lacks, pushed or not.
  return (await worktreeMatchesMergedBack(worktreePath).catch(() => false)) ? null : keepReason(probe);
}

/**
 * Commit whatever a run's tree `name` holds uncommitted onto the run's own
 * branch, `codecast/<name>`, so the tree can go with nothing lost: the branch
 * stays, and a resume or `cast ws acquire <name>` checks it out again
 * (workflow/runWorktree.ts restoreRunWorktree). Null once that branch holds
 * everything the tree does; else why it cannot: the tree is on another branch
 * or none (a rebase), a merge stands half done, or the branch is a change
 * frozen for the run (`runDir`'s change.json, flows.md FL4), whose tip is the
 * snapshot the run checked and ships. Never commits anywhere but the run's
 * own branch.
 */
export async function commitRunLeftovers(tree: string, name: string, message: string, runDir?: string): Promise<string | null> {
  if (readFrozenChange(runDir)) return "its branch is the change frozen for the run";
  const own = `codecast/${name}`;
  const head = await git(tree, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  if (head !== own) return head ? `on ${head}, not its run's branch ${own}` : `not on its run's branch ${own}`;
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if (await git(tree, ["rev-parse", "-q", "--verify", ref]).then(() => true, () => false)) return `${ref} stands: an operation is half done`;
  }
  if (!(await git(tree, ["status", "--porcelain"]))) return null;
  await git(tree, ["add", "-A"]);
  await git(tree, ["commit", "-q", "--no-verify", "-m", message]);
  return null;
}

/**
 * Take a worktree's checkout away, its branch left alone: the workspace
 * release when the workspace module tracks it, else a rename into a trash
 * sibling and `git worktree prune`. A rename is one directory entry, so the
 * checkout goes whole or not at all; `git worktree remove --force` unlinks
 * file by file and, failing halfway, left a checkout another session was
 * using with 116 tracked files gone (ct-52977). The bytes are deleted in the
 * background.
 */
export async function releaseTree(repoRoot: string, worktreePath: string): Promise<void> {
  // `git worktree prune` never drops a locked entry: a tree trashed while locked stays listed,
  // and its branch stays checked out by a ghost no `git worktree add` can get past. Claude Code
  // locks its agent worktrees with the agent's pid.
  const gitDir = treeGitDir(worktreePath);
  const lock = gitDir ? (() => { try { return fs.readFileSync(path.join(gitDir, "locked"), "utf-8").trim(); } catch { return null; } })() : null;
  if (lock !== null) {
    if (lockHolds(lock)) throw new Error(`locked${lock ? `: ${lock}` : ""}`);
    await git(repoRoot, ["worktree", "unlock", worktreePath]);
  }
  const ws = await import("./workspace/index.js");
  const wt = locateWorktree(worktreePath);
  const state = wt ? ws.readState(wt.repoRoot, wt.name) : null;
  if (wt && state && path.resolve(state.path) === path.resolve(worktreePath)) {
    await ws.releaseWorkspace(wt.repoRoot, wt.name);
    return;
  }
  const trash = moveToTrash(worktreePath);
  await git(repoRoot, ["worktree", "prune"]);
  deleteInBackground(trash);
}

/** A worktree lock holds while the pid it names is alive; a lock that names none was a person's, and holds. */
export function lockHolds(reason: string | undefined, isAlive: (pid: number) => boolean = pidAlive): boolean {
  const pid = /\bpid[\s:=]*(\d+)/i.exec(reason ?? "")?.[1];
  return pid ? isAlive(Number(pid)) : true;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Unlink a trashed tree off this process's loop; the workspace trash sweep catches what this misses. */
export function deleteInBackground(dir: string): void {
  try {
    spawn("rm", ["-rf", dir], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* swept later */
  }
}

/** Remove a session's worktree (releaseTree), then its branch unless asked to keep it. */
async function removeWorktree(repoRoot: string, name: string, worktreePath: string, log: (m: string) => void, opts: { keepBranch: boolean }): Promise<GcVerdict> {
  try {
    const tracked = !!(await import("./workspace/index.js")).readState(repoRoot, name);
    await releaseTree(repoRoot, worktreePath);
    if (!tracked && !opts.keepBranch) try { await git(repoRoot, ["branch", "-D", `codecast/${name}`]); } catch { /* branch may be named otherwise */ }
    try { await git(repoRoot, ["update-ref", "-d", `${MERGED_REF_PREFIX}${name}`]); } catch { /* never merged back */ }
    log(`[WORKTREE-GC] released ${name} (${worktreePath})`);
    return { action: "released", name, path: worktreePath };
  } catch (err) {
    const reason = `remove failed: ${(err as Error).message.split("\n")[0]}`;
    log(`[WORKTREE-GC] kept ${name}: ${reason}`);
    return { action: "kept", name, path: worktreePath, reason };
  }
}

/**
 * The worktrees a session made that its own cwd never shows, released when it
 * ends. A session started in the main checkout that runs `cast ws acquire`
 * and works there through its shell keeps its pane in the main checkout, so
 * releaseSessionWorktree never saw the workspace; the workspace's state
 * records the session instead (recordWorkspaceSession). A Claude Code
 * subagent with worktree isolation leaves `.claude/worktrees/agent-<id>`,
 * which Claude Code removes only when the agent changed nothing; the
 * session's transcript directory names each one
 * (`<session>/subagents/agent-<id>.jsonl`). Each goes under the content rule,
 * when no process sits in it and no other session acquired it. Its branch stays.
 *
 * The tree `cwd` sits in is the session's own and is left to
 * releaseSessionWorktree, which also asks the roster and the live runs. Call
 * this one first: once the own tree is released, `cwd` is gone and the
 * repository can no longer be found from it.
 */
export async function releaseSessionMadeWorktrees(
  sessionId: string,
  cwd: string,
  log: (m: string) => void = () => {},
  deps: { claudeProjects?: string; processCwds?: () => Promise<string[] | null> } = {},
): Promise<GcVerdict[]> {
  let repoRoot: string;
  try {
    repoRoot = path.dirname(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    return [];
  }
  const { listStates } = await import("./workspace/contract.js");
  const kept: GcVerdict[] = [];
  const candidates = new Set<string>();
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const own = real(cwd);
  const holdsCwd = (tree: string) => { const t = real(tree); return own === t || own.startsWith(`${t}/`); };
  for (const s of listStates(repoRoot)) {
    if (!s.sessions?.includes(sessionId) || path.resolve(s.path) === path.resolve(repoRoot) || !fs.existsSync(s.path) || holdsCwd(s.path)) continue;
    if (s.sessions.some((other) => other !== sessionId)) kept.push({ action: "kept", name: s.name, path: s.path, reason: "another session acquired it too" });
    else candidates.add(s.path);
  }
  const agents = subagentIds(deps.claudeProjects ?? path.join(process.env.HOME || "", ".claude", "projects"), sessionId);
  if (agents.size > 0) {
    const { parseWorktreeList } = await import("./land/scan.js");
    for (const e of parseWorktreeList(await git(repoRoot, ["worktree", "list", "--porcelain"]))) {
      const id = /\/\.claude\/worktrees\/agent-([0-9a-z]+)$/.exec(e.path)?.[1];
      if (id && agents.has(id)) candidates.add(e.path);
    }
  }
  if (candidates.size === 0) return kept;
  const cwds = await (deps.processCwds ?? (async () => (await import("./land/scan.js")).readProcessCwds()))();
  const out: GcVerdict[] = [...kept];
  for (const tree of candidates) {
    const name = path.basename(tree);
    const reason = !cwds
      ? "could not read which processes sit in it"
      : cwds.some((c) => c === tree || c.startsWith(`${tree}/`)) ? "a running process sits in it" : await contentKeepReason(tree, repoRoot);
    if (reason) {
      out.push({ action: "kept", name, path: tree, reason });
      continue;
    }
    try {
      await releaseTree(repoRoot, tree);
      out.push({ action: "released", name, path: tree });
    } catch (err) {
      out.push({ action: "kept", name, path: tree, reason: `remove failed: ${(err as Error).message.split("\n")[0]}` });
    }
  }
  for (const v of out) if (v.action !== "skipped") log(`[WORKTREE-GC] ${v.action} ${v.name}${v.action === "kept" ? `: ${v.reason}` : ` (${v.path})`}`);
  return out;
}

/** The ids of the subagents a Claude Code session ran, from `<projects>/<any>/<session>/subagents/agent-<id>.jsonl`. */
function subagentIds(projects: string, sessionId: string): Set<string> {
  const ids = new Set<string>();
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projects); } catch { return ids; }
  for (const d of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(projects, d, sessionId, "subagents")); } catch { continue; }
    for (const f of files) {
      const m = /^agent-([0-9a-z]+)\.jsonl$/.exec(f);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}
