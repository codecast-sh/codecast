// The change a flow's run works on, as its run directory holds it
// (docs/architecture/flows.md FL4): written by `cast flow run` before the run
// starts, read by the runner as the run's first variables. Kept apart from
// flowChange.ts so the runner reads it without loading the freeze.
import * as fs from "node:fs";
import * as path from "node:path";

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
  base: string;
  tip: string;
  branch: string;
  worktree: string;
  paths: string[];
  /** Files another session also wrote: they carry that session's edits too. */
  shared: Array<{ path: string; also: string[] }>;
  /** Files the session wrote that stay out: credentials, with why. */
  held: Array<{ path: string; why: string }>;
};

const CHANGE_FILE = "change.json";

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
      change_files: (change.paths ?? []).join(" "),
    };
  } catch {
    return {};
  }
}
