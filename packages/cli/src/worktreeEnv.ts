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
/** The reserved record `cast ws root` writes for the main checkout (workspace/lifecycle.ts ROOT_WORKSPACE_NAME). */
const ROOT_WORKSPACE_NAME = "shared-checkout";

/** The repo root and worktree name for a cwd inside `<repo>/.codecast/worktrees/<name>[/...]`. */
export function locateWorktree(cwd: string): { repoRoot: string; name: string } | null {
  const i = cwd.indexOf(WORKTREE_SEGMENT);
  if (i < 0) return null;
  const rest = cwd.slice(i + WORKTREE_SEGMENT.length);
  const name = rest.split("/")[0];
  if (!name) return null;
  return { repoRoot: cwd.slice(0, i), name };
}

/**
 * The repo root whose main checkout carries a `shared-checkout` record, for a
 * cwd at or below it: a cloud session in shared mode runs in the root itself,
 * so there is no worktree segment to find — the state file is the only mark.
 * Walks up from cwd; the first directory holding the record wins.
 */
export function locateRootWorkspace(cwd: string, exists: (p: string) => boolean = fs.existsSync): { repoRoot: string; name: typeof ROOT_WORKSPACE_NAME } | null {
  let dir = cwd;
  for (;;) {
    if (exists(path.join(dir, ".codecast", "workspaces", ROOT_WORKSPACE_NAME, "state.json"))) return { repoRoot: dir, name: ROOT_WORKSPACE_NAME };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The exported env of a worktree's workspace state, or {} when there is none.
 * A cwd inside `.codecast/worktrees/<x>` reads that worktree's state; any
 * other cwd falls back to the main checkout's `shared-checkout` record when
 * one exists (and its recorded path is that root), so a shared cloud session
 * sees the same PORT_* / AGENT_RESOURCE_INDEX an isolated one does. The root
 * never gets the BUN_INSTALL_* override: it keeps bun's global store.
 */
export function worktreeEnv(cwd: string, readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf-8"), exists: (p: string) => boolean = fs.existsSync): Record<string, string> {
  let wt = locateWorktree(cwd);
  let root = false;
  if (!wt) {
    wt = locateRootWorkspace(cwd, exists);
    if (!wt) return {};
    root = true;
  }
  try {
    const state = JSON.parse(readFile(path.join(wt.repoRoot, ".codecast", "workspaces", wt.name, "state.json")));
    if (root && state?.path !== wt.repoRoot) return {};
    const env = (state?.env ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    if (!root && env.CODECAST_CLOUD_WORKSPACE === "1") {
      out.BUN_INSTALL_GLOBAL_STORE = "0";
      out.BUN_INSTALL_CACHE_DIR = path.join(wt.repoRoot, ".codecast", "workspaces", wt.name, "bun-cache");
    }
    for (const [k, v] of Object.entries(env)) {
      if (KEEP.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v);
    }
    for (const [name, port] of Object.entries(state.ports ?? {})) {
      if (/^[a-zA-Z0-9_]+$/.test(name) && Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535) {
        out[`PORT_${name.toUpperCase()}`] = String(port);
        out[`CODECAST_PORT_${name.toUpperCase()}`] = String(port);
      }
    }
    if (typeof state.name === "string") out.CODECAST_WORKTREE_NAME = state.name;
    if (typeof state.path === "string") out.CODECAST_WORKTREE_PATH = state.path;
    if (typeof state.branch === "string") out.CODECAST_BRANCH = state.branch;
    if (Number.isInteger(state.resourceIndex) && state.resourceIndex >= 0) {
      out.CODECAST_RESOURCE_INDEX = String(state.resourceIndex);
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

export function withWorktreeConfig<T extends { cwd?: string; config?: Record<string, unknown> }>(params: T): T {
  const env = params.cwd ? worktreeEnv(params.cwd) : {};
  if (!Object.keys(env).length) return params;
  return {
    ...params,
    config: {
      ...params.config,
      "shell_environment_policy.set": {
        ...(params.config?.["shell_environment_policy.set"] as Record<string, unknown> | undefined),
        ...env,
      },
    },
  };
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
