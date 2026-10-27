// Where a checkout keeps its runs' files (line-profile.md LP4).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

/**
 * The directory holding a checkout's run files: one directory per run slug
 * (runner.ts runSlug), inside the repository's own git directory so nothing
 * there is ever committed. A run's isolated hands work in a worktree of the
 * same name, so a directory here is also how a worktree is known to be a
 * run's. Outside a repository it lives under the temp directory.
 */
export function lineRunsRoot(cwd: string): string {
  // A main checkout's own root needs no git call (the daemon asks from its loop, worktreeGc.ts). A `.git` with no HEAD
  // is not a repository's: Claude Code writes `<cwd>/.git/info/exclude` wherever a session starts, so one started in a
  // subfolder (Union's outreach/) leaves a bare `.git` there, and runs that took it for the checkout's kept half their
  // records apart from the rest (Green read an empty proof dir and Build ran out of visits, ct-61693, 2026-10-26).
  try { if (fs.existsSync(path.join(cwd, ".git", "HEAD"))) return path.join(cwd, ".git", "cast-line"); } catch {}
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0 && r.stdout.trim()) return path.join(r.stdout.trim(), "cast-line");
  } catch {}
  return path.join(os.tmpdir(), "cast-line");
}

/** The newest checkpoint file of `runId` under the checkout's run dirs (runResume.ts checkpointPath), or null. */
export function findCheckpointFile(cwd: string, runId: string): string | null {
  const root = lineRunsRoot(cwd);
  const name = `${runId.replace(/[^\w-]/g, "")}.json`;
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  let best: { file: string; at: number } | null = null;
  for (const d of dirs) {
    const file = path.join(root, d, "runs", name);
    try {
      const at = fs.statSync(file).mtimeMs;
      if (!best || at > best.at) best = { file, at };
    } catch { /* not here */ }
  }
  return best?.file ?? null;
}

/** The names under a checkout's run dirs, each the name of the worktree its run's hands work in. */
export function runTreeNames(root: string): Set<string> {
  try { return new Set(fs.readdirSync(lineRunsRoot(root))); } catch { return new Set(); }
}

/**
 * The worktrees of a checkout that the runs `runIds` work in: each run's
 * checkpoint names its worktree (`context.worktree`), else the run dir it sits
 * in carries the name.
 */
export function runTreesOf(cwd: string, runIds: Iterable<string>): Set<string> {
  const root = lineRunsRoot(cwd);
  const names = [...runIds].map((id) => `${id.replace(/[^\w-]/g, "")}.json`);
  const trees = new Set<string>();
  let dirs: string[];
  try { dirs = fs.readdirSync(root); } catch { return trees; }
  for (const d of dirs) {
    for (const name of names) {
      const file = path.join(root, d, "runs", name);
      if (!fs.existsSync(file)) continue;
      let tree = d;
      try { tree = JSON.parse(fs.readFileSync(file, "utf-8"))?.context?.worktree || d; } catch { /* half written: the dir names it */ }
      trees.add(tree);
      trees.add(d);
    }
  }
  return trees;
}
