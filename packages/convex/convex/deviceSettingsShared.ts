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

export const deviceSettingsValidator = v.object({
  snippets: v.optional(v.record(v.string(), v.boolean())),
  stable_mode: v.optional(
    v.union(v.literal("solo"), v.literal("team"), v.literal("off")),
  ),
  stable_global: v.optional(v.boolean()),
});

// Daemon-reported model inventory for dynamic clients (opencode/pi): each
// client's own listing of launchable `provider/model` ids on this device.
// Hash-gated on both ends — the daemon resends only on change, the heartbeat
// mutation rewrites only on a hash mismatch — so the ~10KB list never churns.
// Keys are v.record so a future dynamic client needs no schema migration.
export const modelInventoryValidator = v.object({
  hash: v.string(),
  collected_at: v.number(),
  clients: v.record(v.string(), v.array(v.string())),
});
