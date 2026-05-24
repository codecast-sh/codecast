/**
 * Lifecycle hooks runner.
 *
 * Hooks are user-supplied scripts in `.codecast/hooks/<name>.sh` that fire
 * at well-defined workspace lifecycle events. They receive a standard set of
 * environment variables describing the workspace.
 *
 * Design:
 *   - A hook is just a script — any executable file with a shebang. We invoke
 *     it via `bash -lc` for portability and to support pipes/redirects.
 *   - Missing hooks are silently no-op. Hooks are entirely optional.
 *   - Non-zero exit fails the lifecycle event. The caller decides whether to
 *     mark the workspace broken or abort the operation.
 *   - Existing dmux conventions are honored: in addition to CODECAST_* env
 *     vars we also export DMUX_* aliases so existing .dmux-hooks/ scripts
 *     continue to work.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HookName } from "./types.js";

/** Conventional directory under the repo where hook scripts live. */
export const HOOKS_DIR = ".codecast/hooks";

export interface HookContext {
  /** Absolute path to the worktree. */
  worktreePath: string;
  /** Short workspace name (slug). */
  worktreeName: string;
  /** Git branch checked out in the worktree. */
  branch: string;
  /** Resource index used for port allocation. */
  resourceIndex: number;
  /** Computed named ports (name → port). Exported as PORT_<NAME_UPPER>. */
  ports: Record<string, number>;
  /** Parent branch we forked from (e.g., "main"). */
  parentBranch?: string;
  /** Manifest-declared static env. Layered into the hook process env. */
  extraEnv?: Record<string, string>;
  /** Repo root where .codecast/hooks/ lives. Defaults to worktreePath. */
  hooksRoot?: string;
}

export interface HookResult {
  ran: boolean;
  exitCode?: number;
  /** Captured stdout+stderr. */
  output?: string;
}

export class HookError extends Error {
  constructor(
    message: string,
    public readonly hook: HookName,
    public readonly exitCode: number | null,
    public readonly output: string,
  ) {
    super(message);
    this.name = "HookError";
  }
}

/** Run a lifecycle hook. Returns ran=false if no script exists for the hook. */
export async function runHook(
  hook: HookName,
  ctx: HookContext,
): Promise<HookResult> {
  const hooksRoot = ctx.hooksRoot ?? ctx.worktreePath;
  const scriptPath = path.join(hooksRoot, HOOKS_DIR, `${hook}.sh`);
  if (!fs.existsSync(scriptPath)) {
    return { ran: false };
  }

  const env = buildHookEnv(ctx, hook);
  const { exitCode, output } = await execScript(scriptPath, ctx.worktreePath, env);

  if (exitCode !== 0) {
    throw new HookError(
      `hook '${hook}' exited ${exitCode}`,
      hook,
      exitCode,
      output,
    );
  }
  return { ran: true, exitCode, output };
}

/**
 * Build the env-var map exported to a hook process.
 *
 * Precedence (lowest → highest):
 *   1. process.env
 *   2. manifest [env] vars (extraEnv)
 *   3. CODECAST_* / PORT_* / DMUX_* canonical names (system-owned, can't be spoofed)
 */
export function buildHookEnv(
  ctx: HookContext,
  hook: HookName,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Layer 2: manifest [env] vars — override process.env defaults.
  for (const [k, v] of Object.entries(ctx.extraEnv ?? {})) {
    env[k] = v;
  }

  // Layer 3: system-owned canonical names — always win, can't be spoofed
  // by extraEnv (which is user-supplied via the manifest).
  env.CODECAST_HOOK = hook;
  env.CODECAST_WORKTREE_PATH = ctx.worktreePath;
  env.CODECAST_WORKTREE_NAME = ctx.worktreeName;
  env.CODECAST_BRANCH = ctx.branch;
  env.CODECAST_RESOURCE_INDEX = String(ctx.resourceIndex);
  if (ctx.parentBranch) env.CODECAST_PARENT_BRANCH = ctx.parentBranch;

  for (const [name, port] of Object.entries(ctx.ports)) {
    env[`CODECAST_PORT_${name.toUpperCase()}`] = String(port);
    env[`PORT_${name.toUpperCase()}`] = String(port);
  }

  // dmux compatibility — keep existing .dmux-hooks/ users working.
  env.DMUX_WORKTREE_PATH = ctx.worktreePath;
  env.DMUX_SLUG = ctx.worktreeName;
  env.DMUX_BRANCH = ctx.branch;
  if (ctx.parentBranch) env.DMUX_TARGET_BRANCH = ctx.parentBranch;

  return env;
}

function execScript(
  scriptPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // Use `bash <script>` (not `bash -lc <path>`) so the script need not have
    // the +x bit set. Bash interprets the file directly.
    const child = spawn("bash", [scriptPath], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (b: Buffer) => {
      output += b.toString("utf-8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      output += b.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, output }));
  });
}
