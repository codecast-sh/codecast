// Every product event codecast sends, declared once.
//
// Why a catalog (ct-49565): `track(event: string, props: Record<string, unknown>)`
// accepted anything, so a typo minted a PostHog event nobody queries, a renamed
// property split a funnel in half without a word, and any object at a call site
// could carry user text — a prompt, a path, an email — into the analytics store.
// The declaration below is both the compile time signature every call site gets
// and the runtime rules the track boundary enforces. Anything that fails is
// dropped whole, never sent with the bad part stripped.
//
// Adding an event: add it here, with the narrowest spec that is true (an enum
// over a free string, a cap on every string). Web, mobile, Convex and the web
// server all validate against this one file, so a funnel that spans surfaces
// cannot disagree with itself about property names.

import { defineCatalog, type EventName, type EventProps } from "@platform/analytics/catalog";

/** Where the events with a `platform` super property say they came from. */
const SURFACE = { type: "string", values: ["web", "desktop", "mobile"] } as const;
const COUNT = { type: "number" } as const;
/** A UI location label: a hand-written constant at the call site, never user text. */
const LOCATION = { type: "string", max: 64 } as const;

export const CODECAST_EVENTS = defineCatalog({
  // Install and activation funnel (client).
  install_command_copied: {
    location: LOCATION,
    platform: { type: "string", values: ["unix", "windows"] },
    with_token: { type: "boolean" },
  },
  install_script_viewed: {
    location: LOCATION,
    platform: { type: "string", values: ["unix", "windows"] },
  },
  desktop_download_clicked: { location: LOCATION },
  ios_app_clicked: { location: LOCATION },

  // Install and activation funnel (web server, personless).
  install_script_downloaded: { script: { type: "string", values: ["sh", "ps1"] } },
  desktop_dmg_downloaded: { version: { type: "string", max: 32 } },

  // Install and activation funnel (Convex, identified by users._id).
  setup_token_generated: {},
  cli_authed: { method: { type: "string", values: ["browser", "setup_token"] } },
  cli_daemon_connected: {
    cli_version: { type: "string", max: 32 },
    cli_platform: { type: "string", max: 32 },
  },
  first_session_synced: {
    agent_type: {
      type: "string",
      values: ["claude_code", "codex", "cursor", "gemini", "opencode", "pi", "grok"],
    },
  },

  // Triage onboarding tour.
  nux_tour_opened: {},
  nux_tour_step: { step: COUNT },
  nux_tour_finished: { step: COUNT },
  nux_tour_skipped: { step: COUNT },

  // Tips.
  tip_seen: { tip_id: { type: "string", max: 64 }, type: { type: "string", max: 16, optional: true } },
  tip_dismissed: { tip_id: { type: "string", max: 64 }, type: { type: "string", max: 16, optional: true } },
  tip_completed: { tip_id: { type: "string", max: 64 }, type: { type: "string", max: 16, optional: true } },
  inline_tip_dismissed: { tip_id: { type: "string", max: 64 } },
  tips_level_changed: { level: { type: "string", values: ["all", "subtle", "none"] } },

  // Sync log health.
  synclog_apply: { direct: COUNT, refetch: COUNT, ratio: COUNT },
  synclog_crawl_healed: { namespace: { type: "string", values: ["tasks", "docs"] }, count: COUNT },

  // Inbox digest compare: does the client's own projection agree with the
  // server's? Counters only — no ids, no titles.
  inbox_digest_heartbeat: {
    scope: { type: "string", max: 32 },
    platform: SURFACE,
    checks: COUNT,
    mismatches: COUNT,
    heals: COUNT,
    heals_missing: COUNT,
    max_payload_age_ms: COUNT,
    disabled: COUNT,
    probes: COUNT,
    skips: { type: "counters", maxKeys: 24 },
  },
  inbox_drift: {
    scope: { type: "string", max: 32 },
    platform: SURFACE,
    missing: COUNT,
    extra: COUNT,
    bucket_deltas: COUNT,
    fold_deltas: COUNT,
    payload_age_ms: COUNT,
    epoch: COUNT,
  },
  inbox_drift_persistent: {
    scope: { type: "string", max: 32 },
    platform: SURFACE,
    heals_in_window: COUNT,
    window_ms: COUNT,
  },
  inbox_digest_version_skew: {
    scope: { type: "string", max: 32 },
    platform: SURFACE,
    payload_v: COUNT,
    client_v: COUNT,
  },
});

export type CodecastEventName = EventName<typeof CODECAST_EVENTS>;
export type CodecastEventProps<N extends CodecastEventName> = EventProps<(typeof CODECAST_EVENTS)[N]>;

/**
 * The env var that turns codecast telemetry off on a node surface, alongside
 * the standard DO_NOT_TRACK and the CI variables.
 */
export const TELEMETRY_DISABLED_VAR = "CODECAST_TELEMETRY_DISABLED";
