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
import { spawnSync } from "node:child_process";
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

/**
 * Take `branch` out of its worktree, keeping everything on it: work left
 * uncommitted there is committed first, then the line's own worktree is
 * released (one made by hand elsewhere stays, detached). Whether there was a
 * worktree, and whether it held uncommitted work.
 */
async function freeBranch(repo: string, slug: string, branch: string, task: string): Promise<{ committed: boolean } | null> {
  const tree = worktreeOf(repo, branch);
  if (!tree) return null;
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
export async function releaseRunWorktree(cwd: string, graph: Pick<WorkflowGraph, "name">, task: string, dry = false): Promise<{ slug: string; committed: boolean } | null> {
  const repo = git(cwd, ["rev-parse", "--show-toplevel"]).out;
  if (!repo) return null;
  const slug = runSlug(graph as WorkflowGraph, { task_id: task }, "run");
  const branch = `codecast/${slug}`;
  const tree = worktreeOf(repo, branch);
  if (!tree) return null;
  if (dry) return { slug, committed: !!git(tree, ["status", "--porcelain"]).out };
  const freed = await freeBranch(repo, slug, branch, task);
  return freed ? { slug, ...freed } : null;
}

/** Set the earlier run's branch aside and start `codecast/<slug>` again from origin/main. */
export async function freshRunBranch(cwd: string, graph: Pick<WorkflowGraph, "name">, task: string, now = new Date()): Promise<FreshBranch> {
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
    await freeBranch(repo, slug, branch, task);
    if (!git(repo, ["branch", "-m", branch, `codecast/${setAside}`]).ok) throw new Error(`Could not set ${branch} aside as codecast/${setAside}`);
    const runDir = lineRunDir(repo, slug);
    if (fs.existsSync(runDir)) fs.renameSync(runDir, lineRunDir(repo, setAside));
  }
  if (fs.existsSync(path.join(repo, ".codecast", "workspace.toml"))) {
    // Built here, ready, so the run's hand attaches to it (daemon createWorktree)
    // rather than to a warm pool slot cut from the checkout's own HEAD.
    const { acquireWorkspace } = await import("./workspace/lifecycle.js");
    await acquireWorkspace(repo, slug, { branch, startPoint: base });
  } else if (!git(repo, ["branch", branch, base]).ok) {
    throw new Error(`Could not start ${branch} from ${base}`);
  }
  return { slug, branch, base, set_aside: setAside };
}
