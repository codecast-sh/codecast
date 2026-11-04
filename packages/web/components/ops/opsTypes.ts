// The rows the Ops page holds in the store, as the ingest, replay, metric and
// app functions return them (packages/convex/convex/ingest.ts sourceView and
// groupView, replays.ts replayView, metrics.ts watchView, sources/app.ts).
// Types only: the server is the shape's owner.
import type { GroupKind, GroupStatus, SourceProvider, SourceStatus, Transition, MetricWatchHistory, WatchDirection, WatchKind } from "@codecast/shared/contracts/ingest";
import type { ReplayBackfill, ReplayProvider } from "@codecast/shared/contracts/replay";
import type { AlertDelivery, AlertNotify } from "@codecast/shared/contracts/metricMonitor";
import type { ReplayEnvKey, ReplayFacts, ReplayPerson, ReplayShape } from "@codecast/shared/replay";

export type OpsSource = {
  _id: string;
  short_id: string;
  workspace: string;
  team_id?: string;
  owner_user_id: string;
  project_id?: string;
  provider: SourceProvider;
  name: string;
  keyed: boolean;
  key_prefix?: string;
  /** A rotated-out key still accepted until old_key_until (ingest.rotateKey grace window); absent once it ends. */
  old_key_prefix?: string;
  old_key_until?: number;
  /** When the rotated-out key last carried a batch, and the events it carried since the rotation (convex ingest applyBatch). */
  old_key_last_at?: number;
  old_key_events?: number;
  fingerprint_prefix?: string;
  config?: { org?: string; projects?: string[]; project_id?: string; environments?: string[]; allowed_origins?: string[] };
  /** Where the vendor's own app shows this source's project (PostHog: `<host>/project/<id>`). */
  vendor_web_url?: string;
  promote: Transition[];
  status: SourceStatus;
  last_error?: string;
  last_event_at?: number;
  last_poll_at?: number;
  events_today?: number;
  dropped_today?: number;
  /** Analytics events counted per name and hour (eventNameRows reads them). */
  event_names?: { name: string; buckets: { hour: number; count: number }[] }[];
  groups_open?: number;
  /** The source's groups by status as of groups_counted_at (convex ingest.ts recountSourceGroups); ignored holds muted. */
  group_counts?: { open: number; resolved: number; ignored: number };
  groups_counted_at?: number;
  /** The last 30 UTC days' counters, oldest first, today's included (convex ingest.ts withDayCounters). */
  days?: { day: string; events: number; dropped: number }[];
  /** The last 48 hours of the same count, hour starts in epoch ms, oldest first (convex ingest.ts withHourCount). */
  hours?: { hour: number; events: number }[];
  /** A CI source's finished runs, oldest first (contracts/volumeWatch CiRunFact): its failure rate and run time series. */
  ci_runs?: { at: number; ok: boolean; duration_ms?: number }[];
  /** A PostHog or Sentry source's bulk import of its recordings (convex sources/replayBackfill.ts). */
  replay_backfill?: ReplayBackfill;
  /** PostHog: how many imported copies are cut short of their recording, of unknown reach, and the one being read now (convex replayRest tally). */
  /** convex event_sources.replay_rest: `cut` and `reading` are live; `prev` the recount before the last (`counted` at `at`); `queue` the sweep's next recordings. */
  replay_rest?: { cut: number; unknown: number; reading?: string; waiting_until?: number; at: number; counted?: number; prev?: { cut: number; at: number }; queue?: string[] };
  /** What agents may do through it (Apps tab). Expired entries stay until the next write; read with activeGrant. */
  grants?: OpsGrant[];
  /** An app connector's watches: when each last polled and how it went. */
  watch_state?: WatchState[];
  manifest_fetched_at?: number;
  created_at: number;
  updated_at: number;
};

export type OpsGroup = {
  _id: string;
  workspace: string;
  source_id: string;
  short_id: string;
  kind: GroupKind;
  fingerprint: string;
  title: string;
  culprit?: string;
  level?: string;
  status: GroupStatus;
  first_seen: number;
  last_seen: number;
  count: number;
  users?: number;
  /** When `users` began counting on a group older than the count; absent means since first seen. */
  users_since?: number;
  buckets: { hour: number; count: number }[];
  /** Daily counts over 90 days (GROUP_RULES.day_buckets); absent on a group the server has not written since it began keeping them. */
  days?: { day: number; count: number }[];
  first_release?: string;
  last_release?: string;
  last_sha?: string;
  regressed_at?: number;
  /** The release the regression came back in, stamped when it did; absent on older rows and releaseless sources. */
  regressed_in?: string;
  resolved_at?: number;
  resolved_in?: string;
  /** What resolved it: a person (resolved_by), a check or metric's own recovery, or the vendor. Absent on rows resolved before it was kept. */
  resolved_via?: "person" | "recovered" | "vendor";
  resolved_by?: string;
  /** A check or metric's flips to failing over the last 7 days, oldest first. */
  failed_at?: number[];
  last_transition?: Transition;
  last_transition_at?: number;
  external?: { provider: string; id: string; url?: string };
  signal_task_id?: string;
  /** The session a person started on this group from its page (ingest.setGroupFix), and when. */
  fix_conversation_id?: string;
  fix_started_at?: number;
  /** How many samples the server holds for it, so a page can tell "still reading" from "none kept". */
  sample_count?: number;
  /** A job's failures by what they said (failureMessageKey), counted since the tally began: the min first_seen. Absent on other kinds and older rows. */
  messages?: { key: string; count: number; first_seen: number; last_seen: number }[];
  /** last_ok_*: a check's last passing reading, with the commit and branch a CI run passed at. */
  meta?: { ok?: boolean; value?: number; threshold?: number; direction?: "above" | "below"; metric_watch_id?: string; last_ok_at?: number; last_ok_sha?: string; last_ok_branch?: string };
  updated_at: number;
};

export type OpsSample = {
  _id: string;
  group_id: string;
  source_id: string;
  at: number;
  message?: string;
  stack?: string;
  level?: string;
  url?: string;
  user?: { id?: string; email?: string; name?: string };
  tags_json?: string;
  context_json?: string;
  release?: string;
  environment?: string;
  replay_external_id?: string;
  replay_id?: string;
};

/** An ingestion row of the external_events timeline. */
export type OpsEvent = {
  _id: string;
  workspace: string;
  source: string;
  kind: string;
  title: string;
  sha?: string;
  source_id?: string;
  group_id?: string;
  url?: string;
  data?: {
    transition?: Transition;
    group_kind?: GroupKind;
    group_short_id?: string;
    source_name?: string;
    provider?: SourceProvider;
    count?: number;
    level?: string;
    release?: string;
    environment?: string;
    value?: number;
    threshold?: number;
  };
  /** A deploy marker names the deploy object it recorded or finished (dp-N, deploys.md). */
  meta?: { deploy?: string };
  created_at: number;
};

export type OpsReplay = {
  _id: string;
  short_id: string;
  workspace: string;
  source_id: string;
  source_name: string | null;
  provider: ReplayProvider;
  external_id: string;
  url: string | null;
  user: { id?: string; email?: string; name?: string } | null;
  started_at: number;
  duration_ms: number | null;
  counts: { clicks: number; errors: number; failed_requests: number };
  /** Activity strip, failure marks, rage clicks, active time (shared/replay/list.ts); null until the stream is read. */
  shape?: ReplayShape | null;
  /** What the vendor says of it (length, activity, browser, OS, device, country, referrer); absent from an older backend. */
  facts?: ReplayFacts | null;
  group_ids: string[];
  chunks: number;
  /** DOM chunks: the page capture the player plays. 0 means the replay reads as text only. */
  dom_chunks?: number;
  dom_bytes?: number | null;
  /** How far an imported copy reaches; below the vendor's length when the import stopped short. Absent from an older backend. */
  captured_ms?: number | null;
  /** A long recording's later parts being read in the background: blobs read of how many, and whether it waits on a rate limit or stopped. Absent from an older backend. */
  import_rest?: { next_blob: number; blobs: number; retry_at: number | null; error: string | null; updated_at: number } | null;
  has_timeline: boolean;
  imported_at: number | null;
  converter_version?: number | null;
  vendor_refresh_after?: number | null;
  /** Why the vendor is waited out until vendor_refresh_after (shared VENDOR_REFRESH_WHYS). Absent from an older backend. */
  vendor_refresh_why?: import("@codecast/shared/contracts/replay").VendorRefreshWhy | null;
  updated_at: number;
};

/** What a replay browse counted (replays.browse), keyed by workspace and filter (useSyncOps replayBrowseKey). */
export type OpsReplayTally = {
  _id: string;
  workspace: string;
  total: number;
  /** The scan stopped short: `total` is a floor. */
  capped: boolean;
  people_total: number;
  people: ReplayPerson[] | null;
  /** People known only by an id, before the identified-only filter. Absent from an older backend. */
  people_anonymous?: number;
  /** With the rage filter on: recordings the filter could not test (no shape read yet). */
  rage_unchecked?: number;
  /** When the oldest match started. Absent from an older backend. */
  oldest_at?: number | null;
  /** Recordings every other filter keeps that the active-time floor leaves out. Absent from an older backend. */
  below_active?: number;
  /** Each environment filter's values with their counts, over what every other filter keeps. Absent from an older backend. */
  facets?: Record<ReplayEnvKey, [string, number][]>;
};

export type OpsReplayTimeline = {
  _id: string;
  groups: { _id: string; short_id: string; kind: GroupKind; title: string; status: GroupStatus }[];
  timeline_md: string | null;
  timeline_at: number | null;
};

export type OpsWatch = {
  _id: string;
  workspace: string;
  source_id: string;
  short_id: string;
  name: string;
  query_kind: WatchKind;
  query: string;
  /** Absent: a plain series a goal reads, with no alert line. */
  threshold?: number;
  direction: WatchDirection;
  unit?: string;
  interval_ms: number;
  status: "active" | "paused";
  points: { at: number; value: number }[];
  state: "ok" | "alert";
  group_id?: string;
  last_error?: string;
  history?: MetricWatchHistory;
  /** The monitor (shared/contracts/metricMonitor.ts): reads in a row that flip the state, a warning level, failed reads that count as missing data, a mute. */
  eval_reads?: number;
  warn?: number;
  no_data_after?: number;
  muted_until?: number;
  /** What its alert does (contracts/metricMonitor alertRoute); absent: the source's rule. */
  on_alert?: "task" | "timeline";
  /** Who else the alert reaches and what more it does (contracts/metricMonitor AlertNotify). */
  notify?: AlertNotify;
  /** The running alert's delivery state (convex metricAlerts.ts). */
  alert_episode?: { at: number; notified_at: number; thread_root?: string };
  /** What each alert did, newest last. */
  deliveries?: AlertDelivery[];
  /** Failed reads in a row. */
  missed?: number;
  last_value: number | null;
  last_at: number | null;
  source_name: string | null;
  source_short_id: string | null;
  updated_at: number;
};

export type OpsGrant = { action: string; granted_by: string; granted_at: number; until?: number; via?: "session" | "api_token" };

export type WatchState = { key: string; polled_at: number; last_error?: string; paused?: boolean };

/**
 * sources/app.capabilities, keyed by the source _id. The page reads the
 * manifest from here and nothing else: grants, watch state and status live on
 * the source's own row (OpsSource), which every window keeps current.
 */
export type OpsApp = {
  _id: string;
  source: { _id: string; short_id: string; name: string; provider?: SourceProvider; status: SourceStatus; last_error?: string };
  manifest_json: string | null;
  manifest_fetched_at: number | null;
  grants: OpsGrant[];
  watch_state: WatchState[];
};

export type OpsAppCall = {
  _id: string;
  source_id: string;
  user_id: string;
  conversation_id?: string;
  kind: "read" | "do";
  name: string;
  args_hash: string;
  status: "ok" | "error" | "denied";
  http_status?: number;
  error?: string;
  ms: number;
  bytes: number;
  created_at: number;
};

/** One GitHub Actions run of a CI check issue as GitHub tells it (convex ciRuns.ts ci_run_details). */
export type OpsCiRun = {
  _id: string;
  repository: string;
  run_id: string;
  fetched_at: number;
  title?: string;
  event?: string;
  actor?: string;
  attempt?: number;
  started_at?: number;
  duration_ms?: number;
  jobs: { id: string; name: string; conclusion?: string; duration_ms?: number; url?: string; steps: { number: number; name: string; conclusion?: string }[] }[];
  annotations: { job: string; level: string; message: string; title?: string; path?: string; line?: number }[];
  log_job?: string;
  log_tail?: string;
  log_error?: string;
  /** Why the read came back short: no installation, no Actions read permission. */
  error?: string;
};
