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
import { REPLAY_BACKFILL_STATUSES, REPLAY_BACKFILL_WINDOWS, REPLAY_PROVIDERS, VENDOR_REFRESH_WHYS } from "@codecast/shared/contracts/replay";

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
/** shared/replay/list.ts ReplayShape. */
/** A long vendor recording's import still reading its later parts (replays.import_rest, sources/replayRest.ts). */
export const replayImportRestValidator = v.object({
  /** The chain's id: a new import starts a new one, and a step of an older chain stops. */
  gen: v.number(),
  next_blob: v.number(),
  blobs: v.number(),
  /** The R2 object holding the converter's state where the last part ended (shared/replay/capture.ts CaptureCarry). */
  carry_key: v.string(),
  /** The vendor asked to wait (a rate limit): the next part is read at this time. */
  retry_at: v.optional(v.number()),
  /** The last part failed: why, in the adapter's words. The chain stops; reopening the replay starts it again. */
  error: v.optional(v.string()),
  /** A resumed chain's first part re-reads a blob the copy already holds: its rrweb events at or before this epoch ms are dropped. */
  after_t: v.optional(v.number()),
  updated_at: v.number(),
});

/** Where an imported copy's read stopped (replays.read_to): a resumed read continues here instead of reading the recording again from its start. */
export const replayReadToValidator = v.object({
  next_blob: v.number(),
  blobs: v.number(),
  /** The converter's state at next_blob, when kept (shared CaptureCarry); else it is rebuilt from the stored capture. */
  carry_key: v.optional(v.string()),
  at: v.number(),
});

/** shared/contracts/replayPlayer.ts ReplayDomChunkMeta. */
export const replayDomChunkMetaValidator = v.object({ first: v.number(), last: v.number(), full: v.optional(v.number()), raw: v.number() });

export const replayShapeValidator = v.object({
  v: v.number(),
  active_ms: v.number(),
  pages: v.number(),
  rage_clicks: v.number(),
  strip: v.string(),
  marks: v.array(v.number()),
  paths: v.optional(v.array(v.string())),
  endpoints: v.optional(v.array(v.string())),
});

export const replayProviderValidator = literals(REPLAY_PROVIDERS);

/**
 * shared/replay/list.ts ReplayFacts: what the vendor itself says of a
 * recording (sources/replayFacts.ts). `at` alone means the vendor was asked
 * and knew nothing.
 */
export const replayFactsValidator = v.object({
  at: v.number(),
  length_ms: v.optional(v.number()),
  active_ms: v.optional(v.number()),
  clicks: v.optional(v.number()),
  console_errors: v.optional(v.number()),
  rage_clicks: v.optional(v.number()),
  browser: v.optional(v.string()),
  os: v.optional(v.string()),
  device: v.optional(v.string()),
  country: v.optional(v.string()),
  referrer: v.optional(v.string()),
});

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
  rate_limited_since: v.optional(v.number()),
  last_error: v.optional(v.string()),
  failures: v.optional(v.array(v.object({ id: v.string(), error: v.string(), at: v.optional(v.number()), length_ms: v.optional(v.number()), person: v.optional(v.string()), url: v.optional(v.string()) }))),
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
  /** Where moment bodies are kept (learning-loop.md LL7): host by default, codecast when a person chooses it. */
  moment_storage: v.optional(v.union(v.literal("host"), v.literal("codecast"))),
  /** How long codecast-stored bodies are kept: 30d by default, keep for as long as the moment exists (decision sd-555). */
  moment_retention: v.optional(v.union(v.literal("30d"), v.literal("keep"))),
  /** Where its judges make model calls (shared JUDGE_BACKENDS): api by default, or subscription on the extracting machine's Claude Code login. */
  judge_on: v.optional(v.union(v.literal("api"), v.literal("subscription"))),
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
  /** A person paused this watch on the Apps tab: the poller skips it until resumed. */
  paused: v.optional(v.boolean()),
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
    /** The key a rotation replaced, still accepted until old_key_until so a deployed SDK keeps sending while the new key ships (ingest.rotateKey). */
    old_key_hash: v.optional(v.string()),
    old_key_prefix: v.optional(v.string()),
    old_key_until: v.optional(v.number()),
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
    /** Where the vendor's own app shows this source's project (PostHog: `<host>/project/<id>`), for "Open in" links. Written by sources/replayFacts.ts. */
    vendor_web_url: v.optional(v.string()),
    /**
     * How this source's imported recordings stand against their vendor lengths (sources/replayRest.ts tally): cut short, of unknown reach, and the one being read.
     * The tend cron recounts it; between recounts `cut` moves with each recording that crosses the line (lib/replayIndex.ts) and `reading` with each chain that starts or ends.
     * `counted` is what the recount at `at` found and `prev` the recount before it, so the import line can say whether the backlog drains; `queue` the next recordings the sweep reads, in its order.
     */
    replay_rest: v.optional(v.object({ cut: v.number(), unknown: v.number(), reading: v.optional(v.string()), waiting_until: v.optional(v.number()), at: v.number(), counted: v.optional(v.number()), prev: v.optional(v.object({ cut: v.number(), at: v.number() })), queue: v.optional(v.array(v.string())) })),
    /** When the source's replay_tallies were last counted whole (lib/replayTallies.ts rebuild): the list reads its totals and people from them only once set. */
    replay_tally_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_name", ["workspace", "name"])
    .index("by_ingest_key_hash", ["ingest_key_hash"])
    .index("by_old_key_hash", ["old_key_hash"])
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
    /** The last SOURCE_STAT_DAYS UTC days' counters, oldest first, today's included: a source's volume over time. */
    days: v.optional(v.array(v.object({ day: v.string(), events: v.number(), dropped: v.number() }))),
    /** The last SOURCE_STAT_HOURS hours of the same count (hour = its start, epoch ms), oldest first: the 24 hour chart. */
    hours: v.optional(v.array(v.object({ hour: v.number(), events: v.number() }))),
    /** The source's groups by status as of groups_counted_at (ingest.ts recountSourceGroups); ignored holds muted too. A person's triage moves it between counts. */
    group_counts: v.optional(v.object({ open: v.number(), resolved: v.number(), ignored: v.number() })),
    groups_counted_at: v.optional(v.number()),
    /** A CI source's finished runs, oldest first (contracts/volumeWatch withCiRun): its failure rate and run time series. */
    ci_runs: v.optional(v.array(v.object({ at: v.number(), ok: v.boolean(), duration_ms: v.optional(v.number()) }))),
    /** A rotated-out key still inside its grace window: when it last carried a batch, and the events it carried since the rotation (ingest.rotateKey resets both). */
    old_key_last_at: v.optional(v.number()),
    old_key_events: v.optional(v.number()),
  }).index("by_source", ["source_id"]),

  // One GitHub Actions run read back from GitHub for a CI check issue
  // (ciRuns.ts): the run's jobs and steps, the failed jobs' annotations and
  // the tail of the first failed job's log. The webhook carries none of this;
  // the issue page asks for it when it shows a run. `error` says why a read
  // came back short (no installation, no Actions read permission).
  ci_run_details: defineTable({
    repository: v.string(),
    run_id: v.string(),
    fetched_at: v.number(),
    title: v.optional(v.string()),
    event: v.optional(v.string()),
    actor: v.optional(v.string()),
    attempt: v.optional(v.number()),
    started_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    jobs: v.array(v.object({
      id: v.string(),
      name: v.string(),
      conclusion: v.optional(v.string()),
      duration_ms: v.optional(v.number()),
      url: v.optional(v.string()),
      steps: v.array(v.object({ number: v.number(), name: v.string(), conclusion: v.optional(v.string()) })),
    })),
    annotations: v.array(v.object({ job: v.string(), level: v.string(), message: v.string(), title: v.optional(v.string()), path: v.optional(v.string()), line: v.optional(v.number()) })),
    log_job: v.optional(v.string()),
    log_tail: v.optional(v.string()),
    log_error: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index("by_repo_run", ["repository", "run_id"]),

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
    /** When distinct people began to be counted (event_group_users) on a group that predates the count; absent = since first seen. */
    users_since: v.optional(v.number()),
    /** Hourly counts, oldest first, at most GROUP_RULES.bucket_hours. `hour` is the hour's start in ms. */
    buckets: v.array(v.object({ hour: v.number(), count: v.number() })),
    /** Daily counts, oldest first, at most GROUP_RULES.day_buckets. `day` is the UTC day's start in ms. Absent on groups not written since they began. */
    days: v.optional(v.array(v.object({ day: v.number(), count: v.number() }))),
    first_release: v.optional(v.string()),
    last_release: v.optional(v.string()),
    last_sha: v.optional(v.string()),
    regressed_at: v.optional(v.number()),
    /** The release the regression came back in (lib/ingestGroups), so every surface names the same one. */
    regressed_in: v.optional(v.string()),
    resolved_at: v.optional(v.number()),
    resolved_in: v.optional(v.string()),
    /** What resolved it: a person (resolved_by), a check or metric's own recovery, or the vendor. Absent on older rows. */
    resolved_via: v.optional(v.union(v.literal("person"), v.literal("recovered"), v.literal("vendor"))),
    resolved_by: v.optional(v.id("users")),
    /** A check or metric's flips to failing over the last 7 days (lib/ingestGroups FLAP_WINDOW_MS): a flapping monitor. */
    failed_at: v.optional(v.array(v.number())),
    /** The last announced transition, for the spike and job cooldowns. */
    last_transition: v.optional(transitionValidator),
    last_transition_at: v.optional(v.number()),
    external: v.optional(v.object({ provider: v.string(), id: v.string(), url: v.optional(v.string()) })),
    signal_task_id: v.optional(v.id("tasks")),
    /** The session a person started on this group from its page (ingest.setGroupFix), and when. */
    fix_conversation_id: v.optional(v.id("conversations")),
    fix_started_at: v.optional(v.number()),
    /**
     * A promotion not yet filed: one the source's hourly cap refused
     * (SOURCE_CAPS.promotions_per_hour), filed by ingest.promoteDue once the
     * window has room, or one whose run is scheduled and has not settled
     * (ingestPromotions.ts), run again if it never does. One per group.
     */
    promotion_due: v.optional(v.object({
      transition: transitionValidator,
      fingerprint: v.string(),
      external_event_id: v.optional(v.id("external_events")),
      at: v.number(),
      /** When its latest run was scheduled to start, and how many runs it has had (ingestPromotions.ts). */
      scheduled_at: v.optional(v.number()),
      tries: v.optional(v.number()),
    })),
    /** How many event_samples rows the group holds, so the trim deletes only the overflow. Absent on older rows. */
    sample_count: v.optional(v.number()),
    /** A job's failures by what they said (lib/ingestGroups tallyMessages), since its first failure after the tally began. Absent on other kinds and on jobs not failed since. */
    messages: v.optional(v.array(v.object({ key: v.string(), count: v.number(), first_seen: v.number(), last_seen: v.number() }))),
    meta: v.optional(v.object({
      /** check */
      ok: v.optional(v.boolean()),
      /** metric */
      value: v.optional(v.number()),
      threshold: v.optional(v.number()),
      direction: v.optional(watchDirectionValidator),
      metric_watch_id: v.optional(v.id("metric_watches")),
      /** check: its last passing reading, and for a CI run the commit and branch it passed at, so a failing check names its last green. */
      last_ok_at: v.optional(v.number()),
      last_ok_sha: v.optional(v.string()),
      last_ok_branch: v.optional(v.string()),
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
    .index("by_short_id", ["short_id"])
    .index("by_promotion_due", ["promotion_due.at"])
    // The Issues list's search reaches every group, not only the windows a device holds.
    .searchIndex("search_title", { searchField: "title", filterFields: ["workspace", "status"] }),

  // X3. The distinct people a group has reached, one row each (ingest.ts
  // countGroupUsers), so `users` on the group is a count and not a guess.
  // Keyed by the occurrence's user id, else email, else name. Read only by
  // group and key; deleted with the group.
  event_group_users: defineTable({
    group_id: v.id("event_groups"),
    user_key: v.string(),
    at: v.number(),
  }).index("by_group_user", ["group_id", "user_key"]),

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
    /** Why it is held past the newest few (lib/ingestGroups samplePins): first, release, day. The trim takes unpinned ones first. */
    pin: v.optional(v.string()),
  })
    .index("by_group_at", ["group_id", "at"])
    // The 30 day prune (ingest.pruneSamples) reads oldest first across groups.
    .index("by_at", ["at"])
    // The Timeline's occurrences (ingest.listSamples): a workspace's, or one source's, newest first.
    .index("by_workspace_at", ["workspace", "at"])
    .index("by_source_at", ["source_id", "at"]),

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
    /** VENDOR_CONVERTER_VERSION the imported copy was converted with; absent means 1. */
    converter_version: v.optional(v.number()),
    /** A refresh of an older copy failed: the vendor is not asked again before this (VENDOR_REFRESH_RETRY). */
    vendor_refresh_after: v.optional(v.number()),
    /** Why the vendor is waited out until vendor_refresh_after (shared VENDOR_REFRESH_WHYS), so the page can say so. */
    vendor_refresh_why: v.optional(v.union(...VENDOR_REFRESH_WHYS.map((w) => v.literal(w)))),
    /** R2 keys of the DOM capture (raw rrweb events, masked), in order: what the player plays. Absent or empty: no capture. */
    dom_chunk_keys: v.optional(v.array(v.string())),
    /** Each DOM chunk's span and JSON size, parallel to dom_chunk_keys (shared ReplayDomChunkMeta): how the player opens a long capture a stretch at a time. Ignored when its length differs. */
    dom_chunk_meta: v.optional(v.array(replayDomChunkMetaValidator)),
    /** The capture's gzipped size in bytes. */
    dom_bytes: v.optional(v.number()),
    /** The epoch ms of the replay clock's zero (the stream's first event), which the player maps rrweb timestamps against. */
    dom_t0: v.optional(v.number()),
    /** How far an imported copy reaches on the replay clock (its stream or capture, whichever runs longer). Shorter than the vendor's length when the read stopped at a size cap. */
    captured_ms: v.optional(v.number()),
    /** What a list row draws (shared/replay/list.ts replayShape): written with the summary, absent until the stream is read. */
    shape: v.optional(replayShapeValidator),
    /** The vendor's own facts (length, activity, browser, OS, device, country, referrer); absent until asked. */
    facts: v.optional(replayFactsValidator),
    /**
     * A long vendor recording whose import holds only its start, being read
     * part by part (sources/replayRest.ts): the chain's id, the next blob to
     * read of how many, where the converter's state is kept in R2, and when
     * the next part is due after a rate limit. Absent once the whole
     * recording is in, or when no chain runs.
     */
    import_rest: v.optional(replayImportRestValidator),
    /** Where the last read of a vendor recording stopped, kept after a chain ends so a recording PostHog keeps writing is read on from there (sources/replayRest.ts resume). */
    read_to: v.optional(replayReadToValidator),
    /** shared personKey(user), kept by lib/replayIndex.ts patchReplay: one person's recordings read by index, so their count is exact. */
    person_key: v.optional(v.string()),
    /** True while the copy stops well short of the recording (shared replayCutAt), kept by patchReplay: the partly imported list and tally read it by index. */
    rest_cut: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source_external", ["source_id", "external_id"])
    .index("by_workspace_started", ["workspace", "started_at"])
    .index("by_source_started", ["source_id", "started_at"])
    .index("by_short_id", ["short_id"])
    .index("by_workspace_person", ["workspace", "person_key", "started_at"])
    .index("by_source_person", ["source_id", "person_key", "started_at"])
    .index("by_workspace_cut", ["workspace", "rest_cut", "started_at"])
    .index("by_source_cut", ["source_id", "rest_cut", "started_at"]),

  // X5. A replay's renderTimeline output (at most REPLAY_LIMITS.timeline_md_max_chars),
  // kept off the manifest row so list reads never carry it; read only for one replay's detail.
  replay_timelines: defineTable({
    replay_id: v.id("replays"),
    timeline_md: v.string(),
    updated_at: v.number(),
  }).index("by_replay", ["replay_id"]),

  // A source's recordings counted per person (lib/replayTallies.ts): every
  // recording, and the part the default active-time floor hides, so the list's
  // total, the tab badge and each People row print the exact count however
  // many recordings there are. Kept by every replay write (patchReplay,
  // ensureReplay); recounted whole by the tend cron. Recordings with no person
  // land in one of a few shards (shard set, person_key absent) so imports do
  // not all write one row.
  replay_tallies: defineTable({
    workspace: v.string(),
    source_id: v.id("event_sources"),
    person_key: v.optional(v.string()),
    shard: v.optional(v.number()),
    label: v.optional(v.string()),
    anonymous: v.optional(v.boolean()),
    n: v.number(),
    ms: v.number(),
    errors: v.number(),
    failed: v.number(),
    short_n: v.number(),
    short_ms: v.number(),
    short_errors: v.number(),
    short_failed: v.number(),
    first_at: v.number(),
    last_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source_person", ["source_id", "person_key", "shard"])
    .index("by_workspace", ["workspace"]),

  // X7. A metric polled from a source and compared to a line.
  metric_watches: defineTable({
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    source_id: v.id("event_sources"),
    short_id: v.string(), // "mw-N"
    created_by: v.id("users"),
    name: v.string(),
    /** hogql: a HogQL query returning one number; insight: a PostHog insight id; reader: an app connector reader and its args. */
    query_kind: watchKindValidator,
    query: v.string(),
    /** The alert line. Absent: a plain series (a goal's live number), which never opens a group. */
    threshold: v.optional(v.number()),
    direction: watchDirectionValidator,
    /** How a value reads: "$" leads it, anything else ("%", "/day", "intros") follows it. */
    unit: v.optional(v.string()),
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
     * when, how many past points it added, or why there is none. `reading`
     * while the read is on its way.
     */
    history: v.optional(v.object({ at: v.number(), added: v.number(), note: v.optional(v.string()), reading: v.optional(v.boolean()) })),
    /** The monitor (contracts/metricMonitor.ts): reads in a row that flip the state (absent: 1), a warning level short of the line, failed reads in a row that count as missing data (absent: ignored), a mute. */
    eval_reads: v.optional(v.number()),
    warn: v.optional(v.number()),
    no_data_after: v.optional(v.number()),
    muted_until: v.optional(v.number()),
    /** What its alert does (contracts/metricMonitor alertRoute): files a problem task, or the timeline and triggers only. Absent: the source's rule. */
    on_alert: v.optional(v.union(v.literal("task"), v.literal("timeline"))),
    /** Who else the alert reaches and what more it does (contracts/metricMonitor AlertNotify, metricAlerts.ts). */
    notify: v.optional(v.object({
      users: v.optional(v.array(v.id("users"))),
      roles: v.optional(v.array(v.id("org_roles"))),
      channel: v.optional(v.id("chat_channels")),
      fix: v.optional(v.boolean()),
      renotify_ms: v.optional(v.number()),
      recovery: v.optional(v.boolean()),
      by: v.id("users"),
    })),
    /** The running alert's delivery state: when it began, when it was last said, the chat thread its lines reply in. */
    alert_episode: v.optional(v.object({ at: v.number(), notified_at: v.number(), thread_root: v.optional(v.id("chat_messages")) })),
    /** What each alert did, newest last (contracts/metricMonitor DELIVERIES_KEPT). */
    deliveries: v.optional(v.array(v.object({
      at: v.number(),
      kind: v.union(v.literal("crossed"), v.literal("still"), v.literal("recovered")),
      to: v.string(),
      ok: v.boolean(),
      href: v.optional(v.string()),
      note: v.optional(v.string()),
    }))),
    /** Failed reads in a row, for no_data_after. */
    missed: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_source", ["source_id"])
    .index("by_next_check", ["next_check_at"])
    // `cast metrics ls` and the Metrics tab list a workspace's watches; refs resolve by short id.
    .index("by_workspace", ["workspace"])
    .index("by_short_id", ["short_id"]),

  // X7. Every value a watch has read (lib/metricPoints.ts), one row each; the
  // watch row keeps only its newest few. Read by watch and time window.
  metric_points: defineTable({
    watch_id: v.id("metric_watches"),
    at: v.number(),
    value: v.number(),
  }).index("by_watch_at", ["watch_id", "at"]),

  // X7. A watch's values per hour (count, sum, min, max), recounted whenever
  // a value in that hour is written: what a chart wider than a few days reads.
  metric_rollups: defineTable({
    watch_id: v.id("metric_watches"),
    hour: v.number(),
    n: v.number(),
    sum: v.number(),
    min: v.number(),
    max: v.number(),
  }).index("by_watch_hour", ["watch_id", "hour"]),

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
