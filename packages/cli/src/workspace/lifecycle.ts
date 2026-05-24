/**
 * Workspace lifecycle: acquire, release, heal, validate, list.
 *
 * Glues together resolver + ports + copy + setup + hooks + contract + state.
 *
 * acquire(repoRoot, name):
 *   1. Resolve manifest (detection + file overrides)
 *   2. Check existing state; if "ready" and contract passes, return as-is
 *   3. Allocate ports (find an unused index)
 *   4. Build env (manifest [env] + PORT_<NAME> + CODECAST_*)
 *   5. Persist initial state = "creating"
 *   6. Run before-create hook
 *   7. Create git worktree + branch
 *   8. Copy gitignored files
 *   9. Run setup (install → generate → migrate)
 *  10. Run after-create hook
 *  11. Validate contract; persist state = "ready" | "broken"
 *  12. Return Workspace
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isPidAlive,
  launchChrome,
  stopChrome,
} from "./chrome.js";
import { copyFiles } from "./copy.js";
import {
  deleteState,
  listStates,
  readState,
  setState,
  validateContract,
  writeState,
  type PersistedWorkspaceState,
} from "./contract.js";
import { buildHookEnv, runHook } from "./hooks.js";
import { allocatePorts, isPortFree, portsToEnv } from "./ports.js";
import { resolveManifest } from "./resolver.js";
import { runSetup } from "./setup.js";
import type {
  AcquireOptions,
  ChromeBinding,
  ContractResult,
  Workspace,
  WorkspaceManifest,
} from "./types.js";

/** Default location for codecast worktrees within a repo. */
const WORKTREES_DIR = ".codecast/worktrees";

/** Default branch prefix for codecast-created branches. */
const BRANCH_PREFIX = "codecast/";

export interface AcquireResult {
  workspace: Workspace;
  /** True if the workspace was created fresh; false if attached to existing. */
  created: boolean;
}

/**
 * Acquire (create or attach to) a workspace by name.
 *
 * Fast path (if a warm pool slot is available and skipPool is not set):
 *   1. Try to claim a ready slot from .codecast/workspaces/_pool/
 *   2. On success, the worktree is renamed to `name` and returned in ~ms
 *   3. On miss, fall through to the standard fresh-acquire path below
 */
export async function acquireWorkspace(
  repoRoot: string,
  name: string,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const manifest = resolveManifest(repoRoot);

  // Dispatch to non-local backend if the manifest selected one.
  if (manifest.backend && manifest.backend !== "local") {
    const { defaultRegistry } = await import("./backends/registry.js");
    if (!defaultRegistry.has(manifest.backend)) {
      throw new Error(
        `backend '${manifest.backend}' is not registered. Available: [${defaultRegistry.list().join(", ")}]`,
      );
    }
    const backend = defaultRegistry.get(manifest.backend);
    const ws = await backend.acquire(repoRoot, name, opts);
    return { workspace: ws, created: true };
  }

  const branch = opts.branch ?? `${BRANCH_PREFIX}${name}`;

  // Attach path: existing state, ready, contract passes → return as-is.
  const existing = readState(repoRoot, name);
  if (existing && existing.state === "ready") {
    const ws = stateToWorkspace(existing);
    const contract = await validateContract(ws);
    if (contract.ok) {
      ws.contract = contract;
      return { workspace: ws, created: false };
    }
    // Existing but broken → fall through to heal path.
  }

  // Warm-pool fast path. Skipped when:
  //   - pool is empty / not initialized (claimFromPool returns null)
  //   - opts.skipPool=true (e.g., from the pool's own pre-warm loop)
  //   - opts.branch overrides the default (custom branch semantics may not
  //     match pool slot conventions; safer to fall through)
  //
  // We intentionally do not pre-init the pool here — callers control sizing.
  if (!opts.skipPool && !opts.branch && !existing) {
    const { claimFromPool } = await import("./pool/manager.js");
    const claimed = await claimFromPool(repoRoot, name);
    if (claimed) {
      return { workspace: claimed.workspace, created: true };
    }
  }

  // Allocate ports. If a previous attempt picked an index, prefer it for
  // stability across re-runs; else start at 0.
  const portAlloc = await allocatePorts(manifest, {
    startIndex: opts.resourceIndex ?? existing?.resourceIndex ?? 0,
  });

  // Pre-write "creating" state so observers see in-progress work.
  const initialEnv = buildWorkspaceEnv(manifest, portAlloc.ports);
  writeState(repoRoot, {
    name,
    path: path.join(repoRoot, WORKTREES_DIR, name),
    branch,
    resourceIndex: portAlloc.resourceIndex,
    state: "creating",
    manifest,
    ports: portAlloc.ports,
    env: initialEnv,
    updatedAt: new Date().toISOString(),
  });

  try {
    // Hook context shared across before/after-create.
    const ctxBase = {
      worktreePath: path.join(repoRoot, WORKTREES_DIR, name),
      worktreeName: name,
      branch,
      resourceIndex: portAlloc.resourceIndex,
      ports: portAlloc.ports,
      extraEnv: manifest.env,
      hooksRoot: repoRoot,
    };

    if (!opts.skipHooks) {
      await runHook("before-create", ctxBase);
    }

    // Create git worktree (or attach to existing branch if already present).
    const worktreePath = createGitWorktree(repoRoot, name, branch);

    // Copy gitignored files from main worktree.
    copyFiles(manifest, repoRoot, worktreePath, { log: () => {} });

    // Run setup commands.
    if (!opts.skipSetup) {
      await runSetup(manifest, worktreePath, {
        env: buildHookEnv(ctxBase, "after-create"),
        stream: null,
      });
    }

    // Launch per-workspace Chrome AFTER setup (so any generated config files
    // are already on disk) but BEFORE the after-create hook (so hooks can
    // assume CDP is reachable).
    let chrome: ChromeBinding | undefined;
    if (manifest.browser.enabled && !opts.skipBrowser) {
      chrome = await launchWorkspaceChrome(
        repoRoot,
        name,
        manifest,
        portAlloc.resourceIndex,
      );
      initialEnv.CDP_PORT = String(chrome.cdpPort);
      initialEnv.CODECAST_CDP_PORT = String(chrome.cdpPort);
    }

    if (!opts.skipHooks) {
      // Augment hook ctx with chrome's CDP port if present.
      const hookCtx = chrome
        ? { ...ctxBase, extraEnv: { ...manifest.env, CDP_PORT: String(chrome.cdpPort) } }
        : ctxBase;
      await runHook("after-create", hookCtx);
    }

    // Validate contract and persist final state.
    const ws: Workspace = {
      name,
      path: worktreePath,
      branch,
      resourceIndex: portAlloc.resourceIndex,
      manifest,
      ports: portAlloc.ports,
      env: initialEnv,
      state: "ready",
      chrome,
    };
    const contract = await validateContract(ws);
    ws.contract = contract;
    ws.state = contract.ok ? "ready" : "broken";
    writeState(repoRoot, workspaceToState(ws));
    return { workspace: ws, created: !existing };
  } catch (err) {
    // Mark broken on failure so subsequent heal can pick up.
    setState(repoRoot, name, "broken");
    throw err;
  }
}

/** Release (tear down) a workspace: stop Chrome, run teardown, remove worktree, drop state. */
export async function releaseWorkspace(repoRoot: string, name: string): Promise<void> {
  const state = readState(repoRoot, name);
  if (!state) return; // nothing to release

  setState(repoRoot, name, "destroying");

  // Stop Chrome first so it releases its CDP port + user-data-dir handles.
  if (state.chrome?.pid && isPidAlive(state.chrome.pid)) {
    await stopChrome(state.chrome.pid, { timeoutMs: 3000 });
  }

  // Best-effort teardown commands.
  if (state.manifest.teardown.run.length > 0) {
    try {
      const env = buildWorkspaceEnv(state.manifest, state.ports);
      await runSetup(
        // Reuse runSetup pipeline by mapping teardown into a 1-phase install.
        {
          ...state.manifest,
          setup: {
            ...state.manifest.setup,
            install: state.manifest.teardown.run,
            generate: [],
            migrate: [],
            copy: [],
          },
        },
        state.path,
        { stream: null, env, skipPhases: ["generate", "migrate"] },
      );
    } catch {
      // Teardown errors are logged but don't block destruction.
    }
  }

  // git worktree remove
  try {
    execSync(`git worktree remove --force ${JSON.stringify(state.path)}`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Fall back to filesystem removal.
    if (fs.existsSync(state.path)) {
      fs.rmSync(state.path, { recursive: true, force: true });
    }
  }

  deleteState(repoRoot, name);
}

/**
 * Launch Chrome for an existing workspace if its manifest enables browser
 * and it doesn't have a live Chrome already. Used by the pool's claim path
 * after pre-warming (which intentionally skips Chrome).
 */
export async function attachBrowserToWorkspace(
  repoRoot: string,
  name: string,
): Promise<Workspace> {
  const state = readState(repoRoot, name);
  if (!state) throw new Error(`workspace '${name}' not found`);
  let chrome = state.chrome;
  if (state.manifest.browser.enabled) {
    if (!chrome || !isPidAlive(chrome.pid)) {
      chrome = await launchWorkspaceChrome(repoRoot, name, state.manifest, state.resourceIndex);
    }
  }
  const ws: Workspace = { ...stateToWorkspace(state), chrome };
  writeState(repoRoot, workspaceToState(ws));
  return ws;
}

/** Idempotent re-run of setup to recover a broken workspace. */
export async function healWorkspace(repoRoot: string, name: string): Promise<Workspace> {
  const state = readState(repoRoot, name);
  if (!state) {
    throw new Error(`workspace '${name}' not found; nothing to heal`);
  }
  setState(repoRoot, name, "creating");
  // Re-copy gitignored files (idempotent) then re-run setup.
  copyFiles(state.manifest, repoRoot, state.path, { log: () => {} });
  await runSetup(state.manifest, state.path, {
    env: buildWorkspaceEnv(state.manifest, state.ports),
    stream: null,
  });

  // Re-launch Chrome if browser enabled and prior PID is dead.
  let chrome = state.chrome;
  if (state.manifest.browser.enabled) {
    if (!chrome || !isPidAlive(chrome.pid)) {
      chrome = await launchWorkspaceChrome(repoRoot, name, state.manifest, state.resourceIndex);
    }
  } else if (chrome && isPidAlive(chrome.pid)) {
    // Browser was disabled in manifest; stop a stale Chrome.
    await stopChrome(chrome.pid).catch(() => {});
    chrome = undefined;
  }

  const ws: Workspace = { ...stateToWorkspace(state), chrome };
  const contract = await validateContract(ws);
  ws.contract = contract;
  ws.state = contract.ok ? "ready" : "broken";
  writeState(repoRoot, workspaceToState(ws));
  return ws;
}

/** Validate an existing workspace without mutating it. */
export async function validateWorkspace(
  repoRoot: string,
  name: string,
): Promise<ContractResult> {
  const state = readState(repoRoot, name);
  if (!state) throw new Error(`workspace '${name}' not found`);
  return validateContract(stateToWorkspace(state));
}

/** List all tracked workspaces (including broken ones). */
export function listWorkspaces(repoRoot: string): Workspace[] {
  return listStates(repoRoot).map(stateToWorkspace);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function stateToWorkspace(s: PersistedWorkspaceState): Workspace {
  return {
    name: s.name,
    path: s.path,
    branch: s.branch,
    resourceIndex: s.resourceIndex,
    manifest: s.manifest,
    ports: s.ports,
    env: s.env,
    state: s.state,
    contract: s.contract,
    chrome: s.chrome,
  };
}

function workspaceToState(ws: Workspace): PersistedWorkspaceState {
  return {
    name: ws.name,
    path: ws.path,
    branch: ws.branch,
    resourceIndex: ws.resourceIndex,
    state: ws.state,
    manifest: ws.manifest,
    ports: ws.ports,
    env: ws.env,
    updatedAt: new Date().toISOString(),
    contract: ws.contract,
    chrome: ws.chrome,
  };
}

/**
 * Launch Chrome for a workspace. Allocates a free CDP port from
 * manifest.browser.cdpPort.{base,range} starting at resourceIndex, bumping up
 * if the computed port is occupied. user-data-dir lives inside the worktree's
 * state directory.
 */
async function launchWorkspaceChrome(
  repoRoot: string,
  workspaceName: string,
  manifest: WorkspaceManifest,
  resourceIndex: number,
): Promise<ChromeBinding> {
  const { base, range } = manifest.browser.cdpPort;
  // Try indices resourceIndex..resourceIndex+9 to find a free CDP port.
  let chosenPort = -1;
  for (let i = resourceIndex; i < resourceIndex + 10; i++) {
    const candidate = base + i * range;
    if (await isPortFree(candidate)) {
      chosenPort = candidate;
      break;
    }
  }
  if (chosenPort < 0) {
    throw new Error(
      `Could not find a free CDP port near ${base + resourceIndex * range}; workspace cannot launch Chrome.`,
    );
  }

  const userDataDir = path.join(
    repoRoot,
    ".codecast/workspaces",
    workspaceName,
    "chrome-profile",
  );
  const inst = await launchChrome({
    cdpPort: chosenPort,
    userDataDir,
    headless: manifest.browser.headless,
  });
  return {
    pid: inst.pid,
    cdpPort: inst.cdpPort,
    userDataDir: inst.userDataDir,
    headless: inst.headless,
  };
}

function buildWorkspaceEnv(
  manifest: WorkspaceManifest,
  ports: Record<string, number>,
): Record<string, string> {
  return { ...manifest.env, ...portsToEnv(ports) };
}

/** Create a git worktree at the conventional location. */
function createGitWorktree(repoRoot: string, name: string, branch: string): string {
  const worktreeDir = path.join(repoRoot, WORKTREES_DIR);
  const worktreePath = path.join(worktreeDir, name);
  fs.mkdirSync(worktreeDir, { recursive: true });

  if (fs.existsSync(worktreePath)) {
    // Already exists — assume previous successful creation. Ensure branch matches.
    return worktreePath;
  }

  // Try create-new-branch path first; fall back to attaching to existing branch.
  try {
    execSync(`git worktree add -b ${branch} ${JSON.stringify(worktreePath)}`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Branch may already exist (e.g., from a previous broken attempt).
    execSync(`git worktree add ${JSON.stringify(worktreePath)} ${branch}`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  return worktreePath;
}
