// Tables for external data (docs/architecture/external-data.md X1, X3, X5,
// X7, X8): the sources a workspace configures, the groups their facts fold
// into, a few samples per group, replay manifests, watched metrics and the
// app connector's call audit.
//
// Every row carries `workspace` (the access key, stamped by
// computeWorkspaceKey exactly as signals are) and an optional `team_id` for
// routing. Access reads compare `workspace` only (CLAUDE.md, Workspace access
// vs routing).
//
// Product payloads are attacker-controlled and their object keys are not
// guaranteed to be valid Convex field names (PostHog's `$current_url`), so free
// form objects are stored as JSON strings, never as v.record.

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { ADDABLE_SOURCE_PROVIDERS, GROUP_KINDS, GROUP_STATUSES, SOURCE_PROVIDERS, SOURCE_STATUSES, TRANSITIONS, WATCH_DIRECTIONS, WATCH_KINDS } from "@codecast/shared/contracts/ingest";
import { REPLAY_BACKFILL_STATUSES, REPLAY_BACKFILL_WINDOWS, REPLAY_PROVIDERS } from "@codecast/shared/contracts/replay";

// The literal lists derive from the shared contract, the way openTaskValidator does, so the two cannot drift.
const literals = <T extends string>(values: readonly T[]) => v.union(...values.map((value) => v.literal(value)));

export const sourceProviderValidator = literals(SOURCE_PROVIDERS);
/** What createSource takes: a system provider (github) is codecast's to create. */
export const addableSourceProviderValidator = literals(ADDABLE_SOURCE_PROVIDERS);
export const sourceStatusValidator = literals(SOURCE_STATUSES);
export const groupKindValidator = literals(GROUP_KINDS);
export const groupStatusValidator = literals(GROUP_STATUSES);
export const transitionValidator = literals(TRANSITIONS);
export const watchKindValidator = literals(WATCH_KINDS);
export const watchDirectionValidator = literals(WATCH_DIRECTIONS);
export const replayProviderValidator = literals(REPLAY_PROVIDERS);

/** A source's bulk import of its vendor's recordings (X5; contracts/replay.ts ReplayBackfill). */
export const replayBackfillValidator = v.object({
  status: literals(REPLAY_BACKFILL_STATUSES),
  window: literals(REPLAY_BACKFILL_WINDOWS),
  since: v.optional(v.number()),
  until: v.number(),
  cursor: v.optional(v.string()),
  page_seen: v.optional(v.array(v.string())),
  listed: v.number(),
  imported: v.number(),
  skipped: v.number(),
  failed: v.number(),
  failures_in_row: v.optional(v.number()),
  last_error: v.optional(v.string()),
  started_at: v.number(),
  updated_at: v.number(),
  finished_at: v.optional(v.number()),
});

export const ingestUserValidator = v.object({
  id: v.optional(v.string()),
  email: v.optional(v.string()),
  name: v.optional(v.string()),
});

/**
 * Non-secret settings of a source: what it reads inside its connection.
 * Secrets, and where the connection points (host, base url), live on the
 * app_installations row named by connection_id, never here. Values are
 * checked per provider by sourceConfigProblem (shared/contracts/ingest).
 */
export const sourceConfigValidator = v.object({
  /** Sentry organization slug; must be the connection's. */
  org: v.optional(v.string()),
  /** Sentry project slugs or ids to mirror. */
  projects: v.optional(v.array(v.string())),
  /** PostHog project id, when the source reads another project than the connection's. */
  project_id: v.optional(v.string()),
  environments: v.optional(v.array(v.string())),
  sample_rate: v.optional(v.number()),
  replay_sample_rate: v.optional(v.number()),
  /** Origins the browser SDK may post from (the door's CORS answer). Absent allows any. */
  allowed_origins: v.optional(v.array(v.string())),
});

/** An app connector action a person allowed (X8). Readers need no grant. */
export const appGrantValidator = v.object({
  action: v.string(),
  granted_by: v.id("users"),
  granted_at: v.number(),
  until: v.optional(v.number()),
  /** How the person granted it: the web (a signed-in session) or their CLI api token. */
  via: v.optional(v.union(v.literal("session"), v.literal("api_token"))),
});

/** One manifest watch's poll state (X8), keyed by watchKey (kind:reader). */
export const appWatchStateValidator = v.object({
  key: v.string(),
  polled_at: v.number(),
  /** The newest row time a job watch has seen, so a listed failure counts once. */
  cursor: v.optional(v.number()),
  last_error: v.optional(v.string()),
});

/**
 * The small generic payload an ingestion external_events row carries (X3):
 * enough to render the transition and link it, never a sample body.
 */
export const externalEventDataValidator = v.object({
  transition: v.optional(transitionValidator),
  group_kind: v.optional(groupKindValidator),
  group_short_id: v.optional(v.string()),
  source_name: v.optional(v.string()),
  provider: v.optional(sourceProviderValidator),
  count: v.optional(v.number()),
  level: v.optional(v.string()),
  release: v.optional(v.string()),
  environment: v.optional(v.string()),
  value: v.optional(v.number()),
  threshold: v.optional(v.number()),
});

export const ingestTables = {
  // X1. One configured feed into a workspace.
  event_sources: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    /** Who set it up. Promoted signals file as this person (X6). */
    owner_user_id: v.id("users"),
    project_id: v.optional(v.id("projects")),
    short_id: v.string(), // "src-N"
    provider: sourceProviderValidator,
    /** Unique per workspace; what --source filters and trigger filters name. */
    name: v.string(),
    connection_id: v.optional(v.id("app_installations")),
    /** sha256 hex of the write-only ingest key (sdk, http). Never returned by a public function. */
    ingest_key_hash: v.optional(v.string()),
    /** ingestKeyPrefix(key): what the UI shows once the key is gone. */
    key_prefix: v.optional(v.string()),
    /** "union" makes signal fingerprints union:<segment>:<fp> (X6). */
    fingerprint_prefix: v.optional(v.string()),
    config: v.optional(sourceConfigValidator),
    /** App connector manifest as JSON (X8), refreshed daily or on `cast connector refresh`. */
    manifest_json: v.optional(v.string()),
    manifest_fetched_at: v.optional(v.number()),
    grants: v.optional(v.array(appGrantValidator)),
    watch_state: v.optional(v.array(appWatchStateValidator)),
    /** When the earliest manifest watch is next due (sources/app.ts nextWatchAt); absent until the first poll or manifest. */
    next_watch_at: v.optional(v.number()),
    /** Transitions that promote to signals (X6). */
    promote: v.array(transitionValidator),
    status: sourceStatusValidator,
    last_error: v.optional(v.string()),
    last_event_at: v.optional(v.number()),
    last_poll_at: v.optional(v.number()),
    /** The day (UTC yyyy-mm-dd) the *_today counters count; a new day resets them. */
    counters_day: v.optional(v.string()),
    events_today: v.optional(v.number()),
    dropped_today: v.optional(v.number()),
    /** Analytics `event` items counted per name and hour, never stored (X2): lib/ingestGroups countEventNames. */
    event_names: v.optional(v.array(v.object({ name: v.string(), buckets: v.array(v.object({ hour: v.number(), count: v.number() })) }))),
    groups_open: v.optional(v.number()),
    /** The bulk import of a PostHog or Sentry source's recordings (sources/replayBackfill.ts). Written once per page. */
    replay_backfill: v.optional(replayBackfillValidator),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_name", ["workspace", "name"])
    .index("by_ingest_key_hash", ["ingest_key_hash"])
    .index("by_short_id", ["short_id"])
    .index("by_provider_status", ["provider", "status"])
    // The app crons read only what is due: the watch poll by next_watch_at,
    // the daily manifest refresh by manifest_fetched_at.
    .index("by_provider_status_next_watch", ["provider", "status", "next_watch_at"])
    .index("by_provider_status_manifest", ["provider", "status", "manifest_fetched_at"]),

  // X1. A source's running counters, kept off its row: every batch and poll
  // moves them, and the source row is read by nearly every Ops query, so on
  // the row each batch re-ran them all. Only the source list reads this.
  // A source created before this table carries the same fields on its row
  // until its first write here (ingest.ts sourceStats).
  event_source_stats: defineTable({
    source_id: v.id("event_sources"),
    workspace: v.string(),
    counters_day: v.optional(v.string()),
    events_today: v.optional(v.number()),
    dropped_today: v.optional(v.number()),
    event_names: v.optional(v.array(v.object({ name: v.string(), buckets: v.array(v.object({ hour: v.number(), count: v.number() })) }))),
    groups_open: v.optional(v.number()),
    last_event_at: v.optional(v.number()),
    last_poll_at: v.optional(v.number()),
  }).index("by_source", ["source_id"]),

  // X8. An app connector's manifest (up to APP_LIMITS.response_bytes of JSON),
  // in its own table because Convex reads whole documents: on the source row
  // every source read, the poll crons included, paid for it.
  app_manifests: defineTable({
    source_id: v.id("event_sources"),
    manifest_json: v.string(),
    fetched_at: v.number(),
  }).index("by_source", ["source_id"]),

  // X3. A group's occurrences since its row was last written (ingest.ts
  // upsertGroup): a non-transition occurrence inside GROUP_WRITE_EVERY_MS
  // lands here, so the issues list (which reads the group rows) re-runs at
  // most once a minute per busy group rather than on every batch. Readers
  // that need the live numbers overlay it (readGroupState).
  event_group_tallies: defineTable({
    group_id: v.id("event_groups"),
    /** The group fields this holds ahead of the row, as JSON. */
    fields_json: v.string(),
    updated_at: v.number(),
  }).index("by_group", ["group_id"]),

  // X3. Every grouped fact: errors, warning logs, jobs, checks, metrics.
  event_groups: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    short_id: v.string(), // "eg-N"
    kind: groupKindValidator,
    /** groupFingerprint(undefined, kind, fp): unique per source. */
    fingerprint: v.string(),
    title: v.string(),
    culprit: v.optional(v.string()),
    level: v.optional(v.string()),
    status: groupStatusValidator,
    first_seen: v.number(),
    last_seen: v.number(),
    count: v.number(),
    users: v.optional(v.number()),
    /** Hourly counts, oldest first, at most GROUP_RULES.bucket_hours. `hour` is the hour's start in ms. */
    buckets: v.array(v.object({ hour: v.number(), count: v.number() })),
    first_release: v.optional(v.string()),
    last_release: v.optional(v.string()),
    last_sha: v.optional(v.string()),
    regressed_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_in: v.optional(v.string()),
    /** The last announced transition, for the spike and job cooldowns. */
    last_transition: v.optional(transitionValidator),
    last_transition_at: v.optional(v.number()),
    external: v.optional(v.object({ provider: v.string(), id: v.string(), url: v.optional(v.string()) })),
    signal_task_id: v.optional(v.id("tasks")),
    /** How many event_samples rows the group holds, so the trim deletes only the overflow. Absent on older rows. */
    sample_count: v.optional(v.number()),
    meta: v.optional(v.object({
      /** check */
      ok: v.optional(v.boolean()),
      /** metric */
      value: v.optional(v.number()),
      threshold: v.optional(v.number()),
      direction: v.optional(watchDirectionValidator),
      metric_watch_id: v.optional(v.id("metric_watches")),
    })),
    updated_at: v.number(),
  })
    .index("by_source_fingerprint", ["source_id", "fingerprint"])
    .index("by_source_last_seen", ["source_id", "last_seen"])
    .index("by_workspace_last_seen", ["workspace", "last_seen"])
    .index("by_workspace_status_last_seen", ["workspace", "status", "last_seen"])
    .index("by_workspace_kind_last_seen", ["workspace", "kind", "last_seen"])
    .index("by_source_status_last_seen", ["source_id", "status", "last_seen"])
    // The daily bucket prune reads only groups whose buckets can still change.
    .index("by_last_seen", ["last_seen"])
    .index("by_short_id", ["short_id"]),

  // X3. Recent occurrences of a group, at most GROUP_RULES.samples_per_group,
  // pruned by a cron. Bodies never ride list queries.
  event_samples: defineTable({
    workspace: v.string(),
    group_id: v.id("event_groups"),
    source_id: v.id("event_sources"),
    at: v.number(),
    message: v.optional(v.string()),
    stack: v.optional(v.string()),
    level: v.optional(v.string()),
    url: v.optional(v.string()),
    user: v.optional(ingestUserValidator),
    tags_json: v.optional(v.string()),
    context_json: v.optional(v.string()),
    release: v.optional(v.string()),
    environment: v.optional(v.string()),
    /** The recording this occurrence happened in, by the source's own replay id. */
    replay_external_id: v.optional(v.string()),
    replay_id: v.optional(v.id("replays")),
  })
    .index("by_group_at", ["group_id", "at"])
    // The 30 day prune (ingest.pruneSamples) reads oldest first across groups.
    .index("by_at", ["at"]),

  // X5. One manifest row per recording. Chunks live in R2 (codecast-replays).
  replays: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    short_id: v.string(), // "rp-N"
    provider: replayProviderValidator,
    external_id: v.string(),
    url: v.optional(v.string()),
    user: v.optional(ingestUserValidator),
    started_at: v.number(),
    duration_ms: v.optional(v.number()),
    counts: v.object({ clicks: v.number(), errors: v.number(), failed_requests: v.number() }),
    group_ids: v.array(v.id("event_groups")),
    /** R2 object keys, in order. */
    chunk_keys: v.array(v.string()),
    /** When chunk_keys last changed; the timeline is stale while this is newer than timeline_at. */
    chunks_at: v.optional(v.number()),
    /** When the cached timeline (replay_timelines) was last written. */
    timeline_at: v.optional(v.number()),
    /** When an assembly was last queued, so repeated manifests queue one, not one each. */
    assemble_at: v.optional(v.number()),
    /** A mirrored vendor recording is imported the first time it is read (X7). */
    imported_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source_external", ["source_id", "external_id"])
    .index("by_workspace_started", ["workspace", "started_at"])
    .index("by_source_started", ["source_id", "started_at"])
    .index("by_short_id", ["short_id"]),

  // X5. A replay's renderTimeline output (at most REPLAY_LIMITS.timeline_md_max_chars),
  // kept off the manifest row so list reads never carry it; read only for one replay's detail.
  replay_timelines: defineTable({
    replay_id: v.id("replays"),
    timeline_md: v.string(),
    updated_at: v.number(),
  }).index("by_replay", ["replay_id"]),

  // X7. A metric polled from a source and compared to a line.
  metric_watches: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    short_id: v.string(), // "mw-N"
    created_by: v.id("users"),
    name: v.string(),
    /** hogql: a HogQL query returning one number; insight: a PostHog insight id. */
    query_kind: watchKindValidator,
    query: v.string(),
    threshold: v.number(),
    direction: watchDirectionValidator,
    interval_ms: v.number(),
    status: v.union(v.literal("active"), v.literal("paused")),
    /** Absent while paused, so the poll cron's range read skips it. */
    next_check_at: v.optional(v.number()),
    /** The last GROUP_RULES.metric_points values, oldest first. */
    points: v.array(v.object({ at: v.number(), value: v.number() })),
    state: v.union(v.literal("ok"), v.literal("alert")),
    group_id: v.optional(v.id("event_groups")),
    last_error: v.optional(v.string()),
    /**
     * The last read of the history the source already holds (metrics.loadHistory):
     * when, how many past points it added, or why there is none.
     */
    history: v.optional(v.object({ at: v.number(), added: v.number(), note: v.optional(v.string()) })),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source", ["source_id"])
    .index("by_next_check", ["next_check_at"])
    // `cast metrics ls` and the Metrics tab list a workspace's watches; refs resolve by short id.
    .index("by_workspace", ["workspace"])
    .index("by_short_id", ["short_id"]),

  // X8. The audit of every app connector call. Bodies are never stored.
  app_calls: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    /** The person the call ran as (the session's user). */
    user_id: v.id("users"),
    conversation_id: v.optional(v.id("conversations")),
    kind: v.union(v.literal("read"), v.literal("do")),
    name: v.string(),
    /** sha256 hex of the canonical args JSON. */
    args_hash: v.string(),
    idempotency_key: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("error"), v.literal("denied")),
    http_status: v.optional(v.number()),
    error: v.optional(v.string()),
    ms: v.number(),
    bytes: v.number(),
    created_at: v.number(),
  }).index("by_source_created", ["source_id", "created_at"]),

  // X2. Vendor webhook deliveries already taken (Sentry's Request-ID, a
  // PostHog delivery), so a retried delivery is processed once. Only the id
  // is kept, never the body; ingest.pruneWebhookDeliveries drops old rows.
  webhook_deliveries: defineTable({
    provider: v.string(),
    delivery_id: v.string(),
    created_at: v.number(),
  })
    .index("by_provider_delivery", ["provider", "delivery_id"])
    .index("by_created", ["created_at"]),
};
