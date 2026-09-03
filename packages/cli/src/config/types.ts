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

import type { AgentClientId, VaultInfo } from "@codecast/shared/contracts";

/** How aggressively a client skips approval prompts. Codex is the only client
 *  with a distinct `full_auto`; the others use `default`/`bypass`, but the union
 *  is shared so the map can be keyed openly by client id. */
export type AgentPermissionMode = "default" | "full_auto" | "bypass";

/** Per-client permission mode overrides, keyed by client id so an Nth client is a
 *  map entry rather than a new named field. */
export type AgentPermissionModes = Partial<Record<AgentClientId, AgentPermissionMode>>;

/** Per-client extra default CLI params (flag name → value), keyed by client id. */
export type AgentDefaultParams = Partial<Record<AgentClientId, Record<string, string>>>;

export interface Config {
  // --- Identity / auth (all three writers) ---
  auth_token?: string;
  user_id?: string;
  team_id?: string;
  convex_url?: string;
  web_url?: string;

  // --- Working-tree snapshots (daemon.ts sweepWipSnapshots) ---
  // Publish each session's working tree to a hidden ref on its own git remote so
  // a session reparented onto another machine arrives with its uncommitted work
  // (see wipSnapshot.ts). Default ON. Set false to stop this machine pushing
  // snapshots entirely — for a machine whose repos shouldn't receive them, or to
  // silence the loop without unwinding the code.
  wip_snapshots_enabled?: boolean;

  // --- Device identity ---
  // Explicit name for THIS machine, replacing the derived "macOS - <hostname>".
  // Set it on a provisioned box whose hostname is a UUID (a Scaleway Mac reads as
  // "macOS - 36563bd2-..." otherwise). Read by deviceLabel() in remote/device.ts;
  // CODECAST_DEVICE_LABEL overrides it for one-off runs.
  device_label?: string;

  // --- Sync scope ---
  // Cursor chat sync (`cast cursor on|off`). Unset = auto: on where the OS
  // doesn't gate app data, and on macOS only once a prior run recorded the
  // TCC grant — the daemon never triggers the "access data from other apps"
  // prompt at login on its own (see cursorWatcherDecision).
  cursor_sync?: "on" | "off";
  excluded_paths?: string;
  sync_mode?: "all" | "selected";
  sync_projects?: string[];

  // --- Stable-context mode ---
  stable_mode?: "solo" | "team";
  stable_global?: boolean;
  team_share_mode?: "full" | "summary";

  // --- Agent invocation ---
  // Per-client launch args. `agent_args` is the open map keyed by client id, so a
  // fifth client can pass launch args without a schema change. The named
  // `claude_args`/`codex_args` below are the pre-map fields, kept only so configs
  // written before the map still parse and launch. ALWAYS read through
  // `getAgentArgs()`, which prefers the map and falls back to the named fields.
  agent_args?: Partial<Record<AgentClientId, string>>;
  /** @deprecated pre-map field; read via `getAgentArgs(config, "claude")`. */
  claude_args?: string;
  /** @deprecated pre-map field; read via `getAgentArgs(config, "codex")`. */
  codex_args?: string;
  agent_permission_modes?: AgentPermissionModes;
  agent_default_params?: AgentDefaultParams;

  // Managed provider API keys (pl-207) live in their OWN 0600 file
  // (~/.codecast/provider-keys.json, see providerKeyStore.ts) — NOT here — because
  // config.json carries device-specific fields that must not travel between
  // machines, whereas the key store is a per-user secret that syncs device→device.

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
  publish_enabled?: boolean;
  publish_version?: string;
  state_enabled?: boolean;
  state_version?: string;
  // Forks was the one snippet whose flags never made it into this type, so
  // every write to them went through `(config as any)` and a typo would have
  // silently minted a new key instead of failing to compile.
  forks_enabled?: boolean;
  forks_version?: string;
  decide_enabled?: boolean;
  decide_version?: string;
  browser_enabled?: boolean;
  browser_version?: string;
  // Machine-wide site allowlist for `cast browser` — origins agents may
  // navigate to, unioned with any project list in .codecast/workspace.toml
  // [browser].allow. Undefined = no policy. See browser/policy.ts.
  browser_allow?: string[];
  // Automatic failure context for `cast browser` steps (console errors, failed
  // requests, screenshot printed when a step fails). "off" disables it
  // machine-wide; anything else (or unset) leaves it on. Set via
  // `cast config browser_capture off`; `--no-capture` overrides per command.
  browser_capture?: string;
  chat_enabled?: boolean;
  chat_version?: string;
  calls_enabled?: boolean;
  calls_version?: string;
  limits_enabled?: boolean;
  limits_version?: string;
  // Last heartbeat-reported availability of team-gated snippets (chat, calls),
  // keyed by slug: whether any of this user's teams has the feature on. The
  // daemon installs/disables the snippet when this CHANGES (never on every
  // beat, so a hand `--disable` sticks until the team flips again); the
  // install wizard skips a snippet known to be off for every team.
  snippet_availability?: Record<string, boolean>;

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

  // --- Fleet cap (daemon.ts, hibernation.ts) ---
  // How many sessions may hold a live pane on this machine. Past the cap the
  // heartbeat maintenance pass parks the longest-idle ones: the reaper's
  // teardown, the transcript kept, the agent status set to "hibernated", and
  // the next message resumes it. 0 or absent = no cap.
  max_live_sessions?: number;
  // A session awake and idle for this long is parked whatever the fleet size.
  // The clock is awake idle time (machine sleep excluded), which the resource
  // monitor only measures on macOS, so on other platforms only the cap above
  // does anything. 0 or absent = no idle bar. Both knobs are read from the
  // cached config, so a change takes effect on the next pass, not instantly.
  hibernate_idle_ms?: number;

  // --- OpenCode rich transport (daemon.ts, opencodeServer.ts) ---
  // The optional `opencode serve` sidecar the daemon attaches to for opencode's
  // fork-by-id API and live SSE state (opencodeServer.ts). Absent → default ON
  // wherever the opencode binary is present (the transport self-disables when the
  // binary is missing, mirroring codex's app-server). Set `enabled: false` to force
  // the plain DB-polling path; set `port` to pin the sidecar (0/omitted =
  // OS-chosen, self-discovered from the server's announce line).
  opencode_server?: { enabled?: boolean; port?: number };

  // --- Browser (`cast browser`, browser/autoShot.ts) ---
  // Automatic screenshots after page-changing browser commands, so a browsing
  // thread self-documents. Absent → ON; `cast browser shots off` sets false.
  browser?: { auto_shots?: boolean };

  // --- Vaults (index.ts `cast vault`, daemon /vault/* routes) ---
  // Directories of markdown the user registered for browsing over the loopback
  // bridge. Managed through vault/vaultRegistry.ts — never hand-edited elsewhere,
  // since the id is derived from the root path.
  vaults?: VaultInfo[];
  /** Project roots the user removed from the vault picker. Discovery would
   *  otherwise re-offer them on the next listing — `cast vault rm` has to mean
   *  something for a vault nobody added by hand. */
  vaults_hidden?: string[];

  // --- Server-stamped bookkeeping (index.ts) ---
  created_at?: string;
  updated_at?: string;
}

/**
 * The launch args a user configured for one client, honoring back-compat. Reads
 * the open `agent_args` map first, then falls back to the deprecated named fields
 * (`claude_args`/`codex_args`) so configs predating the map keep launching. An
 * explicit map entry wins even when empty ("" means "no extra args", NOT "fall back
 * to the legacy field"). Returns undefined when nothing is configured.
 *
 * This is the ONE place the legacy fields are read; every launch/resume path routes
 * through here, so onboarding an Nth client is a map entry, not another named field.
 */
export function getAgentArgs(
  config: Config | null | undefined,
  clientId: AgentClientId,
): string | undefined {
  const fromMap = config?.agent_args?.[clientId];
  if (fromMap !== undefined) return fromMap;
  if (clientId === "claude") return config?.claude_args;
  if (clientId === "codex") return config?.codex_args;
  return undefined;
}

/**
 * Whether the daemon should stand up the opencode rich-transport sidecar. Default
 * ON (mirrors the codex app-server, which is unconditionally instantiated) — the
 * transport disables itself at runtime when the opencode binary is missing, so the
 * only reason to set `enabled: false` is to force the plain DB-polling path.
 */
export function isOpencodeServerEnabled(config: Config | null | undefined): boolean {
  return config?.opencode_server?.enabled !== false;
}

/** The pinned sidecar port, or 0 to let the OS choose (self-discovered at boot). */
export function opencodeServerPort(config: Config | null | undefined): number {
  const p = config?.opencode_server?.port;
  return typeof p === "number" && Number.isInteger(p) && p > 0 ? p : 0;
}
