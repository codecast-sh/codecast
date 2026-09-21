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
 *   8. Copy gitignored files; symlink setup.share directories
 *   9. Run setup (install → generate → migrate)
 *  10. Run after-create hook
 *  11. Validate contract; persist state = "ready" | "broken"
 *  12. Return Workspace
 */

import { execFileAsync, execSync } from "../proc.js";
import { execFileSync } from "../proc.js";
import { randomUUID } from "node:crypto";
import { WIP_SNAPSHOT_SUBJECT } from "../wipSnapshot.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isPidAlive,
  launchChrome,
  stopChrome,
} from "./chrome.js";
import { copyFiles } from "./copy.js";
import {
  WORKSPACES_STATE_DIR,
  listStates,
  readState,
  setState,
  stateToWorkspace,
  validateContract,
  writeState,
  type PersistedWorkspaceState,
} from "./contract.js";
import { buildHookEnv, runHook } from "./hooks.js";
import { PortAllocationError, allocatePorts, computePorts, isPortFree, portsToEnv } from "./ports.js";
import { partitionReservations, withPortReservations, withWorkspaceOperation, type PortReservation } from "./portReservations.js";
import { MANIFEST_REL_PATH, resolveManifest } from "./resolver.js";
import { linkSharedDirectories, unlinkSharedDirectories } from "./share.js";
import { runSetup } from "./setup.js";
import { moveToTrash, sweepTrash } from "./trash.js";
import { TEARDOWN_TARGET_ID, enforceWorkspaceTrust, untrustedTargetIds } from "./trust.js";
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

/**
 * The reserved workspace name of the MAIN checkout itself: the record
 * `cast ws root` writes so a cloud session in shared mode gets ports that no
 * isolated `cast ws acquire` on the host reuses (ports are reserved from
 * listStates, so only a state file can hold them) and a `bun install` in the
 * root. Its state.path is the repo root, never a worktree.
 */
export const ROOT_WORKSPACE_NAME = "shared-checkout";

export interface AcquireResult {
  workspace: Workspace;
  /** True if the workspace was created fresh; false if attached to existing. */
  created: boolean;
  notices?: string[];
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
  return withWorkspaceOperation(repoRoot, name, () => acquireWorkspaceUnlocked(repoRoot, name, opts));
}

async function acquireWorkspaceUnlocked(repoRoot: string, name: string, opts: AcquireOptions): Promise<AcquireResult> {
  if (name === ROOT_WORKSPACE_NAME) {
    throw new Error(`'${ROOT_WORKSPACE_NAME}' is reserved for the main checkout — use cast ws root`);
  }
  await sweepTrash(path.join(repoRoot, WORKTREES_DIR));
  const previous = readState(repoRoot, name);
  const savedInputRoot = previous?.env.CODECAST_WORKSPACE_INPUT_ROOT;
  const inputRoot = savedInputRoot ?? (opts.inputRoot ? fs.realpathSync(opts.inputRoot) : undefined);
  const manifest = savedInputRoot ? previous!.manifest : resolveManifest(repoRoot, inputRoot);
  const cloudWorkspace = process.env.CODECAST_CLOUD_WORKSPACE === "1" || previous?.env.CODECAST_CLOUD_WORKSPACE === "1";
  if (cloudWorkspace) manifest.backend = "local";
  const noPorts = opts.noPorts === true || previous?.noPorts === true;
  if (noPorts) manifest.ports = {};

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

  // Why above everything: each path below can execute code the repo carries —
  // its hook scripts, its manifest commands — and that includes claiming a
  // warm pool slot, which runs no setup of its own but hands over a worktree
  // built from those same files. Checking here is what keeps a slot warmed
  // before a hook changed from being handed out unchecked (ct-49543).
  enforceWorkspaceTrust({
    repoRoot,
    hooksRoot: repoRoot,
    manifestRoot: inputRoot ?? repoRoot,
    hooks: !opts.skipHooks,
    commands: !opts.skipSetup,
    grant: opts.trust,
    agentDriven: opts.agentDriven,
  });

  const branch = opts.branch ?? previous?.branch ?? `${BRANCH_PREFIX}${name}`;
  if (opts.startPoint && !opts.branch) throw new Error("a start point needs an explicit branch name");
  if (opts.altBranch && !opts.startPoint) throw new Error("altBranch only applies with a start point");
  // A start point never reuses a name: the contract is a NEW branch and
  // directory, so an existing record (ready, broken or mid-creation) is an
  // error rather than a silent return of the old worktree.
  if (opts.startPoint && readState(repoRoot, name)) throw new Error(`workspace ${name} already exists; a start point needs a fresh name`);
  // A seeded worktree: the state records where it started and the commit the
  // branch is reset to right after creation (seedBase), so the GC can tell
  // "still the laptop's tree" from host-made work and heal can rebuild it.
  const seed = opts.startPoint ? seedFieldsFor(repoRoot, opts.startPoint) : undefined;
  const seedFields = seed
    ? { startPoint: seed.startPoint, seedBase: seed.seedBase }
    : { ...(previous?.startPoint ? { startPoint: previous.startPoint } : {}), ...(previous?.seedBase ? { seedBase: previous.seedBase } : {}) };

  const prepared = await withPortReservations(repoRoot, async (reservations) => {
    const existing = readState(repoRoot, name);
    if (existing && existing.state === "ready" && (!noPorts || existing.noPorts)) {
      const ws = stateToWorkspace(existing);
      const contract = await validateContract(ws);
      if (contract.ok) {
        ws.contract = contract;
        return { result: { workspace: ws, created: false } };
      }
    }

    if (!noPorts && !opts.skipPool && !opts.branch && !opts.startPoint && !existing && !inputRoot) {
      // Why record BEFORE claiming: the demand file is what sizes the pool and
      // what the daemon's maintainer watches, so writing it here is what
      // re-arms the slot this create is about to consume — and only when the
      // creates around it look like a burst (ct-49540).
      const { recordWorkspaceCreate } = await import("./pool/demand.js");
      await recordWorkspaceCreate(repoRoot).catch(() => {});
      const { claimFromPool } = await import("./pool/manager.js");
      const claimed = await claimFromPool(repoRoot, name);
      if (claimed) {
        return { result: { workspace: claimed.workspace, created: true } };
      }
    }

    const root = fs.realpathSync(repoRoot);
    const { portAlloc, notices } = await allocateWorkspacePorts(
      name, manifest, reservations, root, opts.resourceIndex ?? existing?.resourceIndex ?? 0,
    );
    const initialEnv = buildWorkspaceEnv(manifest, portAlloc.ports);
    if (inputRoot) initialEnv.CODECAST_WORKSPACE_INPUT_ROOT = inputRoot;
    if (cloudWorkspace) {
      Object.assign(initialEnv, {
        CODECAST_CLOUD_WORKSPACE: "1",
        BUN_INSTALL_GLOBAL_STORE: "0",
        BUN_INSTALL_CACHE_DIR: path.join(repoRoot, ".codecast", "workspaces", name, "bun-cache"),
      });
    }
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
      ...seedFields,
      ...(noPorts ? { noPorts: true } : {}),
    });
    return { existing, portAlloc, initialEnv, notices };
  });
  if (prepared.result) return prepared.result;
  const { existing, portAlloc, initialEnv, notices } = prepared;

  try {
    // Hook context shared across before/after-create.
    const ctxBase = {
      worktreePath: path.join(repoRoot, WORKTREES_DIR, name),
      worktreeName: name,
      branch,
      resourceIndex: portAlloc.resourceIndex,
      ports: portAlloc.ports,
      extraEnv: initialEnv,
      hooksRoot: repoRoot,
    };

    if (!opts.skipHooks) {
      await runHook("before-create", ctxBase);
    }

    // Create git worktree (or attach to existing branch if already present;
    // never with a start point, where a collision falls back to altBranch).
    const freshWorktree = !fs.existsSync(ctxBase.worktreePath);
    const created = await createGitWorktree(repoRoot, name, branch, opts.startPoint, opts.altBranch);
    const worktreePath = created.path;
    ctxBase.branch = created.branch;
    if (created.branch !== branch) {
      // The alternate name won: record it NOW, so a failure in copy or setup
      // leaves a record naming this worktree's own branch (release and heal
      // act on the branch git created, never on the primary's owner).
      writeState(repoRoot, { ...readState(repoRoot, name)!, branch: created.branch, updatedAt: new Date().toISOString() });
    }
    if (seed?.snapshot) {
      // A snapshot start point: turn it back into uncommitted work at once,
      // so the branch never points at the snapshot commit (which carries the
      // laptop's uncommitted files) even when setup fails a moment later.
      gitArgv(worktreePath, ["reset", "-q", "--mixed", seed.seedBase]);
    }

    // Copy gitignored files from main worktree.
    copyWorkspaceFiles(manifest, repoRoot, worktreePath, inputRoot, freshWorktree);

    // Borrow the shared dependency directories before setup runs, so an
    // install in the worktree finds them already there (ct-49541).
    linkSharedDirectories(inputRoot ?? repoRoot, worktreePath, manifest.setup.share);

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
        ? { ...ctxBase, extraEnv: { ...initialEnv, CDP_PORT: String(chrome.cdpPort) } }
        : ctxBase;
      await runHook("after-create", hookCtx);
    }

    // Validate contract and persist final state.
    const ws: Workspace = {
      name,
      path: worktreePath,
      branch: created.branch,
      resourceIndex: portAlloc.resourceIndex,
      manifest,
      ports: portAlloc.ports,
      env: initialEnv,
      state: "ready",
      chrome,
      ...seedFields,
      ...(noPorts ? { noPorts: true } : {}),
    };
    const contract = await validateContract(ws);
    ws.contract = contract;
    ws.state = contract.ok ? "ready" : "broken";
    writeState(repoRoot, workspaceToState(ws));
    return { workspace: ws, created: !existing, notices };
  } catch (err) {
    // Mark broken on failure so subsequent heal can pick up.
    setState(repoRoot, name, "broken");
    throw err;
  }
}

export interface RootCheckoutOptions {
  /** A workspace input snapshot (`stageCloudInputs`): the manifest and the secret files to copy INTO the root, overwriting its gitignored copies. */
  inputRoot?: string;
  skipSetup?: boolean;
  skipBrowser?: boolean;
}

/** `git rev-parse --abbrev-ref HEAD` in a checkout ("HEAD" when detached). */
function currentBranchOf(repoRoot: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Prepare the MAIN checkout as a workspace under the reserved name
 * (ROOT_WORKSPACE_NAME): ports reserved beside every worktree's, the
 * manifest's secret files copied in from the input snapshot (overwriting the
 * root's gitignored copies; the tracked manifest itself is never written
 * into the root), setup run, contract validated. Idempotent: a rerun keeps
 * the resource index and reports `created: false`. `state.branch` is always
 * re-read from the live HEAD — each shared placement checks out a fresh
 * branch, so the record must follow HEAD or `cast ws status` reports the
 * root broken between placements. The backend is forced to "local" and the
 * env carries NO CODECAST_CLOUD_WORKSPACE / BUN_INSTALL_*: the root keeps
 * bun's global store.
 */
export async function acquireRootCheckout(repoRoot: string, opts: RootCheckoutOptions = {}): Promise<AcquireResult> {
  return withWorkspaceOperation(repoRoot, ROOT_WORKSPACE_NAME, () => acquireRootCheckoutUnlocked(repoRoot, opts));
}

async function acquireRootCheckoutUnlocked(repoRoot: string, opts: RootCheckoutOptions): Promise<AcquireResult> {
  const name = ROOT_WORKSPACE_NAME;
  const root = fs.realpathSync(repoRoot);
  const inputRoot = opts.inputRoot ? fs.realpathSync(opts.inputRoot) : undefined;
  const manifest = resolveManifest(repoRoot, inputRoot);
  manifest.backend = "local";
  const branch = currentBranchOf(root);

  const { existing, portAlloc, initialEnv, notices } = await withPortReservations(repoRoot, async (reservations) => {
    const existing = readState(repoRoot, name);
    const { portAlloc, notices } = await allocateWorkspacePorts(
      name, manifest, reservations, root, existing?.resourceIndex ?? 0,
    );
    const initialEnv = buildWorkspaceEnv(manifest, portAlloc.ports);
    if (inputRoot) initialEnv.CODECAST_WORKSPACE_INPUT_ROOT = inputRoot;
    writeState(repoRoot, {
      name,
      path: root,
      branch,
      resourceIndex: portAlloc.resourceIndex,
      state: "creating",
      manifest,
      ports: portAlloc.ports,
      env: initialEnv,
      updatedAt: new Date().toISOString(),
      ...(existing?.chrome ? { chrome: existing.chrome } : {}),
    });
    return { existing, portAlloc, initialEnv, notices };
  });

  try {
    if (inputRoot && inputRoot !== root) copyFiles(manifest, inputRoot, root, { log: () => {}, overwrite: true });
    if (!opts.skipSetup) {
      // The setup log goes under the state dir, not `<root>/.codecast/logs`:
      // the root is a real checkout and an untracked log would dirty it.
      await runSetup(manifest, root, { env: initialEnv, stream: null, logDir: path.join(root, WORKSPACES_STATE_DIR, name, "logs") });
    }
    let chrome: ChromeBinding | undefined = existing?.chrome && isPidAlive(existing.chrome.pid) ? existing.chrome : undefined;
    if (manifest.browser.enabled && !opts.skipBrowser && !chrome) {
      chrome = await launchWorkspaceChrome(repoRoot, name, manifest, portAlloc.resourceIndex);
    }
    if (chrome) {
      initialEnv.CDP_PORT = String(chrome.cdpPort);
      initialEnv.CODECAST_CDP_PORT = String(chrome.cdpPort);
    }
    const ws: Workspace = {
      name,
      path: root,
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
    return { workspace: ws, created: !existing, notices };
  } catch (err) {
    setState(repoRoot, name, "broken");
    throw err;
  }
}

/** Is this state's path the repository root itself (the shared-checkout record)? */
function isRootState(repoRoot: string, state: PersistedWorkspaceState): boolean {
  try {
    return fs.realpathSync(state.path) === fs.realpathSync(repoRoot);
  } catch {
    return state.name === ROOT_WORKSPACE_NAME;
  }
}

/**
 * The root record follows the live HEAD: refresh `state.branch` before any
 * validation, so a checkout that moved between placements is not reported
 * broken. Returns the (possibly rewritten) state.
 */
function refreshRootBranch(repoRoot: string, state: PersistedWorkspaceState, opts: { persist?: boolean } = {}): PersistedWorkspaceState {
  if (state.name !== ROOT_WORKSPACE_NAME) return state;
  let branch: string;
  try {
    branch = currentBranchOf(state.path);
  } catch {
    return state;
  }
  if (branch === state.branch) return state;
  // Persisting is for callers holding the workspace lock (heal); a bare
  // read (status, ls, validate) must not race a `cast ws root` in progress
  // with a stale copy, and reports the file's own timestamp.
  if (!opts.persist) return { ...state, branch };
  const next = { ...state, branch, updatedAt: new Date().toISOString() };
  writeState(repoRoot, next);
  return next;
}

/** Release (tear down) a workspace: stop Chrome, run teardown, remove worktree, drop state. */
export async function releaseWorkspace(repoRoot: string, name: string): Promise<void> {
  return withWorkspaceOperation(repoRoot, name, () => releaseWorkspaceUnlocked(repoRoot, name));
}

async function releaseWorkspaceUnlocked(repoRoot: string, name: string): Promise<void> {
  const state = setState(repoRoot, name, "destroying");
  if (!state) return; // nothing to release

  // Stop Chrome first so it releases its CDP port + user-data-dir handles.
  if (state.chrome?.pid && isPidAlive(state.chrome.pid)) {
    await stopChrome(state.chrome.pid, { timeoutMs: 3000 });
  }

  // Best-effort teardown commands. They are manifest-authored code like the
  // rest, so an unapproved change skips them — refusing the destroy instead
  // would strand the worktree, and teardown already never blocks it (ct-49543).
  const teardownChanged = untrustedTargetIds(repoRoot, {
    hooksRoot: repoRoot,
    hooks: false,
  }).has(TEARDOWN_TARGET_ID);
  if (state.manifest.teardown.run.length > 0 && !teardownChanged) {
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

  // Why first: a shared directory is a symlink git reports as untracked, so
  // removing the worktree while it is there needs --force and a rename into
  // the trash would carry the link along (ct-49541).
  unlinkSharedDirectories(state.path, state.manifest.setup.share);

  if (!isRootState(repoRoot, state)) {
    if (fs.existsSync(state.path)) moveToTrash(state.path);
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot });
    dropSeed(repoRoot, state);
  }

  const stateDir = path.join(repoRoot, WORKSPACES_STATE_DIR, name);
  const retiredDir = path.join(repoRoot, WORKSPACES_STATE_DIR, `_released-${randomUUID()}`);
  await withPortReservations(repoRoot, async () => fs.renameSync(stateDir, retiredDir));
  await fs.promises.rm(retiredDir, { recursive: true, force: true });
  void sweepTrash(path.join(repoRoot, WORKTREES_DIR));
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
  return withWorkspaceOperation(repoRoot, name, () => healWorkspaceUnlocked(repoRoot, name));
}

async function healWorkspaceUnlocked(repoRoot: string, name: string): Promise<Workspace> {
  let state = readState(repoRoot, name);
  if (!state) {
    throw new Error(`workspace '${name}' not found; nothing to heal`);
  }
  // Heal re-runs the manifest's setup commands, so it needs the same approval
  // acquire needed (ct-49543).
  enforceWorkspaceTrust({
    repoRoot,
    hooksRoot: repoRoot,
    manifestRoot: state.env.CODECAST_WORKSPACE_INPUT_ROOT ?? repoRoot,
    hooks: false,
  });
  state = refreshRootBranch(repoRoot, state, { persist: true });
  setState(repoRoot, name, "creating");
  if (!fs.existsSync(state.path) && state.startPoint && state.seedBase && name !== ROOT_WORKSPACE_NAME) {
    await recreateSeededWorktree(repoRoot, name, state.branch, state.startPoint, state.seedBase);
  }
  // Re-copy gitignored files (idempotent) then re-run setup. The root record
  // copies only from a recorded input snapshot (overwriting), never from
  // itself.
  if (name === ROOT_WORKSPACE_NAME) {
    const inputRoot = state.env.CODECAST_WORKSPACE_INPUT_ROOT;
    if (inputRoot && fs.existsSync(inputRoot)) copyFiles(state.manifest, inputRoot, state.path, { log: () => {}, overwrite: true });
  } else {
    copyWorkspaceFiles(state.manifest, repoRoot, state.path, state.env.CODECAST_WORKSPACE_INPUT_ROOT);
  }
  await runSetup(state.manifest, state.path, {
    env: state.env,
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

/**
 * One workspace's record as it stands now: the shared-checkout record's
 * branch is read from the live HEAD (never persisted here), every other
 * record is the file as written. Every read path (status, ls, validate)
 * goes through this so none of them prints a branch the root has left.
 */
export function readWorkspaceState(repoRoot: string, name: string): PersistedWorkspaceState | null {
  const state = readState(repoRoot, name);
  return state && refreshRootBranch(repoRoot, state);
}

/** Validate an existing workspace without mutating it. */
export async function validateWorkspace(
  repoRoot: string,
  name: string,
): Promise<ContractResult> {
  const state = readWorkspaceState(repoRoot, name);
  if (!state) throw new Error(`workspace '${name}' not found`);
  return validateContract(stateToWorkspace(state));
}

/** List all tracked workspaces (including broken ones). */
export function listWorkspaces(repoRoot: string): Workspace[] {
  return listStates(repoRoot).map((state) => stateToWorkspace(refreshRootBranch(repoRoot, state)));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function copyWorkspaceFiles(
  manifest: WorkspaceManifest,
  repoRoot: string,
  worktreePath: string,
  inputRoot?: string,
  freshWorktree = false,
): void {
  copyFiles(manifest, inputRoot ?? repoRoot, worktreePath, { log: () => {} });
  if (!inputRoot) return;
  const source = path.join(inputRoot, MANIFEST_REL_PATH);
  const dest = path.join(worktreePath, MANIFEST_REL_PATH);
  if (fs.existsSync(source) && (freshWorktree || !fs.existsSync(dest))) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
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
    ...(ws.noPorts ? { noPorts: true } : {}),
    ...(ws.startPoint ? { startPoint: ws.startPoint } : {}),
    ...(ws.seedBase ? { seedBase: ws.seedBase } : {}),
  };
}

async function allocateWorkspacePorts(
  name: string,
  manifest: WorkspaceManifest,
  reservations: PortReservation[],
  root: string,
  startIndex: number,
) {
  const notices: string[] = [];
  const { live: holders, stale } = partitionReservations(reservations.filter(
    (reservation) => reservation.repoRoot !== root || reservation.workspace.name !== name,
  ));
  if (stale.length > 0) notices.push(
    `reclaimed ${stale.length} port slot(s) from workspaces whose worktree is gone: ` +
    stale.map(({ reservation, reason }) => `${reservation.workspace.name} (${reason})`).join(", "),
  );
  const reservedPorts = new Set(holders.flatMap(({ workspace }) => Object.values(workspace.ports)));
  const portAlloc = await allocatePorts(manifest, { startIndex, reservedPorts }).catch((error) => {
    if (error instanceof PortAllocationError) error.message = describePortExhaustion(name, manifest, error, holders, root);
    throw error;
  });
  const extended = portAlloc.extendedRange;
  if (extended) notices.push(
    `port pool of ${extended.poolSize} indices exhausted; extended the range to indices ` +
    `${extended.from}-${extended.to} and took index ${portAlloc.resourceIndex} ` +
    `(${Object.entries(portAlloc.ports).map(([n, p]) => `${n}=${p}`).join(" ")})`,
  );
  return { portAlloc, notices };
}

function describePortExhaustion(
  name: string,
  manifest: WorkspaceManifest,
  error: PortAllocationError,
  holders: PortReservation[],
  root: string,
): string {
  const searched = error.searched ?? { from: 0, to: 0 };
  const candidates = new Set<number>();
  for (let i = searched.from; i <= searched.to; i++) {
    for (const port of Object.values(computePorts(manifest, i))) candidates.add(port);
  }
  const named = holders
    .map((holder) => {
      const ports = Object.entries(holder.workspace.ports).filter(([, port]) => candidates.has(port));
      if (ports.length === 0) return null;
      const where = holder.repoRoot === root ? "" : ` [${holder.repoRoot}]`;
      return `${holder.workspace.name} (${ports.map(([n, p]) => `${n}=${p}`).join(" ")})${where}`;
    })
    .filter((line): line is string => line !== null)
    .sort();
  const shown = named.slice(0, 10);
  const rest = named.length - shown.length;
  const heldBy = named.length > 0
    ? `held by: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`
    : `no workspace holds them, so another process on this machine is listening on them`;
  return (
    `no free port for workspace '${name}': every port for indices ${searched.from}-${searched.to} is taken. ` +
    `${heldBy}. ` +
    `Free one with \`cast ws destroy <name>\`, or run \`cast ws acquire ${name} --no-ports\` ` +
    `if this workspace needs no dev server.`
  );
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

function gitArgv(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Git's stderr for a failed argv call, and the line worth reporting (the `fatal:`/`error:` one, else the last). */
function gitFailure(err: unknown): { all: string; line: string } {
  const e = err as { stderr?: string | Buffer; message?: string };
  const all = (e.stderr?.toString() || e.message || String(err)).trim();
  const lines = all.split("\n").map((l) => l.trim()).filter(Boolean);
  return { all, line: lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "git failed" };
}

function firstStderrLine(err: unknown): string {
  return gitFailure(err).line;
}

/** `git rev-parse --verify <rev>^{commit}` in the repo, or a throw naming the rev. */
function resolveCommit(repoRoot: string, rev: string): string {
  try {
    return gitArgv(repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`]);
  } catch (err) {
    throw new Error(`cannot resolve ${rev}: ${firstStderrLine(err)}`);
  }
}

/**
 * The seed fields for a start point. A WIP snapshot commit (its subject is
 * the snapshot marker) seeds the worktree at its PARENT with the snapshot's
 * tree as uncommitted work, so the base is the parent; any other commit-ish
 * is the base itself (the branch is simply created there).
 */
function seedFieldsFor(repoRoot: string, startPoint: string): { startPoint: string; seedBase: string; snapshot: boolean } {
  const commit = resolveCommit(repoRoot, startPoint);
  const snapshot = gitArgv(repoRoot, ["log", "-1", "--format=%s", commit]) === WIP_SNAPSHOT_SUBJECT;
  return { startPoint, seedBase: snapshot ? resolveCommit(repoRoot, `${commit}^`) : commit, snapshot };
}

/** The tip of refs/heads/<branch>, or null when the branch does not exist. */
function branchTip(repoRoot: string, branch: string): string | null {
  try {
    return gitArgv(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]) || null;
  } catch {
    return null;
  }
}

/** The hidden seed ref namespace (cloud/transfer.ts CLOUD_SEED_REF_PREFIX). */
const SEED_REF_PREFIX = "refs/codecast/cloud/";

/**
 * After a seeded worktree is removed: drop its hidden seed ref, and the
 * branch when its tip still equals the seed base (nothing host-made to lose;
 * a branch that advanced deliberately keeps its unpublished commits). Best
 * effort — a release must not fail on cleanup.
 */
function dropSeed(repoRoot: string, state: PersistedWorkspaceState): void {
  if (!state.startPoint?.startsWith(SEED_REF_PREFIX)) return;
  // A branch still AT the snapshot commit (creation failed before the reset)
  // holds nothing host-made either: only the laptop's tree, which the laptop has.
  let snapshot: string | null = null;
  try { snapshot = resolveCommit(repoRoot, state.startPoint); } catch { /* ref already gone */ }
  try { gitArgv(repoRoot, ["update-ref", "-d", state.startPoint]); } catch { /* already gone */ }
  const tip = branchTip(repoRoot, state.branch);
  if (state.seedBase && tip !== null && (tip === state.seedBase || tip === snapshot)) {
    try { gitArgv(repoRoot, ["branch", "-D", state.branch]); } catch { /* checked out elsewhere, or gone */ }
  }
}

/**
 * Rebuild a seeded worktree whose directory is gone (heal). Its branch may
 * still exist (a pruned worktree keeps its branch): then the worktree is
 * attached to THAT branch — its own — and, when the tip is still the seed
 * base, the laptop's uncommitted work is materialised again from the seed
 * ref; a branch that advanced keeps its tree as committed. Without the
 * branch it is created afresh at the start point and reset to the base.
 */
async function recreateSeededWorktree(repoRoot: string, name: string, branch: string, startPoint: string, seedBase: string): Promise<void> {
  const worktreePath = path.join(repoRoot, WORKTREES_DIR, name);
  try { gitArgv(repoRoot, ["worktree", "prune"]); } catch { /* nothing to prune */ }
  const tip = branchTip(repoRoot, branch);
  if (tip === null) {
    await createGitWorktree(repoRoot, name, branch, startPoint);
    gitArgv(worktreePath, ["reset", "-q", "--mixed", seedBase]);
    return;
  }
  gitArgv(repoRoot, ["worktree", "add", worktreePath, branch]);
  if (tip === seedBase) {
    gitArgv(worktreePath, ["read-tree", "-u", "--reset", startPoint]);
    gitArgv(worktreePath, ["reset", "-q", "--mixed", seedBase]);
  }
}

/**
 * Create a git worktree at the conventional location. Argv-only: branch
 * names are cross-machine user data (a laptop's branch seeds the host's).
 *
 * With a start point the worktree is created at that commit on a NEW branch,
 * never attached to an existing branch or directory: an existing directory is
 * an error, and when git itself reports the branch already exists the
 * alternate name is tried once (git's ref creation is atomic, so two
 * concurrent preparers cannot both win the primary name). Any other failure,
 * or a second collision, rethrows with git's first stderr line.
 *
 * Without a start point: today's behaviour — an existing directory is
 * assumed to be a previous creation, and an existing branch is attached to.
 *
 * Async because the warm pool warms slots through acquireWorkspace on the
 * daemon's timer: a synchronous `git worktree add` on a repo this size freezes
 * delivery, injection and the heartbeat for the seconds it runs (ct-49540).
 */
async function createGitWorktree(repoRoot: string, name: string, branch: string, startPoint?: string, altBranch?: string): Promise<{ path: string; branch: string }> {
  const worktreeDir = path.join(repoRoot, WORKTREES_DIR);
  const worktreePath = path.join(worktreeDir, name);
  await fs.promises.mkdir(worktreeDir, { recursive: true });

  if (startPoint) {
    if (fs.existsSync(worktreePath)) throw new Error(`worktree directory ${worktreePath} already exists`);
    const add = (b: string) => execFileAsync("git", ["worktree", "add", "-b", b, worktreePath, startPoint], { cwd: repoRoot, encoding: "utf-8" });
    try {
      await add(branch);
      return { path: worktreePath, branch };
    } catch (err) {
      const { all, line } = gitFailure(err);
      if (!altBranch || !/already exists|cannot lock ref/i.test(all)) throw new Error(`git worktree add -b ${branch}: ${line}`);
      try {
        await add(altBranch);
        return { path: worktreePath, branch: altBranch };
      } catch (err2) {
        throw new Error(`git worktree add -b ${altBranch}: ${firstStderrLine(err2)}`);
      }
    }
  }

  if (fs.existsSync(worktreePath)) {
    // Already exists — assume previous successful creation. Ensure branch matches.
    return { path: worktreePath, branch };
  }

  // Try create-new-branch path first; fall back to attaching to existing branch.
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: repoRoot,
    });
  } catch {
    // Branch may already exist (e.g., from a previous broken attempt).
    await execFileAsync("git", ["worktree", "add", worktreePath, branch], {
      cwd: repoRoot,
    });
  }
  return { path: worktreePath, branch };
}
