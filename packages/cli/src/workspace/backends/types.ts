/**
 * SandboxBackend interface — the abstraction that lets `cast workspace`
 * dispatch the same lifecycle across local worktrees, cloud sandboxes
 * (Modal/E2B/Daytona/Fly), or future backends.
 *
 * Design rules:
 *   - The interface is the lowest common denominator. Each backend may add
 *     internal optimizations (e.g., the local backend uses git worktrees) as
 *     long as the contract holds.
 *   - All operations are addressed by `(repoRoot, workspaceName)`. The
 *     backend is responsible for tracking how that name maps to its
 *     substrate (a path on disk, a remote sandbox id, ...).
 *   - exec/readFile/writeFile exist for cross-substrate workflows
 *     (e.g., agent reads code from a remote sandbox via the local CLI).
 */

import type {
  AcquireOptions,
  ContractResult,
  Workspace,
} from "../types.js";

export interface ExecOptions {
  /** Working directory relative to the workspace root. */
  cwd?: string;
  /** Extra env vars. Merged with the workspace's manifest env. */
  env?: Record<string, string>;
  /** Max execution time. Default: no timeout. */
  timeoutMs?: number;
  /** Stdin to send to the process. */
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/** Bytes returned from readFile / accepted by writeFile. */
export type FileContent = Buffer | string;

export interface SandboxBackend {
  /** Stable identifier (e.g., "local", "modal", "e2b"). */
  readonly name: string;

  /** Create or attach to a workspace. */
  acquire(
    repoRoot: string,
    name: string,
    opts?: AcquireOptions,
  ): Promise<Workspace>;

  /** Tear down a workspace fully. */
  release(repoRoot: string, name: string): Promise<void>;

  /** Re-run setup to recover a broken workspace. */
  heal(repoRoot: string, name: string): Promise<Workspace>;

  /** Validate a workspace meets the contract without mutating it. */
  validate(repoRoot: string, name: string): Promise<ContractResult>;

  /** List workspaces tracked under this backend. */
  list(repoRoot: string): Promise<Workspace[]>;

  /** Execute a shell command inside the workspace. */
  exec(
    repoRoot: string,
    name: string,
    command: string,
    opts?: ExecOptions,
  ): Promise<ExecResult>;

  /** Read a file at a path relative to the workspace root. */
  readFile(
    repoRoot: string,
    name: string,
    relativePath: string,
  ): Promise<Buffer>;

  /** Write a file at a path relative to the workspace root. */
  writeFile(
    repoRoot: string,
    name: string,
    relativePath: string,
    content: FileContent,
  ): Promise<void>;
}

/** Acquire result type used at the lifecycle layer (above the backend). */
export interface AcquireBackendResult {
  workspace: Workspace;
  /** True if a new workspace was created; false if attached to existing. */
  created: boolean;
}

/**
 * Registry of available backends, keyed by name. The default registry has
 * {local: LocalBackend}. C2 will wire CLI selection through this.
 */
export interface BackendRegistry {
  register(backend: SandboxBackend): void;
  get(name: string): SandboxBackend;
  has(name: string): boolean;
  list(): string[];
}
