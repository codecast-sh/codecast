// The rows the Ops page holds in the store, as the ingest, replay, metric and
// app functions return them (packages/convex/convex/ingest.ts sourceView and
// groupView, replays.ts replayView, metrics.ts watchView, sources/app.ts).
// Types only: the server is the shape's owner.
import type { GroupKind, GroupStatus, SourceProvider, SourceStatus, Transition, WatchDirection, WatchKind } from "@codecast/shared/contracts/ingest";
import type { ReplayBackfill, ReplayProvider } from "@codecast/shared/contracts/replay";

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
  fingerprint_prefix?: string;
  config?: { org?: string; projects?: string[]; project_id?: string; environments?: string[]; allowed_origins?: string[] };
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
  /** A PostHog or Sentry source's bulk import of its recordings (convex sources/replayBackfill.ts). */
  replay_backfill?: ReplayBackfill;
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
  buckets: { hour: number; count: number }[];
  first_release?: string;
  last_release?: string;
  last_sha?: string;
  regressed_at?: number;
  resolved_at?: number;
  resolved_in?: string;
  last_transition?: Transition;
  last_transition_at?: number;
  external?: { provider: string; id: string; url?: string };
  signal_task_id?: string;
  meta?: { ok?: boolean; value?: number; threshold?: number; direction?: "above" | "below"; metric_watch_id?: string };
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
  group_ids: string[];
  chunks: number;
  has_timeline: boolean;
  imported_at: number | null;
  updated_at: number;
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
  threshold: number;
  direction: WatchDirection;
  interval_ms: number;
  status: "active" | "paused";
  points: { at: number; value: number }[];
  state: "ok" | "alert";
  group_id?: string;
  last_error?: string;
  last_value: number | null;
  last_at: number | null;
  source_name: string | null;
  source_short_id: string | null;
  updated_at: number;
};

export type OpsGrant = { action: string; granted_by: string; granted_at: number; until?: number; via?: "session" | "api_token" };

/** sources/app.capabilities, keyed by the source _id. */
export type OpsApp = {
  _id: string;
  source: { _id: string; short_id: string; name: string; provider?: SourceProvider; status: SourceStatus; last_error?: string };
  manifest_json: string | null;
  manifest_fetched_at: number | null;
  grants: OpsGrant[];
  watch_state: { key: string; polled_at: number; last_error?: string }[];
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
