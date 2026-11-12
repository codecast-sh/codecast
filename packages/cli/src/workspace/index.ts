/**
 * Workspace public API.
 *
 * Implementations land in subsequent tasks. For now this file declares the
 * surface so callers (CLI, daemon, tests) can depend on stable signatures
 * while the underlying modules are being built.
 */

export * from "./types.js";
export { resolveManifest, mergeManifests, MANIFEST_REL_PATH } from "./resolver.js";
export { detectProject } from "./detect.js";
export { parseManifest, parseManifestText, ManifestError } from "./manifest.js";
export {
  allocatePorts,
  computePorts,
  isPortFree,
  portsToEnv,
  PortAllocationError,
  type AllocateOptions,
  type PortAllocation,
} from "./ports.js";
export { copyFiles, type CopyOptions, type CopyResult } from "./copy.js";
export {
  runSetup,
  SetupError,
  type RunSetupOptions,
  type SetupResult,
  type SetupPhase,
} from "./setup.js";
export {
  runHook,
  buildHookEnv,
  HookError,
  HOOKS_DIR,
  type HookContext,
  type HookResult,
} from "./hooks.js";
export {
  validateContract,
  readState,
  writeState,
  setState,
  deleteState,
  listStates,
  WORKSPACES_STATE_DIR,
  type PersistedWorkspaceState,
} from "./contract.js";
export {
  acquireWorkspace,
  releaseWorkspace,
  healWorkspace,
  validateWorkspace,
  listWorkspaces,
  type AcquireResult,
} from "./lifecycle.js";
export {
  launchChrome,
  stopChrome,
  findChromeBinary,
  chromeBinaryProbes,
  isPidAlive,
  ChromeNotFoundError,
  ChromeLaunchError,
  type ChromeInstance,
  type LaunchChromeOptions,
} from "./chrome.js";
export {
  type SandboxBackend,
  type ExecOptions,
  type ExecResult,
  type FileContent,
  type BackendRegistry,
} from "./backends/types.js";
export { LocalBackend } from "./backends/local.js";
export { defaultRegistry, getBackend } from "./backends/registry.js";

import type {
  AcquireOptions,
  ContractResult,
  Workspace,
} from "./types.js";

/**
 * Create or attach to a workspace by name. If the worktree already exists,
 * re-validates the contract and either returns a ready Workspace or heals it.
 */
export async function acquire(
  _repoRoot: string,
  _name: string,
  _opts?: AcquireOptions,
): Promise<Workspace> {
  throw new Error("workspace.acquire not yet implemented");
}

/** Tear down a workspace: remove worktree, release ports, stop isolated services. */
export async function release(_repoRoot: string, _name: string): Promise<void> {
  throw new Error("workspace.release not yet implemented");
}

/** Idempotently re-run setup to recover a broken workspace. */
export async function heal(_repoRoot: string, _name: string): Promise<Workspace> {
  throw new Error("workspace.heal not yet implemented");
}

/** Validate an existing workspace against the contract without mutating it. */
export async function validate(_repoRoot: string, _name: string): Promise<ContractResult> {
  throw new Error("workspace.validate not yet implemented");
}

/** List all workspaces tracked for a repo, including broken ones. */
export async function list(_repoRoot: string): Promise<Workspace[]> {
  throw new Error("workspace.list not yet implemented");
}

