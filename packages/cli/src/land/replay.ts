/**
 * Rebase a line of commits onto a new base entirely in the object store: no
 * working tree, no index, no stash. Each commit is cherry-picked with
 * `git merge-tree --write-tree --merge-base=<its parent>` and recommitted with
 * its own author, date and message, so a shared checkout full of other
 * sessions' edits can be rebased while they keep typing.
 *
 * `git replay` does the same but is still experimental and reports only
 * branch refs; merge-tree's --merge-base is stable since git 2.40.
 */

import { git, gitTry } from "../wipSnapshot.js";

export type ReplayResult =
  | { ok: true; tip: string; replayed: number; unchanged: boolean; dropped: string[] }
  | { ok: false; commit: string; subject: string; conflicts: string[]; reason: string };

/** The commits in base..tip, oldest first; throws on a merge commit, which a linear replay cannot carry. */
export async function linearCommits(cwd: string, base: string, tip: string): Promise<string[]> {
  const merges = await git(cwd, ["rev-list", "--merges", `${base}..${tip}`]);
  if (merges) throw new Error(`${base.slice(0, 9)}..${tip.slice(0, 9)} holds merge commit ${merges.split("\n")[0].slice(0, 9)}; replay carries only linear history`);
  const out = await git(cwd, ["rev-list", "--reverse", `${base}..${tip}`]);
  return out ? out.split("\n") : [];
}

/** Replay base..tip onto `onto`. Commits already sitting on `onto` keep their shas. */
export async function replayOnto(cwd: string, base: string, tip: string, onto: string): Promise<ReplayResult> {
  const commits = await linearCommits(cwd, base, tip);
  let current = await git(cwd, ["rev-parse", `${onto}^{commit}`]);
  let rewrote = false;
  const dropped: string[] = [];
  for (const commit of commits) {
    const parent = await git(cwd, ["rev-parse", `${commit}^`]);
    if (!rewrote && parent === current) {
      current = commit;
      continue;
    }
    rewrote = true;
    const merged = await mergeTree(cwd, parent, current, commit);
    if (!merged.ok) {
      const subject = await git(cwd, ["log", "-1", "--format=%s", commit]);
      return { ok: false, commit, subject, conflicts: merged.conflicts, reason: `${commit.slice(0, 9)} "${subject}" conflicts with ${onto} in ${merged.conflicts.join(", ")}` };
    }
    // Already upstream (pushed from elsewhere, or landed by another route):
    // nothing left to say, so it is dropped, as rebase drops it.
    if (merged.tree === (await git(cwd, ["rev-parse", `${current}^{tree}`]))) { dropped.push(commit); continue; }
    current = await recommit(cwd, commit, merged.tree, current);
  }
  return { ok: true, tip: current, replayed: commits.length - dropped.length, unchanged: !rewrote, dropped };
}

async function mergeTree(cwd: string, base: string, ours: string, theirs: string): Promise<{ ok: true; tree: string } | { ok: false; conflicts: string[] }> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("git", ["-C", cwd, "merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, ours, theirs], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const lines = String(r.stdout ?? "").split("\n").filter(Boolean);
  if (r.status === 0 && lines[0]) return { ok: true, tree: lines[0] };
  if (r.status === 1) return { ok: false, conflicts: [...new Set(lines.slice(1))] };
  throw new Error(`git merge-tree failed: ${String(r.stderr ?? "").trim() || `exit ${r.status}`}`);
}

/** Commit `tree` on `parent` with `original`'s author, author date and message. */
async function recommit(cwd: string, original: string, tree: string, parent: string): Promise<string> {
  const raw = await git(cwd, ["cat-file", "commit", original]);
  const split = raw.indexOf("\n\n");
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  const author = /^author (.*) <(.*)> (\d+ [+-]\d{4})$/m.exec(header);
  const env = { ...process.env };
  if (author) {
    env.GIT_AUTHOR_NAME = author[1];
    env.GIT_AUTHOR_EMAIL = author[2];
    env.GIT_AUTHOR_DATE = author[3];
  }
  return git(cwd, ["commit-tree", tree, "-p", parent, "-F", "-"], env, message);
}

/** True when `ancestor` is reachable from `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitTry(cwd, ["merge-base", "--is-ancestor", ancestor, descendant])) !== null;
}
