// The change a flow's run works on, as its run directory holds it
// (docs/architecture/flows.md FL4): written by `cast flow run` before the run
// starts, read by the runner as the run's first variables. Kept apart from
// flowChange.ts so the runner reads it without loading the freeze.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

export type FrozenChange = {
  source: "session" | "branch" | "task" | "pr" | "checkout";
  /** The session whose edits these are (its codecast id when it syncs). */
  session?: string;
  /** That session's full conversation id: the run's subject, which hears what each stage found (flows.md FL4). */
  conversation?: string;
  /** The globs the change was cut to (`--only`), so a refreeze cuts it the same way. */
  only?: string[];
  /** The commit message title the change was frozen under. */
  title?: string;
  /** The commit the change sits on: the fetched upstream it was replayed onto, else the checkout's HEAD. */
  base: string;
  tip: string;
  /** Origin's tip of the branch when the change was last frozen, if origin has it: origin holds a fix only once it
   *  moves off this, so a copy pushed before a local rebase never replaces the change. */
  remote_tip?: string;
  /** A change frozen again from a checkout carries the edits its subject made in the run's worktree on top of the
   *  freeze (refreezeSessionChange); this is the freeze's own tip, under them, so the next refreeze carries them too. */
  frozen_tip?: string;
  /**
   * Set when the change could not be replayed onto upstream, so it stays on HEAD, behind that upstream commit: it
   * `conflict`s there in `conflicts`, or the checkout's history is `unreplayable` (a merge commit). `reason` says it whole.
   */
  behind?: { upstream: string; why: "conflict" | "unreplayable"; conflicts: string[]; reason: string };
  /** Set when that upstream commit already holds every file of the change at its frozen content: nothing is left to land. */
  landed?: string;
  branch: string;
  worktree: string;
  paths: string[];
  /** Files another session also wrote that go in whole, carrying its edits too, with why they could not be cut to this session's own lines (ownLines.ts). */
  shared: Array<{ path: string; also: string[]; why?: string }>;
  /** Files the session wrote that stay out: credentials, with why. */
  held: Array<{ path: string; why: string }>;
  /** A checkout's change: the session that wrote each file, which hears findings that name it. A file no session's edit names has no entry. */
  writers?: Record<string, { conversation: string; session: string }>;
  /** The run works on another machine (`cast flow run --device`): the branch is on origin, and the run fetches it again
   *  after each fix rather than reading the subject's checkout, which is not on that machine. */
  pushed?: boolean;
  /** The run a placed change belongs to (set on the run's machine), which `cast flow refreeze <run>` names. */
  run?: string;
};

const CHANGE_FILE = "change.json";

/**
 * The files a branch changes against the repository's main line: `git diff --name-only <merge-base>..<branch>`,
 * where main is origin's HEAD, else origin/main, origin/master, main or master. Empty when none of that can be read,
 * which a station gated on paths (when=) reads as unknown, so it runs.
 */
export function branchChangePaths(top: string, branch: string): string[] {
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", top, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const head = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  const main = [head, "origin/main", "origin/master", "main", "master"].find((b) => b && b !== branch && git("rev-parse", "--verify", "--quiet", b) !== null);
  const base = main ? git("merge-base", main, branch) : null;
  const out = base ? git("diff", "--name-only", `${base}..${branch}`) : null;
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Leave the change where the run's stations read it: `$run_dir/change.json`. */
export function writeFrozenChange(runDir: string, change: FrozenChange): string {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, CHANGE_FILE);
  fs.writeFileSync(file, JSON.stringify(change, null, 2) + "\n");
  return file;
}

/** The change a run's directory holds, or null. */
export function readFrozenChange(runDir: string | undefined): FrozenChange | null {
  if (!runDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, CHANGE_FILE), "utf-8")) as FrozenChange;
  } catch {
    return null;
  }
}

/** How the run takes the subject's fix back, as the briefs say it ($change_return): its edits, or the branch it names. */
export function changeReturnWords(change: Partial<FrozenChange>): string {
  // A placed run (cast flow run --device) cannot read the subject's checkout: the subject freezes its edits again itself,
  // onto the run's branch without touching the shared tree, its index or HEAD, and pushes it for the run to fetch.
  if (change.pushed && change.source === "session") return `This run works on another machine, so it cannot read your edits: when the fix is in place, run \`cast flow refreeze ${change.run ?? "<run id>"}\` in this checkout (it commits your edits to the run's branch ${change.branch} without switching or touching this tree, and pushes it), then end your turn; the run fetches the branch again`;
  if (change.pushed && change.source !== "pr") return `This run works on another machine: commit the fix to branch ${change.branch} in a checkout where that branch is checked out (its own worktree, never by switching a shared tree) and push it (git push origin ${change.branch}); when you end your turn the run fetches that branch again`;
  if (change.source === "pr") return `Push the fix to the pull request's branch ${change.branch}; when you end your turn the run fetches that branch again`;
  if (change.source === "branch" || change.source === "task") return `Commit the fix to branch ${change.branch} and push it (with --force-with-lease if you rebased it), since the run may be on another machine and read the branch from origin; when you end your turn the run reads that branch again`;
  if (change.source === "checkout") return "When you end your turn the run freezes the shared checkout's change again, your edits included";
  return "When you end your turn the run freezes this session's edits again";
}

/** One line on a change left behind upstream, or null when it sits on upstream. */
export function behindWords(change: Pick<FrozenChange, "behind">): string | null {
  const b = change.behind;
  if (!b) return null;
  const at = `upstream ${b.upstream.slice(0, 10)}`;
  return b.why === "conflict"
    ? `the change conflicts with ${at} in ${b.conflicts.join(", ") || "its files"}, so it runs on this checkout's HEAD; Ship's rebase hands the conflict back`
    : `the change could not be replayed onto ${at} (${b.reason}), so it runs on this checkout's HEAD`;
}

/** The variables a run starts with when a change was frozen for it: every station works on that change. */
export function frozenChangeContext(runDir: string | undefined): Record<string, string> {
  if (!runDir) return {};
  try {
    const change = JSON.parse(fs.readFileSync(path.join(runDir, CHANGE_FILE), "utf-8")) as Partial<FrozenChange>;
    if (!change.worktree || !change.branch) return {};
    return {
      worktree: change.worktree,
      branch: change.branch,
      ...(change.session ? { change_session: change.session } : {}),
      ...(change.conversation ? { change_conversation: change.conversation } : {}),
      // No paths is a change whose files were not read: left unset, so `touches` reads it as unknown.
      ...(change.paths?.length ? { change_files: change.paths.join(" ") } : {}),
      // Where a reviewer's diff starts: a session's change sits on the upstream it was cut onto, which the local default branch may lag.
      ...((change.source === "session" || change.source === "checkout") && change.base ? { diff_base: change.base } : {}),
      change_return: changeReturnWords(change),
    };
  } catch {
    return {};
  }
}
