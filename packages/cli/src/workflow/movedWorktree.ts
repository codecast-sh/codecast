// A named branch's change whose run worktree a session moved to another branch
// (ct-102728: the Fix session fixed a stacked change from tv-pr2-voice and
// pushed the fix to the change's own branch, tv-pr3-tips-voice). The change is
// the branch, on origin as the session pushed it, so the refreeze reads it back
// from there and puts the worktree back on it, instead of failing a fixed
// change. Only when it cannot (edits left uncommitted on the other branch,
// commits there that origin never got, a branch it cannot read or check out)
// does it stop, naming the resume that fits a fixed change.
import { git, gitTry } from "../wipSnapshot.js";
import type { FrozenChange } from "./flowChangeFile.js";
import type { WorkflowGraph } from "./types";

/**
 * Where a run resumes once its change is fixed outside the station that asked for the fix: the station the fix
 * station goes on to when it succeeds, as `cast workflow resume <task> --at <station>`. Null without a task or route.
 */
export function resumeAfterFix(graph: Pick<WorkflowGraph, "edges">, fixNode: string, task: string | undefined): string | null {
  if (!task) return null;
  const next = graph.edges.find((e) => e.from === fixNode && (!e.condition || /^outcome = success$/.test(e.condition.trim())));
  return next ? `cast workflow resume ${task} --at ${next.to}` : null;
}

/**
 * Read a named branch's change back from origin into a run worktree the session left on `on` (another branch, or
 * none), and put the worktree back on the change's branch. `carry` is the refreeze's own read of the branch
 * (flowChange branchCarry): origin's tip, with what the branch here holds over it replayed on top.
 */
export async function reclaimMovedWorktree(
  root: string,
  worktree: string,
  before: FrozenChange,
  on: string | null,
  carry: (head: string) => Promise<{ tip: string; remote_tip?: string }>,
  resume: string | null,
): Promise<{ change: FrozenChange; moved: boolean }> {
  const stop = (why: string) => new Error(`The run's worktree ${worktree} is ${on ? `on ${on}` : "on no branch"}, not the change's branch ${before.branch}, and ${why}, so the run left it as it is.${resume ? ` The change is the branch: once ${before.branch} holds the fix on origin, resume the run with \`${resume}\`.` : ""}`);
  const first = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n").find((l) => /error|fatal/i.test(l))?.trim() || String(err).split("\n")[0];
  if (await git(worktree, ["status", "--porcelain", "--untracked-files=no"])) throw stop(`it holds edits left uncommitted on ${on ?? "that commit"}`);
  const local = (await gitTry(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${before.branch}`])) || before.tip;
  let read: { tip: string; remote_tip?: string };
  try { read = await carry(local); } catch (err) { throw stop(`origin's ${before.branch} could not be read back (${first(err)})`); }
  // Commits only this worktree holds (a fix committed on a detached HEAD, or on another branch never pushed) would be
  // left behind by the checkout, and the run would read the change as unchanged.
  const loose = Number((await gitTry(worktree, ["rev-list", "--count", "HEAD", "--not", "--remotes=origin", `refs/heads/${before.branch}`])) ?? 0);
  if (loose > 0) throw stop(`it holds ${loose} commit${loose === 1 ? "" : "s"} no branch on origin has (up to ${(await git(worktree, ["rev-parse", "--short=10", "HEAD"]))}): push the fix to ${before.branch}, not ${on ?? "a detached HEAD"}`);
  const change = { ...before, ...read };
  try { await git(worktree, ["checkout", "--quiet", "-B", before.branch, change.tip]); } catch (err) { throw stop(`it could not be put back on ${before.branch} (${first(err)})`); }
  const tree = (rev: string) => git(root, ["rev-parse", `${rev}^{tree}`]).catch(() => rev);
  return { change, moved: (await tree(before.tip)) !== (await tree(change.tip)) };
}
