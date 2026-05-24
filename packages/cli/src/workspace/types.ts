/**
 * Workspace abstraction: declarative description of how to make a git worktree
 * into a fully prepared environment that meets the workspace contract.
 *
 * Three-layer architecture:
 *   1. Detection      — heuristic inference of common project types
 *   2. Manifest       — declarative .codecast/workspace.toml overrides
 *   3. Hooks          — arbitrary scripts in .codecast/hooks/*.sh
 */

/**
 * A named port allocated per worktree.
 * Actual port = base + (resourceIndex * range).
 * Set range >= 100 so adjacent workspaces don't collide on neighboring ports.
 */
export interface PortSpec {
  base: number;
  range: number;
}

/** How a workspace relates to a background service like postgres or redis. */
export type ServiceMode = "shared" | "isolated";

export interface ServiceSpec {
  /** "shared": use a single instance across workspaces; "isolated": one per worktree. */
  mode: ServiceMode;
  /** Command to start the service. Required when mode=isolated. */
  start?: string;
  /** Command to stop the service. Required when mode=isolated. */
  stop?: string;
  /** URL of the shared instance. Used (and required) when mode=shared. */
  url?: string;
  /** Probe to verify readiness. Examples: "tcp:5432", "http:8080/health". */
  readyCheck?: string;
  /** Reference to a named port (e.g., "$PORT_DB") for isolated services. */
  port?: string;
  /** Max seconds to wait for readyCheck. Default 30. */
  readyTimeoutSec?: number;
}

/** Commands to run during workspace setup. Run in worktree CWD with manifest env. */
export interface SetupSpec {
  /** Gitignored files to copy from main worktree (e.g., ".env", ".env.local"). */
  copy: string[];
  /** Install dependencies (e.g., ["bun install"]). */
  install: string[];
  /** Code generation (e.g., ["prisma generate", "bun run codegen"]). */
  generate: string[];
  /** Migrations / seed data (e.g., ["bun run db:migrate"]). */
  migrate: string[];
}

/** Commands to run when workspace is destroyed. */
export interface TeardownSpec {
  run: string[];
}

/**
 * Per-workspace browser configuration. When enabled, a headless Chromium is
 * launched after setup completes and torn down at release. The CDP port is
 * allocated via the named-port system using `cdp_port` (default base=9222
 * range=100), so workspaces at resource index 0, 1, 2 get ports 9222, 9322,
 * 9422 by default.
 */
export interface BrowserSpec {
  /** Whether the workspace needs its own Chromium instance. */
  enabled: boolean;
  /** Run Chrome headless? Default true. */
  headless: boolean;
  /** Named port spec for CDP. Defaults to {base:9222, range:100}. */
  cdpPort: PortSpec;
}

/**
 * Full workspace manifest: the complete declarative description of how to
 * prepare a worktree. Produced by detection, optionally overridden by a
 * .codecast/workspace.toml file, optionally overridden again by env vars.
 */
export interface WorkspaceManifest {
  setup: SetupSpec;
  /** Named ports keyed by short name (e.g., "web", "api", "db"). */
  ports: Record<string, PortSpec>;
  /** Background services keyed by short name. */
  services: Record<string, ServiceSpec>;
  /** Static env vars exported into every command and hook. */
  env: Record<string, string>;
  teardown: TeardownSpec;
  /** Per-workspace browser configuration (off by default). */
  browser: BrowserSpec;
  /**
   * Sandbox backend name. Defaults to "local" (git worktree on this machine).
   * Other values map to entries in the BackendRegistry (e.g., "modal",
   * "e2b", "daytona"); unknown values throw with a clear error.
   */
  backend: string;
  /** Detected project-type label (e.g., "bun", "uv", "cargo"). For diagnostics. */
  detected?: string;
}

/** Lifecycle hook names; resolved to .codecast/hooks/<name>.sh on disk. */
export type HookName =
  | "before-create"
  | "after-create"
  | "before-agent"
  | "after-agent"
  | "before-merge"
  | "after-merge";

/** Possible states of a workspace, persisted in .codecast/workspaces/<name>/state.json. */
export type WorkspaceState =
  | "creating"
  | "ready"
  | "broken"
  | "destroying";

/** Outcome of a single contract check. */
export interface ContractCheck {
  /** Short identifier (e.g., "worktree-exists", "node_modules", "port:web"). */
  name: string;
  ok: boolean;
  /** Human-readable reason, present when ok=false. */
  reason?: string;
}

/** Result of validating the full workspace contract. */
export interface ContractResult {
  ok: boolean;
  checks: ContractCheck[];
}

/**
 * A workspace: a fully prepared git worktree that meets the workspace contract.
 *
 * Contract guarantees when state="ready":
 *   - CWD at `path` resolves to the worktree root
 *   - Git branch is checked out at `branch`
 *   - manifest.setup.install/generate/migrate commands ran successfully
 *   - All named ports allocated, free, and present in env as PORT_<NAME>
 *   - All declared env vars present in env
 *   - All required services running and reachable
 */
/** Browser process bound to a workspace, when manifest.browser.enabled=true. */
export interface ChromeBinding {
  /** OS process id of the spawned Chromium. */
  pid: number;
  /** CDP port the instance listens on. */
  cdpPort: number;
  /** Per-workspace user-data-dir. */
  userDataDir: string;
  /** Whether --headless=new was used. */
  headless: boolean;
}

export interface Workspace {
  /** Workspace name (e.g., "fix-auth-bug"). Unique within a repo. */
  name: string;
  /** Absolute path to the worktree root. */
  path: string;
  /** Git branch checked out in the worktree. */
  branch: string;
  /** Index used for port allocation (0..9). */
  resourceIndex: number;
  /** Resolved manifest snapshot used during creation. */
  manifest: WorkspaceManifest;
  /** Computed named ports: name → actual port number. */
  ports: Record<string, number>;
  /** Computed env vars including CODECAST_* and PORT_<NAME>. */
  env: Record<string, string>;
  /** Current state. */
  state: WorkspaceState;
  /** Last contract validation, when available. */
  contract?: ContractResult;
  /** Chrome instance bound to this workspace, if browser.enabled. */
  chrome?: ChromeBinding;
}

/** Options accepted by acquire(). */
export interface AcquireOptions {
  /** Override branch name (default: `codecast/<name>`). */
  branch?: string;
  /** Override resource index (default: auto-allocated). */
  resourceIndex?: number;
  /** Skip install/generate/migrate (assume already done). */
  skipSetup?: boolean;
  /** Skip running hooks. */
  skipHooks?: boolean;
  /**
   * Skip Chrome launch even if manifest.browser.enabled. Used by the warm
   * pool: the pool pre-warms WITHOUT a browser, and Chrome is launched at
   * claim time so it inherits the renamed workspace path.
   */
  skipBrowser?: boolean;
  /**
   * Skip the warm-pool fast path entirely. Used internally by the pool
   * itself during pre-warm (to avoid infinite recursion) and by callers that
   * want to force fresh setup for whatever reason.
   */
  skipPool?: boolean;
}

/**
 * Backwards-compatible shape matching daemon.ts WorktreeResult.
 * A Workspace can be projected to this for legacy callers.
 */
export interface WorktreeResultCompat {
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  portIndex: number;
}

/** Project a Workspace to the legacy WorktreeResult shape. */
export function toWorktreeResult(ws: Workspace): WorktreeResultCompat {
  return {
    worktreePath: ws.path,
    worktreeName: ws.name,
    worktreeBranch: ws.branch,
    portIndex: ws.resourceIndex,
  };
}
