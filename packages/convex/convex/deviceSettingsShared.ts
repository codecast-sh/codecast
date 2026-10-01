// Validator for the daemon-reported per-device agent-feature settings: which
// `cast install` snippets are enabled (keyed by canonical slug, so the backend
// and web never need the slug→config-key mapping) plus the tri-state stable
// mode. Stored on the device row, consumed by the web Settings page.
//
// Pure — no server/_generated imports — so schema.ts and the mutations can both
// import it. The slug keys themselves are defined once in
// @codecast/shared/contracts (SNIPPET_CATALOG); this validator is intentionally
// permissive about keys (v.record) so a new snippet doesn't require a schema
// migration to start reporting.

import { v } from "convex/values";
import { CLOUD_AGENT_SETUP_KINDS, CLOUD_SESSION_SOURCES, type CloudSessionSyncField } from "@codecast/shared/contracts";

const optionalBoolean = v.optional(v.boolean());

/**
 * The account's cloud session sync settings, one optional boolean per
 * source in CLOUD_SESSION_SOURCES (unset = the source's default there): the
 * user row's fields and updateSyncSettings' arguments, so a new source is one
 * entry in the shared contract.
 */
export const cloudSessionSyncFields = Object.fromEntries(
  Object.values(CLOUD_SESSION_SOURCES).map(({ field }) => [field, optionalBoolean]),
) as Record<CloudSessionSyncField, typeof optionalBoolean>;

export const deviceSettingsValidator = v.object({
  snippets: v.optional(v.record(v.string(), v.boolean())),
  stable_mode: v.optional(
    v.union(v.literal("solo"), v.literal("team"), v.literal("off")),
  ),
  stable_global: v.optional(v.boolean()),
  // May the auto-switch loop spend one of this machine's Codex rate-limit reset
  // credits instead of switching accounts? Off unless the config says otherwise
  // — a credit is something the human earned, so nothing spends one on their
  // behalf until they say so (ct-49529, `codex_reset_credit_auto` in config.json).
  codex_reset_credit_auto: v.optional(v.boolean()),
  // Codecast's Claude Code hooks installed on this machine (hooks_enabled in
  // config.json, on unless turned off), and whether it may update itself.
  hooks_enabled: v.optional(v.boolean()),
  auto_update: v.optional(v.boolean()),
  // Does the session trailer hook add Codecast-Session to commits here?
  session_trailer: v.optional(v.boolean()),
});

// Daemon-reported model inventory for dynamic clients (opencode/pi): each
// client's own listing of launchable `provider/model` ids on this device.
// Hash-gated on both ends — the daemon resends only on change, the heartbeat
// mutation rewrites only on a hash mismatch — so the ~10KB list never churns.
// Keys are v.record so a future dynamic client needs no schema migration.
// What keeps a machine from reading each cloud agent provider, as its daemon's
// heartbeat reports it (CloudAgentSetupBlock): the provider, the kind of
// setup problem, and the provider's reason. Never a credential.
export const cloudAgentBlocksValidator = v.array(v.object({
  provider: v.string(),
  kind: v.union(...CLOUD_AGENT_SETUP_KINDS.map((k) => v.literal(k))),
  reason: v.optional(v.string()),
  resets_at: v.optional(v.number()),
}));

export const modelInventoryValidator = v.object({
  hash: v.string(),
  collected_at: v.number(),
  clients: v.record(v.string(), v.array(v.string())),
});
