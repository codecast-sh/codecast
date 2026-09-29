/**
 * Validators for a cloud host's readiness, its laptop's report, and a
 * session's live mirror (contracts/cloudHostReport.ts, localMirror.ts). A
 * leaf: schema.ts, the heartbeat (users.ts) and cloud.ts all import it, and
 * it imports nothing of theirs.
 */
import { v } from "convex/values";
import { CLOUD_HOST_ACTIONS, LOCAL_MIRROR_MODES, LOCAL_MIRROR_STATUSES, SYNC_SKIP_REASONS } from "@codecast/shared/contracts";

// A cloud host's own readiness (its heartbeat) and its managing laptop's report
// (AWS state, cost, images, held logins, last action): contracts/cloudHostReport.ts.
export const hostReadinessValidator = v.object({
  mirror: v.optional(v.object({ complete: v.boolean(), files: v.number(), applied_at: v.optional(v.string()), host_edited: v.array(v.string()) })),
  tools: v.optional(v.object({ ok: v.number(), installed: v.number(), missing: v.array(v.object({ tool: v.string(), referenced_by: v.optional(v.string()) })), at: v.optional(v.string()) })),
  setup: v.optional(v.object({
    ok: v.boolean(), applied_at: v.optional(v.string()), step: v.optional(v.string()), error: v.optional(v.string()), at: v.optional(v.string()),
    packages: v.optional(v.array(v.string())), services: v.optional(v.array(v.string())), commands: v.optional(v.number()),
  })),
  logins: v.optional(v.array(v.string())),
  cast_version: v.optional(v.string()),
  at: v.number(),
});
export const cloudHostReportValidator = v.object({
  managed_by: v.string(),
  instance_id: v.string(),
  provider: v.union(v.literal("aws"), v.literal("scaleway-mac")),
  region: v.optional(v.string()),
  instance_type: v.optional(v.string()),
  state: v.union(v.literal("running"), v.literal("stopped"), v.literal("pending"), v.literal("stopping"), v.literal("missing"), v.literal("unknown")),
  hourly_usd: v.optional(v.number()),
  disk_monthly_usd: v.optional(v.number()),
  disk_gib: v.optional(v.number()),
  idle_stop_minutes: v.optional(v.number()),
  images: v.array(v.object({ id: v.string(), name: v.string(), created: v.string() })),
  logins_held: v.array(v.object({ id: v.string(), reason: v.string() })),
  last_action: v.optional(v.object({
    action: v.union(...CLOUD_HOST_ACTIONS.map((a) => v.literal(a))),
    status: v.union(v.literal("running"), v.literal("ok"), v.literal("failed")),
    detail: v.optional(v.string()),
    at: v.number(),
  })),
  at: v.number(),
});

/** The fields a mirroring laptop reports (reportLocalMirror) and the row stores beside status and time. */
export const localMirrorFields = {
  path: v.optional(v.string()),
  mode: v.optional(v.union(...LOCAL_MIRROR_MODES.map((m) => v.literal(m)))),
  last_sha: v.optional(v.string()),
  last_landed_at: v.optional(v.number()),
  changed: v.optional(v.number()),
  to_laptop: v.optional(v.number()),
  to_host: v.optional(v.number()),
  files: v.optional(v.array(v.string())),
  conflicts: v.optional(v.array(v.string())),
  skipped: v.optional(v.array(v.object({
    path: v.string(),
    reason: v.union(...SYNC_SKIP_REASONS.map((r) => v.literal(r))),
    bytes: v.optional(v.number()),
    side: v.union(v.literal("laptop"), v.literal("cloud")),
  }))),
  skipped_count: v.optional(v.number()),
  error: v.optional(v.string()),
};
export const localMirrorValidator = v.object({
  device_id: v.string(),
  status: v.union(...LOCAL_MIRROR_STATUSES.map((s) => v.literal(s))),
  ...localMirrorFields,
  at: v.number(),
});
