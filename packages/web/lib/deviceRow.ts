// A machine as the devices feed sends it, with no UI attached, so logic that
// only needs its shape (managed policy, the phone) can import it without the
// device badge's components.
export type Device = {
  device_id: string;
  label: string;
  /** A name set in Settings. Absent means the automatic name from the hostname. */
  display_name?: string | null;
  /** A team-icon token, and its color. Absent means the platform glyph. */
  icon?: string | null;
  icon_color?: string | null;
  platform: string;
  /** Heartbeat-reported machine name. Only ever a placeholder for ssh_host. */
  hostname?: string;
  /** User-set SSH target (Settings → Devices); absent = no way to reach it. */
  ssh_host?: string;
  last_seen: number;
  is_remote: boolean;
  local_project_roots: string[];
  /** Teams this machine is open to (Settings > Machines); teammates there may
   *  start sessions on it. Empty or absent = private. */
  shared_team_ids?: string[];
  /** The team that manages it through an MDM, or whose admins removed it (devices.listDevices). */
  managed?: { team_id: string; team_name: string; state: "managed" | "removed"; at: number };
  /** Installed agent-feature snippets (by slug) + stable mode, heartbeat-reported. */
  settings?: {
    snippets?: Record<string, boolean>;
    stable_mode?: "solo" | "team" | "off";
    stable_global?: boolean;
    /** Codecast's Claude Code hooks installed here; absent from daemons that
     *  predate the switch (their hooks are always installed). */
    hooks_enabled?: boolean;
    /** May this machine update codecast without being asked each time? */
    auto_update?: boolean;
    /** Does the session trailer hook add Codecast-Session to commits here?
     *  Absent from daemons that predate the setting. */
    session_trailer?: boolean;
  };
  /** The cast version the daemon runs, a newer release it could take, and
   *  whether it is below the fleet minimum (Settings > Daemon). */
  cli_version?: string;
  update_available?: string;
  update_required?: boolean;
  /** Self update (convex lib/deviceUpdate.ts): can this install replace its
   *  own binary, how it was installed, and the Update button's request. */
  can_self_update?: boolean;
  distribution?: "installer" | "brew" | "npm" | "source";
  update_requested_at?: number;
  update_state?: "requested" | "installing" | "failed";
  update_error?: string;
  /** When this daemon process started (devices.listDevices). */
  daemon_started_at?: number;
  /** Per-repo git health on this device (daemon gitPlane sweep). */
  git_plane?: Array<{
    root: string;
    origin?: string;
    origin_ok: boolean;
    fetch_ok?: boolean;
    ahead?: number;
    behind?: number;
    branch?: string;
    fetched_at?: number;
    repaired_from?: string;
    needs_access?: boolean;
    identity?: string;
    error?: string;
  }>;
  /** The device's PUBLIC git key — pasteable into GitHub to grant repo access. */
  git_pubkey?: string;
  /** The loop freeze budget for this machine: blocked ms in the last hour, the
   * worst single freeze, and the stacks it was in (devices.listDevices). */
  loop_freeze_1h_ms?: number;
  loop_freeze_max_ms?: number;
  loop_freeze_top?: string;
  /** A cloud host's own readiness (its heartbeat) and its managing laptop's report (Settings > Machines). */
  host_readiness?: import("@codecast/shared/contracts").HostReadiness;
  cloud_host?: import("@codecast/shared/contracts").CloudHostReport;
  /** Work waiting for this host since then (its next beat clears it), and the server's own start of it when it owns one (lib/hostWake). */
  wake_requested_at?: number;
  cloud_wake?: { request_at: number; status: "pending" | "starting" | "awake" | "failed"; attempt: number; last_error?: string };
  /** Autoscale with this host as the template (devices.cloud_autoscale). */
  cloud_autoscale?: import("@codecast/shared/contracts").CloudAutoscale;
  /** What keeps this machine from reading a cloud agent provider (its heartbeat): it is not connected to that one. */
  cloud_agent_blocks?: import("@codecast/shared/contracts").CloudAgentSetupBlock[];
  tailnet?: import("@codecast/shared/contracts/peerTransport").PeerTailnet;
  direct_links_off?: boolean;
  /** The one job this machine is kept for; automatic placement skips it (devices.reserved_for). */
  reserved_for?: string;
  /** Outcomes with this machine as the source. */
  peer_links?: Array<import("@codecast/shared/contracts/peerTransport").PeerLinkOutcome & { to_device_id: string; last_relay_ok_at?: number }>;
  online: boolean;
};
