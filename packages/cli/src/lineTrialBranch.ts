// A trial run proves against the code it means to change. The line names a
// task's worktree, branch and run directory after the graph and the task
// (runner.ts runSlug), so a later run on the same problem would land on the
// earlier run's branch, which already carries that run's fix: red passes and
// prove loops. Before a trial run starts, the earlier run's worktree, branch
// and run directory are set aside under a dated name (nothing is deleted:
// work it left uncommitted is committed onto the set-aside branch), and a new
// worktree and branch start from origin/main.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "./proc.js";
import { lineRunDir, runSlug } from "./workflow/runner.js";
import type { WorkflowGraph } from "./workflow/types.js";

export type FreshBranch = { slug: string; branch: string; base: string; set_aside: string | null };

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

/** The worktree that has `branch` checked out, if any. */
function worktreeOf(repo: string, branch: string): string | null {
  let at: string | null = null;
  for (const line of git(repo, ["worktree", "list", "--porcelain"]).out.split("\n")) {
    if (line.startsWith("worktree ")) at = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return null;
}

/** The processes working inside `tree`: every one whose current directory is in it. */
export function processesIn(tree: string, lsofOut?: string): Array<{ pid: number; command: string }> {
  const out = lsofOut ?? (spawnSync("lsof", ["-a", "-d", "cwd", "-F", "pcn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).stdout ?? "");
  const found: Array<{ pid: number; command: string }> = [];
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); command = ""; }
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n") && pid !== process.pid && (line.slice(1) === tree || line.slice(1).startsWith(`${tree}/`))) found.push({ pid, command });
  }
  return found;
}

/** The agent sessions among `pids`: the session id each one was started or resumed with. */
export function sessionIdsOf(pids: number[], psOut?: string): string[] {
  if (!pids.length) return [];
  const out = psOut ?? (spawnSync("ps", ["-o", "args=", "-p", pids.join(",")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "");
  const ids = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/(?:--session-id|--resume|\bresume)[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

/** Codecast's view of the sessions found working in a worktree, and the way to stop one. */
export type RunHands = {
  /** The named sessions that are live, and whether each is working now. */
  live(sessionIds: string[]): Promise<Array<{ id: string; working: boolean }>>;
  stop(id: string): Promise<void>;
};

export function runHandsVia(post: (route: string, body: Record<string, unknown>) => Promise<any>): RunHands {
  return {
    live: async (sessionIds) => sessionIds.length
      ? (((await post("/cli/inbox", { session_ids: sessionIds, show_all: true }))?.sessions ?? []) as any[])
        .filter((r) => r.is_live && !r.is_killed)
        .map((r) => ({ id: String(r.id), working: r.work_state === "working" }))
      : [],
    stop: async (id) => { await post("/cli/sessions/kill", { session: id }); },
  };
}

/**
 * Nothing may still be at work in an earlier run's worktree when it is set
 * aside. A hand left there keeps writing to the path, and a worktree rebuilt
 * under it on the fresh branch is where its next commit, or its repair of a
 * branch it finds reset, lands: a build hand settled while it worked put its
 * fix back onto the "fresh" branch with `git reset --keep`, and the next run
 * proved against it (ct-60298). A session that is working refuses the fresh
 * run; one that has settled is the earlier run's leftover and is stopped.
 * Anything still running in the tree after that refuses too.
 */
async function clearTree(tree: string, hands?: RunHands, waitMs = 15_000): Promise<void> {
  let busy = processesIn(tree);
  if (!busy.length) return;
  const live = hands ? await hands.live(sessionIdsOf(busy.map((p) => p.pid))) : [];
  const working = live.filter((h) => h.working);
  if (working.length) throw new Error(`${tree} has a session still working in it (${working.map((h) => h.id.slice(0, 7)).join(", ")}): an earlier run's hand is at work there. Let it finish or kill it, then start the run again.`);
  for (const h of live) await hands!.stop(h.id);
  for (const until = Date.now() + (live.length ? waitMs : 0); ; busy = processesIn(tree)) {
    if (!busy.length) return;
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const who = busy.slice(0, 5).map((p) => `${p.command || "?"} ${p.pid}`).join(", ");
  throw new Error(`${tree} is still in use by ${busy.length} process${busy.length === 1 ? "" : "es"} (${who}). Stop ${busy.length === 1 ? "it" : "them"}, then start the run again.`);
}

/**
 * Take `branch` out of its worktree, keeping everything on it: work left
 * uncommitted there is committed first, then the line's own worktree is
 * released (one made by hand elsewhere stays, detached). Whether there was a
 * worktree, and whether it held uncommitted work. Refused while anything still
 * works in the worktree (clearTree).
 */
async function freeBranch(repo: string, slug: string, branch: string, task: string, hands?: RunHands): Promise<{ committed: boolean } | null> {
  const tree = worktreeOf(repo, branch);
  if (!tree) return null;
  await clearTree(tree, hands);
  const committed = !!git(tree, ["status", "--porcelain"]).out;
  if (committed) {
    git(tree, ["add", "-A"]);
    git(tree, ["commit", "-q", "--no-verify", "-m", `Left uncommitted by an earlier run on ${task}`]);
  }
  if (fs.existsSync(path.join(repo, ".codecast", "workspaces", slug))) {
    const { releaseWorkspace } = await import("./workspace/lifecycle.js");
    await releaseWorkspace(repo, slug);
  } else {
    // A worktree made by hand elsewhere stays where it is, off the branch.
    git(tree, ["switch", "-q", "--detach"]);
  }
  return { committed };
}

/**
 * Release the worktree of an ended run on a closed problem (`cast line trial
 * sweep`): the branch `codecast/<slug>` stays with all its work. Null when no
 * worktree holds the branch; `dry` only says what it would do.
 */
export async function releaseRunWorktree(cwd: string, graph: Pick<WorkflowGraph, "name">, task: string, dry = false, hands?: RunHands): Promise<{ slug: string; committed: boolean } | null> {
  const repo = git(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (!repo) return null;
  const slug = runSlug(graph as WorkflowGraph, { task_id: task }, "run");
  const branch = `codecast/${slug}`;
  const tree = worktreeOf(repo, branch);
  if (!tree) return null;
  if (dry) return { slug, committed: !!git(tree, ["status", "--porcelain"]).out };
  const freed = await freeBranch(repo, slug, branch, task, hands);
  return freed ? { slug, ...freed } : null;
}

/** Set the earlier run's branch aside and start `codecast/<slug>` again from origin/main. */
export async function freshRunBranch(cwd: string, graph: Pick<WorkflowGraph, "name">, task: string, now = new Date(), hands?: RunHands): Promise<FreshBranch> {
  const repo = git(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (!repo) throw new Error(`${cwd} is not in a git repository`);
  const slug = runSlug(graph as WorkflowGraph, { task_id: task }, "run");
  const branch = `codecast/${slug}`;
  git(repo, ["fetch", "-q", "origin", "main"]);
  const base = git(repo, ["rev-parse", "--verify", "-q", "origin/main"]).ok ? "origin/main" : "main";
  let setAside: string | null = null;

  if (git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).ok) {
    const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    setAside = `${slug}-before-${stamp}`;
    await freeBranch(repo, slug, branch, task, hands);
    if (!git(repo, ["branch", "-m", branch, `codecast/${setAside}`]).ok) throw new Error(`Could not set ${branch} aside as codecast/${setAside}`);
    const runDir = lineRunDir(repo, slug);
    if (fs.existsSync(runDir)) fs.renameSync(runDir, lineRunDir(repo, setAside));
  }
  if (fs.existsSync(path.join(repo, ".codecast", "workspace.toml"))) {
    // Built here, ready, so the run's hand attaches to it (daemon createWorktree)
    // rather than to a warm pool slot cut from the checkout's own HEAD.
    const { acquireWorkspace, releaseWorkspace } = await import("./workspace/lifecycle.js");
    // A workspace of this name that holds no branch any more (one that broke while it was built) would
    // refuse the start, and every later one, with no runner to say so (ct-59568): it goes first.
    if (fs.existsSync(path.join(repo, ".codecast", "workspaces", slug))) await releaseWorkspace(repo, slug);
    await acquireWorkspace(repo, slug, { branch, startPoint: base });
  } else if (!git(repo, ["branch", branch, base]).ok) {
    throw new Error(`Could not start ${branch} from ${base}`);
  }
  return { slug, branch, base, set_aside: setAside };
}
