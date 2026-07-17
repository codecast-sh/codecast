/**
 * The single source of truth for the on-disk `~/.codecast/config.json` shape.
 *
 * Two processes write this file through what used to be three separately-declared
 * `Config` interfaces — daemon.ts, index.ts, and claudeWrapper.ts. They had
 * drifted (daemon carried `project_mappings`/`warm_pool_size`, index carried the
 * feature `*_enabled`/`*_version` flags and `created_at`/`updated_at`, the wrapper
 * only knew the three auth fields). Because all three read and write the SAME
 * file, the real shape is the UNION of every field any writer can produce. This
 * module declares that union once so every reader sees a faithful superset and no
 * writer can quietly strip a field another process depends on.
 *
 * Every field is optional: the file is built incrementally across `cast auth`,
 * onboarding, feature toggles, and server round-trips, so any subset may be
 * present on disk at a given moment.
 */

/** Per-agent permission mode overrides (how aggressively to skip approval prompts). */
export interface AgentPermissionModes {
  claude?: "default" | "bypass";
  codex?: "default" | "full_auto" | "bypass";
  gemini?: "default" | "bypass";
}

/** Per-agent extra default CLI params, keyed by flag name. */
export interface AgentDefaultParams {
  claude?: Record<string, string>;
  codex?: Record<string, string>;
  gemini?: Record<string, string>;
  cursor?: Record<string, string>;
}

export interface Config {
  // --- Identity / auth (all three writers) ---
  auth_token?: string;
  user_id?: string;
  team_id?: string;
  convex_url?: string;
  web_url?: string;

  // --- Device identity ---
  // Explicit name for THIS machine, replacing the derived "macOS - <hostname>".
  // Set it on a provisioned box whose hostname is a UUID (a Scaleway Mac reads as
  // "macOS - 36563bd2-..." otherwise). Read by deviceLabel() in remote/device.ts;
  // CODECAST_DEVICE_LABEL overrides it for one-off runs.
  device_label?: string;

  // --- Sync scope ---
  excluded_paths?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];

  // --- Stable-context mode ---
  stable_mode?: "solo" | "team";
  stable_global?: boolean;
  team_share_mode?: "full" | "summary";

  // --- Agent invocation ---
  claude_args?: string;
  codex_args?: string;
  agent_permission_modes?: AgentPermissionModes;
  agent_default_params?: AgentDefaultParams;

  // --- Update behavior ---
  // index.ts wrote `auto_update`; daemon.ts wrote `desktop_auto_update` (opt out of
  // the daemon updating the desktop app out-of-band, default: on). Both are real
  // writers of this same file, so both fields live here.
  auto_update?: boolean;
  desktop_auto_update?: boolean;

  // --- Feature toggles + installed versions (written by index.ts onboarding) ---
  memory_enabled?: boolean;
  memory_version?: string;
  task_enabled?: boolean;
  task_version?: string;
  work_enabled?: boolean;
  work_version?: string;
  plan_enabled?: boolean;
  plan_version?: string;
  workflow_enabled?: boolean;
  workflow_version?: string;
  messaging_enabled?: boolean;
  messaging_version?: string;
  visual_enabled?: boolean;
  visual_version?: string;
  orch_enabled?: boolean;
  orch_version?: string;

  // --- Cross-machine project-path resolution (daemon.ts) ---
  // Explicit project-path overrides for resuming sessions/forks recorded on another
  // machine. Keys are the recorded (remote) project path OR its basename; values are
  // the local directory to resume in. Authoritative — checked before the learned map
  // and the convention search in resolveLocalRepo, and never auto-clobbered.
  project_mappings?: Record<string, string>;

  // --- Warm pool (daemon.ts) ---
  // Tier 3 "warm pool": proactively re-resume up to N most-recently-active sessions
  // whose agent died unexpectedly while the conversation was still hot. 0 (default)
  // disables it — re-warming is speculative, so it's opt-in.
  warm_pool_size?: number;

  // --- Server-stamped bookkeeping (index.ts) ---
  created_at?: string;
  updated_at?: string;
}
