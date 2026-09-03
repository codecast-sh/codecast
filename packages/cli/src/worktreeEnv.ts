/**
 * The per-worktree environment a session launched inside a codecast
 * worktree should see: the ports `cast ws acquire` allocated for it and the
 * worktree identity, read from the workspace state the acquire wrote.
 *
 * Until now a session got only AGENT_RESOURCE_INDEX and had to re-derive
 * its ports by convention. With PORT_<NAME> in the environment a session can
 * run `vite --port "$PORT_WEB"` and be right on any machine, which is what a
 * session on the cloud host needs to verify its own work. Local isolated
 * sessions and cloud sessions read the same state file, so both get it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const WORKTREE_SEGMENT = "/.codecast/worktrees/";
const KEEP = /^(PORT_[A-Z0-9_]+|CODECAST_PORT_[A-Z0-9_]+|CODECAST_WORKTREE_(PATH|NAME)|CODECAST_BRANCH|CODECAST_RESOURCE_INDEX)$/;

/** The repo root and worktree name for a cwd inside `<repo>/.codecast/worktrees/<name>[/...]`. */
export function locateWorktree(cwd: string): { repoRoot: string; name: string } | null {
  const i = cwd.indexOf(WORKTREE_SEGMENT);
  if (i < 0) return null;
  const rest = cwd.slice(i + WORKTREE_SEGMENT.length);
  const name = rest.split("/")[0];
  if (!name) return null;
  return { repoRoot: cwd.slice(0, i), name };
}

/** The exported env of a worktree's workspace state, or {} when there is none. */
export function worktreeEnv(cwd: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8")): Record<string, string> {
  const wt = locateWorktree(cwd);
  if (!wt) return {};
  try {
    const state = JSON.parse(readFile(path.join(wt.repoRoot, ".codecast", "workspaces", wt.name, "state.json")));
    const env = (state?.env ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (KEEP.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v);
    }
    // The daemon's own name for the index, so a session placed in a worktree
    // it did not create (cloud) sees exactly what an --isolated session sees.
    if (out.CODECAST_RESOURCE_INDEX !== undefined && /^\d+$/.test(out.CODECAST_RESOURCE_INDEX)) {
      out.AGENT_RESOURCE_INDEX = out.CODECAST_RESOURCE_INDEX;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The env as `KEY=VALUE` tokens for an `env ...` launch prefix. Values are
 * single-quoted (ports and paths, but never trusted), keys are validated by
 * KEEP so no token can break out of the command line.
 */
export function worktreeEnvPrefix(cwd: string): string {
  return Object.entries(worktreeEnv(cwd))
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
}
