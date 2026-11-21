// The change a flow's run works on, as its run directory holds it
// (docs/architecture/flows.md FL4): written by `cast flow run` before the run
// starts, read by the runner as the run's first variables. Kept apart from
// flowChange.ts so the runner reads it without loading the freeze.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

export type FrozenChange = {
  source: "session" | "branch" | "task" | "pr";
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
  /** Set when replaying onto upstream conflicted: the change stays on HEAD, behind this upstream commit, and these paths conflict. */
  behind?: { upstream: string; conflicts: string[] };
  branch: string;
  worktree: string;
  paths: string[];
  /** Files another session also wrote: they carry that session's edits too. */
  shared: Array<{ path: string; also: string[] }>;
  /** Files the session wrote that stay out: credentials, with why. */
  held: Array<{ path: string; why: string }>;
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
  if (change.source === "pr") return `Push the fix to the pull request's branch ${change.branch}; when you end your turn the run fetches that branch again`;
  if (change.source === "branch" || change.source === "task") return `Commit the fix to branch ${change.branch}; when you end your turn the run reads that branch again`;
  return "When you end your turn the run freezes this session's edits again";
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
      change_return: changeReturnWords(change),
    };
  } catch {
    return {};
  }
}
