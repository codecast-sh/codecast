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
