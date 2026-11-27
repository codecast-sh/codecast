/**
 * A change run takes its branch only when no other run is on it (ct-98893).
 * `cast flow run` names a change's branch and worktree after the task
 * (runner.ts runSlug), and a branch can be checked out by another run's
 * worktree: one started with `--branch` on it. On Nov 21 a session bound to
 * ct-98846 froze other edits onto codecast/change-ct-98846 while the live run
 * of ct-98880 had that branch checked out, replacing the commit it was
 * reviewing, and only then failed "already used by worktree". So every check
 * runs before anything moves, and the run is refused when:
 * - a run of the same task is live: it reads the branch again itself when its
 *   subject ends its turn, and a second freeze would move the branch and reset
 *   its tree under it;
 * - another worktree holding the branch is not a run's (a person's, an
 *   agent's) and not the caller's own, or is a live run's, or one too young to
 *   tell (its run may still be being created), or one whose liveness or
 *   processes cannot be read: no process or session signal proves nobody
 *   commits there next;
 * - any process works in that worktree: each is named by pid and command, and
 *   none is stopped, since a detached dev server looks like a run's leftover;
 * - that worktree holds uncommitted files: a process list is no proof nobody
 *   edits it, an ended run's leftovers are not this change's to push, and the
 *   caller's own may be meant for the branch;
 * - a freeze, which replaces the branch's commits, would replace commits no
 *   freeze of this run made that the checkout lacks.
 * Only then is a clean worktree an ended run left holding the branch released
 * (lineTrialBranch.ts freeBranch), so a rerun after a failed run needs no hand
 * cleanup, and the caller's own clean worktree (not the main checkout) is
 * detached at the same commit, its files untouched, and the caller told: an
 * agent shipping its own branch no longer `git switch --detach`es first
 * (ct-102064).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { readFrozenChange, readPlacedChange } from "./flowChangeFile.js";
import { readRebaseChain } from "./rebaseRecord.js";
import { lineRunsRoot, runTreeNames, runTreesOf } from "./runDirs.js";
import { liveRunIdsOf, type LiveRunsOnDevice } from "./liveRuns.js";
import type { RunHands } from "../lineTrialBranch.js";

/** What the server and this machine say about live runs. Either read may throw when it cannot be told. */
export type RunLiveness = {
  /** The worktree names live runs on this machine work in, each with its run's status; null when that cannot be told. */
  trees(): Promise<ReadonlyMap<string, string> | null>;
  /** The status of `task`'s newest run while it is pending, running or paused, else null. */
  taskRun(task: string): Promise<string | null>;
};

/** A worktree made this recently may belong to a run the server does not list yet (pending, or not yet created). */
export const YOUNG_TREE_MS = 3 * 60_000;

const git = (cwd: string, args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
};
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The live trees of `repo` from the server's live runs on this machine, each with its run's status. */
export function liveTreeStates(repo: string, data: LiveRunsOnDevice | null | undefined): Map<string, string> | null {
  const ids = liveRunIdsOf(data);
  if (!ids) return null;
  const states = new Map<string, string>();
  for (const id of ids) {
    const status = data?.runs?.find((r) => String(r.run_id) === id)?.status ?? "running";
    for (const tree of runTreesOf(repo, [id])) states.set(tree, status);
  }
  return states;
}

/**
 * Make `branch` free for the run whose worktree is `slug` (null for a task not made yet, which has no tree), or throw
 * why it is not, having moved nothing. `rewrites`: the run freezes its change onto the branch (a session's or the
 * checkout's edits) rather than running the branch as it stands. `cwd`: where the caller works (process.cwd()), whose
 * own worktree alone it may detach. Returns a line saying what it released or detached, or null.
 */
export async function claimRunBranch(repo: string, slug: string | null, branch: string, opts: { task?: string; rewrites: boolean; live: RunLiveness; hands?: RunHands; now?: number; cwd?: string; processes?: Reader }): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const worktrees = real(path.join(repo, ".codecast", "worktrees"));
  const ownTree = slug ? path.join(worktrees, slug) : null;
  if (opts.task) {
    const state = await opts.live.taskRun(opts.task).catch((err: Error) => {
      throw new Error(`Whether a run of ${opts.task} is still live cannot be told (${err.message.split("\n")[0]}): run this again once the server answers`);
    });
    // A tree made moments ago that no run has started from yet is a run on its way to the server.
    const starting = !state && ownTree && young(ownTree, now) && !ranSince(path.join(lineRunsRoot(repo), slug!), madeAt(ownTree)) ? "starting" : null;
    if (state || starting) throw new Error(`A run of ${opts.task} is live (${state ?? starting}); it reads the branch again when you end your turn — don't start it again`);
  }
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) === null) return null;
  // A worktree whose directory is gone still holds its branch until pruned; that one is nobody's.
  git(repo, ["worktree", "prune"]);
  const { worktreeOf } = await import("../lineTrialBranch.js");
  const holder = worktreeOf(repo, branch);
  let release: string | null = null;
  let detach: string | null = null;
  if (holder && real(holder) !== ownTree) {
    const name = path.dirname(real(holder)) === worktrees ? path.basename(holder) : null;
    if (!name || !runTreeNames(repo).has(name)) {
      refuseUnlessCallersOwn(repo, holder, branch, opts.cwd ?? process.cwd());
      detach = holder;
    } else {
      const trees = await opts.live.trees().catch(() => null);
      if (!trees) throw new Error(`${branch} is checked out by worktree ${name}, and whether the run there is still live cannot be told (the server did not answer): run this again, or release it with cast ws destroy ${name}`);
      const state = trees.get(name) ?? (young(holder, now) ? "just made" : null);
      if (state) throw new Error(`${branch} is checked out by worktree ${name}, where a run is live (${state}): wait for that run to end, or stop it, then run this change again`);
      await refuseTreeProcesses(repo, name, real(holder), branch, opts.processes ?? treeProcesses);
      const shown = uncommitted(holder);
      if (shown) {
        throw new Error(`${branch} is checked out by worktree ${name}, which an ended run left with uncommitted files (${shown}): commit what belongs on ${branch} there and remove the rest, or release it with cast ws destroy ${name}, then run this again`);
      }
      release = name;
    }
  }
  if (opts.rewrites) {
    const tip = git(repo, ["rev-parse", `refs/heads/${branch}`])!;
    if (!(slug && frozenTips(repo, slug).has(tip)) && !inCheckout(repo, tip)) {
      throw new Error(`${branch} holds commits no run of ${opts.task ?? "this change"} froze (its tip ${tip.slice(0, 10)}), and freezing this change onto it would replace them: run that branch itself (cast flow run --branch ${branch}), or move it aside (git branch -m ${branch} <new name>) and run this again`);
    }
  }
  if (detach) {
    if (git(detach, ["switch", "-q", "--detach"]) === null) throw new Error(`${branch} is checked out in ${detach}, and switching that worktree off it failed: run git switch --detach there, then run this again`);
    return `Detached your worktree ${detach} from ${branch} at the same commit (it had nothing uncommitted) so the run can check the branch out: a commit made there now is on no branch, so push one with git push origin HEAD:refs/heads/${branch}`;
  }
  if (!release) return null;
  // Clean, so nothing is committed on the way: freeBranch only takes the tree away, its branch left as it was.
  const { freeBranch } = await import("../lineTrialBranch.js");
  await freeBranch(repo, release, branch, `the run in ${release}`, opts.hands);
  return `Released worktree ${release}, which an ended run left holding ${branch}`;
}

/** A process whose working directory is in a tree, and when it started (ms; 0 when that cannot be read). */
export type TreeProcess = { pid: number; command: string; startedAt: number };

/**
 * Refuse while any process works in an ended run's worktree `tree` (named `name`), naming each by pid and command and
 * whether it started before or after the run ended, with the `kill` a person may choose to run (ct-102477 said only "a
 * process still works in it"). None is stopped here: a deliberately detached process (a dev server, a daemon, a tmux
 * server first started there) looks the same as one the run left behind.
 */
async function refuseTreeProcesses(repo: string, name: string, tree: string, branch: string, read: Reader): Promise<void> {
  const procs = await read(tree);
  if (!procs) throw new Error(`${branch} is checked out by worktree ${name}, and which processes work in it cannot be read: release the worktree with cast ws destroy ${name}, then run this again`);
  if (!procs.length) return;
  const ended = runEndedAt(repo, name);
  const when = (p: TreeProcess) => (!ended || !p.startedAt ? "" : p.startedAt <= ended ? ", started before the run ended" : ", started after the run ended");
  const named = (p: TreeProcess) => `pid ${p.pid} (${p.command.length > 60 ? `${p.command.slice(0, 59)}…` : p.command}${when(p)})`;
  const one = procs.length === 1;
  throw new Error(`${branch} is checked out by worktree ${name}, and ${one ? "a process still works" : `${procs.length} processes still work`} in it: ${procs.map(named).join("; ")}. Stop ${one ? "it" : "them"} if ${one ? "it is" : "they are"} not needed (kill ${procs.map((p) => p.pid).join(" ")}), or release the worktree with cast ws destroy ${name}, then run this again`);
}

type Reader = (tree: string) => Promise<TreeProcess[] | null>;

/** When the run whose worktree is `name` last wrote its checkpoint (ms), or 0 when it never ran here. */
function runEndedAt(repo: string, name: string): number {
  const dir = path.join(lineRunsRoot(repo), name, "runs");
  try { return Math.max(0, ...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs)); } catch { return 0; }
}

/** Every process whose working directory is `tree` or under it, read with lsof and ps; null when they cannot be read. */
export async function treeProcesses(tree: string): Promise<TreeProcess[] | null> {
  const env = { ...process.env, LC_ALL: "C" };
  const lsof = spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pn"], { encoding: "utf-8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env });
  // lsof exits 1 when some processes cannot be read, with the rest on stdout.
  if (lsof.error || lsof.signal || !lsof.stdout) return null;
  const pids: number[] = [];
  let pid = 0;
  for (const l of lsof.stdout.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid && pid !== process.pid && (l.slice(1) === tree || l.slice(1).startsWith(`${tree}/`))) pids.push(pid);
  }
  if (!pids.length) return [];
  const ps = (fields: string, ids: number[]) => spawnSync("ps", ["-o", fields, "-p", ids.join(",")], { encoding: "utf-8", timeout: 10_000, env }).stdout ?? "";
  // Elapsed time, [[dd-]hh:]mm:ss, since a start time is printed in a zone and form that differ by platform.
  const now = Date.now();
  const elapsed = (t: string) => { const [d, rest] = t.includes("-") ? t.split("-") : ["0", t]; return rest.split(":").map(Number).reduce((a, n) => a * 60 + n, 0) + Number(d) * 86_400; };
  const rows = ps("pid=,etime=,command=", [...new Set(pids)]).split("\n").flatMap((l) => {
    const m = /^\s*(\d+)\s+([\d:-]+)\s+(.*)$/.exec(l);
    return m ? [{ pid: Number(m[1]), startedAt: now - elapsed(m[2]) * 1000, command: m[3].trim() }] : [];
  });
  return rows.map((r) => ({ pid: r.pid, command: r.command, startedAt: r.startedAt }));
}

/**
 * Throw unless worktree `holder`, which no run made, is the caller's own (the worktree `cwd` is in) and may be switched
 * off `branch`: not the main checkout, which is everyone's, and nothing uncommitted, which may be meant for the branch.
 * Anyone else's worktree is theirs to switch: no process or session signal tells reliably that nobody commits there
 * next, and a commit made there after a detach lands on no branch.
 */
function refuseUnlessCallersOwn(repo: string, holder: string, branch: string, cwd: string): void {
  const main = git(repo, ["worktree", "list", "--porcelain"])?.split("\n")[0]?.replace(/^worktree /, "");
  if (main && real(main) === real(holder)) {
    throw new Error(`${branch} is checked out in the main checkout ${holder}: switch it off the branch there (git switch --detach), or run this change on another branch`);
  }
  const own = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!own || real(own) !== real(holder)) {
    throw new Error(`${branch} is checked out in ${holder}, which no run made: switch that worktree off it (git -C ${holder} switch --detach), or run this change on another branch`);
  }
  const shown = uncommitted(holder);
  if (shown) {
    throw new Error(`${branch} is checked out in your worktree ${holder}, with uncommitted files (${shown}): commit what belongs on ${branch} and switch it off the branch (git switch --detach), then run this again`);
  }
}

type Post = (route: string, body: Record<string, any>) => Promise<any>;

/** claimRunBranch as `cast flow run` asks it, its liveness and hands read from the server through `post`. */
export async function claimRunBranchVia(repo: string, slug: string | null, branch: string, opts: { task?: string; rewrites: boolean }, post: Post): Promise<string | null> {
  const { runHandsVia } = await import("../lineTrialBranch.js");
  const live: RunLiveness = {
    trees: async () => {
      const { deviceId } = await import("../remote/device.js");
      return liveTreeStates(repo, await post("/cli/workflow-runs/live-on-device", { device: deviceId() }).catch(() => null));
    },
    taskRun: async (task) => {
      const read = await post("/cli/workflow-runs/list", { task_id: task, limit: 1, slim: true });
      if (!Array.isArray(read?.runs)) throw new Error(read?.error ?? "no answer");
      const status = String(read.runs[0]?.status ?? "");
      return ["pending", "running", "paused"].includes(status) ? status : null;
    },
  };
  return claimRunBranch(repo, slug, branch, { ...opts, live, hands: runHandsVia((route, body) => post(route, body)) });
}

/**
 * The worktree an earlier run of this change made (`cast ws path` printed `earlierPath`), read before its branch moves,
 * or null. When it is on `resets`, the branch the run is about to move under it, uncommitted work there refuses: the
 * reset that follows would drop it. One on another branch (an earlier run's) keeps it and is released
 * (flowChange.ts putChangeInWorktree).
 */
export function earlierRunTree(earlierPath: string, resets: string | null): string | null {
  const earlier = earlierPath && fs.existsSync(earlierPath) ? earlierPath : null;
  if (!earlier || !resets || git(earlier, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== resets) return earlier;
  if (git(earlier, ["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error(`The run's worktree ${earlier} holds uncommitted work from an earlier run; finish or clear it before running this change again`);
  }
  return earlier;
}

/** The files `tree` holds uncommitted, the first five named, or null when it holds none. */
function uncommitted(tree: string): string | null {
  // Untrimmed: a porcelain line starts with a space when only the worktree side changed (" M a.txt").
  const r = spawnSync("git", ["-C", tree, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const dirty = r.status === 0 ? (r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.slice(3)) : ["(its status cannot be read)"];
  return dirty.length ? dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, and ${dirty.length - 5} more` : "") : null;
}

/** When git added worktree `tree`: its `.git` file is written once, then; 0 when there is none. */
function madeAt(tree: string): number {
  try { return fs.statSync(path.join(tree, ".git")).mtimeMs; } catch { return 0; }
}

export function young(tree: string, now: number): boolean {
  const at = madeAt(tree);
  return at > 0 && now - at < YOUNG_TREE_MS;
}

/** Whether a run wrote its checkpoint in `runDir` (runResume.ts checkpointPath) at or after `since`. */
function ranSince(runDir: string, since: number): boolean {
  try { return fs.readdirSync(path.join(runDir, "runs")).some((f) => fs.statSync(path.join(runDir, "runs", f)).mtimeMs >= since); } catch { return false; }
}

/** Every tip a freeze of this run left its branch at: the change as frozen here or placed elsewhere, as origin had it, and each rebase of it. */
function frozenTips(repo: string, slug: string): Set<string> {
  const runDir = path.join(lineRunsRoot(repo), slug);
  const tips = new Set<string>();
  for (const change of [readFrozenChange(runDir), readPlacedChange(runDir)]) {
    for (const tip of [change?.tip, change?.frozen_tip, change?.remote_tip]) if (tip) tips.add(tip);
  }
  for (const link of readRebaseChain(runDir)) tips.add(link.from).add(link.to);
  return tips;
}

/** Whether the checkout's own history, or its upstream's, already holds `tip`: a freeze over it loses nothing. */
function inCheckout(repo: string, tip: string): boolean {
  return ["HEAD", "@{upstream}", "refs/remotes/origin/HEAD"].some((ref) =>
    spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", tip, ref], { stdio: "ignore" }).status === 0);
}
