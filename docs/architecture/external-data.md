# External data: sources, events, replays, metrics and app connectors

Codecast takes in what happens in a team's running product and makes it part
of the work: errors, job failures, health checks, product metrics, session
replays and the product's own data. Agents read it through `cast`, it wakes
them through triggers, it files causes on the line through `signals.ingestAs`,
and people see it in the Ops page.

Codecast does not become an observability store. Its value is the join, from
an outside fact to a release, a commit, the `Codecast-Session` trailer and the
session that wrote the code. So it keeps three shapes of data apart:

| Shape | Examples | Treatment |
|---|---|---|
| Grouped facts | an error group, a failing job, a red invariant, a metric crossing a line | Stored as `event_groups` with counts. Transitions become `external_events`, fire triggers and promote to signals |
| Raw streams | log lines, analytics events, traces | Never stored. Grouped at the door (errors, warnings) or queried in place through the source |
| Artifacts | session replays | Chunks in a private R2 bucket. Convex holds a manifest row and a cached text summary |

Business data stays in the product. The app connector reads and acts through
named readers and actions the product declares; codecast stores the call audit,
never the rows.

Litmus test: the Union ops agent (Aivery, `union-mobile/outreach/backend/src/lib/agent/agents/ops.ts`)
must be replaceable by a codecast role on the Union team that sees and does
everything it does. The parity table is in X9.

## X1. Sources

A source is one configured feed into a workspace. `event_sources`:

```
event_sources {
  workspace, team_id?        access key and routing, stamped by computeWorkspaceKey
  owner_user_id              who set it up; signals file as them (X6)
  project_id?                the codecast project its signals attach under
  short_id                   src-N
  provider                   sentry | posthog | sdk | http | app
  name                       unique per workspace, used by --source filters
  connection_id?             app_installations row holding the credential (sentry, posthog, app)
  ingest_key_hash?           sha256 of the write-only ingest key (sdk, http)
  key_prefix?                first 8 chars of the key, shown in the UI
  fingerprint_prefix?        e.g. "union": fingerprints become union:<kind>:<fp>, the scheme line finders use
  config                     non-secret: org, project slug, host, base_url, environments, sample rates
  promote                    which group transitions become signals (X6), default on for new and regressed errors
  status                     active | paused | error, last_error, last_event_at, last_poll_at
  counters                   events_today, groups_open, dropped_today
}
```

Credentials live in `app_installations` (`oauthConnectorsSchema.ts`), the one
credential table, through a new token connector (`tokenConnectors.ts`): a pasted
token is validated by a live call in an action, encrypted with the googleOAuth
AES-GCM helpers under its own HKDF info string and the deployment key
`CONNECTION_SECRETS_KEY`, and stored confirmed. Non-secret settings go in a new
optional `config` field. `appDescriptors.ts` gains `sentry`, `posthog` and `app`
with `connectKind: "token-paste"`; `appConnections.connectedAt` answers for
every `app_installations` provider from one registry, not literal branches.
Tokens never leave the backend. `CONNECTION_SECRETS_KEY` is a Convex
deployment env var holding at least 32 random bytes (for example
`openssl rand -base64 32`); without it `connectWithToken` refuses with "Token
connections not configured", and rotating it orphans every stored token
connection, so people reconnect.

Write-only ingest keys (`cc_ing_<random>`) are safe to ship in a browser
bundle. Only the hash is stored; the key is shown once and can be rotated.

## X2. The ingest door

`POST /cli/ingest/<key>` (the Caddy proxy forwards `/cli`; `/api/ingest/<key>`
is also registered for when it forwards that too), in `ingestHttp.ts`, with its
own CORS (Content-Type, Content-Encoding, Authorization). Body:

```
{ sdk: { name, version }, release?, environment?, items: [IngestItem] }   at most 500 items and 1 MB
IngestItem =
  | { type: "error", message, stack?, level?, fingerprint?, tags?, context?, url?, user?, at }
  | { type: "log", level, message, fingerprint?, context?, at }               only warn and above are grouped
  | { type: "job_failed", job, error, attempt?, job_id?, at }
  | { type: "check", id, ok, title?, detail?, at }                             invariants and health checks
  | { type: "event", name, props?, at }                                         counted per name and hour, not stored
  | { type: "deploy", version, sha?, environment?, at }
  | { type: "replay", replay_id, ... }                                          manifest updates (X5)
```

The handler verifies the key, rate limits per batch (`keyRateLimited`,
failClosed), validates sizes, and hands the batch to one internal mutation that
upserts groups. It answers 202 with `{ accepted, dropped }` and a status the
SDK can retry on (429, 5xx) or stop on (401, 400).

Vendor webhooks go under `/api/webhooks/sentry` and `/api/webhooks/posthog`:
fail closed without a secret, verify HMAC with `lib/hmac.ts`, dedupe by
delivery id, schedule the processor, and answer 200 fast.

## X3. Groups

All grouped facts share one table, so the same reader, renderer and trigger
path serves errors, jobs, checks and metrics:

```
event_groups {
  workspace, team_id?, source_id, short_id (eg-N)
  kind            error | log | job | check | metric | replay_issue
  fingerprint     source-scoped and stable; the shared helpers in signalFingerprint.ts compute it
  title, culprit?, level?
  status          open | resolved | ignored | muted
  first_seen, last_seen, count, users?
  buckets         hourly counts for the last 72 hours (a capped array), for sparklines and spike detection
  last_release?, last_sha?, first_release?
  regressed_at?, resolved_at?, resolved_in?
  external?       { provider, id, url }   the Sentry issue, PostHog insight or app reader this mirrors
  signal_task_id? the cause it promoted to
  meta            check: ok, metric: value, threshold, direction
}
```

A sample of recent occurrences (stack, context, url, tags, linked replay)
lives in `event_samples`, capped at 20 per group and pruned by a cron. Bodies
never ride list queries.

The upsert uses one rule set (`lib/ingestGroups.ts`):

- **new**: first occurrence of a fingerprint.
- **regressed**: an occurrence on a resolved group, or one from a newer release than `resolved_in`.
- **spike**: the current hour is at least 5 times the trailing 24-hour mean and at least 20 occurrences, with a 6-hour cooldown per group.
- **check failed / recovered**: a check flips state. A check that stays red is counted, not re-announced.
- **job failed**: a new job group, or 3 or more failures of one job within an hour, with a 6-hour cooldown.
- **metric alert / recovered**: a watched metric crosses its threshold (X7).

Only a transition writes an `external_events` row (through
`recordExternalEvent`, now carrying `workspace`, `source_id`, `group_id` and a
small generic `data` object), fires triggers (X4) and may promote (X6). An
occurrence that is not a transition only patches counts, so a flood costs one
patch per group per batch.

`external_events` stays the one timeline. Ingestion rows carry `source_id`;
`listForTeam` and the Changes scans exclude them through a `by_workspace_source_created`
read, so a noisy product never pushes git activity out of the team feed.
`external_events` gains a `workspace` key; access for ingestion rows is
equality on it.

## X4. Triggers

New derived names in `triggerEvents.ts`: `error_new`, `error_regressed`,
`error_spike`, `job_failed`, `check_failed`, `check_recovered`,
`metric_alert`, `deploy`. `event_filter` gains `source` (a source name),
hoisted into one shared validator that schema.ts and agentTasks.ts import. The
CLI gets `--source <name>` for these names, and the web trigger form keeps it
on save.

A firing carries the event. `matchTaskTriggers` takes an optional `event_ref`
(external event id, title, url, group short id) and appends it to the task's
capped `pending_events`; the run frame lists them and the claim clears them.
Two transitions before a claim still make one run, which now knows about both.
`agent_tasks` gets an index on `event_filter.event_type`, so a firing reads
only the triggers armed on that name.

## X5. Replays

A replay is a semantic stream, not pixels. An agent reads it as text and turns
it into a repro.

```
ReplayEvent (packages/shared/contracts/replay.ts)
  nav      { url, title }
  click    { label, role, selector, text? }
  input    { label, selector, length, redacted: true }       values are never recorded
  submit   { label, selector }
  key      { key }                                            Enter, Escape, Tab only
  scroll   { y, of }                                          coarse, at most 1 per second
  console  { level, message }                                 warn and error
  network  { method, url, status, ms }                        failures, plus anything over 2s
  error    { message, stack? }
  view     { outline }                                        visible text outline of the page, at nav and before errors, max 4 KB
  mark     { name, data? }                                    app-defined state markers
  each with t (ms since start)
```

`replays` holds one manifest row per recording: source, workspace, provider
(`sdk`, `posthog`, `sentry`), external id, url at start, user, started_at,
duration, counts (clicks, errors, failed requests), linked group ids, chunk
keys. The cached `timeline_md` (the text timeline, at most 32 KB) lives in
`replay_timelines`, keyed by replay, so a list read never carries it; only one
replay's detail reads it. Assembly is queued only while the timeline is older
than the chunk list and none is already queued (`assemble_at`), so a re-sent
manifest cannot pile up downloads. Because the presigned PUT signs no length,
assembly holds every chunk to the 2 MB cap while streaming it and gives up on
one that inflates past 8 MB. A replay id outside `[A-Za-z0-9_-]` becomes a path
segment with `~` and a hash of the raw id appended, so two ids that sanitize
alike never share a prefix. Chunks are
gzipped JSON, uploaded by the SDK straight to a private R2 bucket
(`codecast-replays`, `replaysBucketFromEnv`) through a presigned PUT from
`POST /cli/ingest/<key>/replay-sign`. Reads go through a short-lived signed
redirect after an access check. A lifecycle rule expires chunks after 30 days.
The sign route is registered as `POST /cli/ingest/replay-sign/<key>` (and
`/api/...`): Convex's router holds one handler per path prefix and the door
owns `/cli/ingest/`, so the longer prefix routes here, and the door forwards
the `<key>/replay-sign` spelling to the same handler (`replaysHttp.handleReplaySign`).
The bucket credentials are `REPLAYS_R2_ACCESS_KEY_ID` and
`REPLAYS_R2_SECRET_ACCESS_KEY` (a token scoped to the bucket alone), with
`R2_ENDPOINT` shared and `REPLAYS_R2_BUCKET` defaulting to `codecast-replays`.

Three things read the stream (`packages/shared/replay/`):

- `renderTimeline(events)`: the text timeline `cast replay show` prints and the summary stores.
- `toRepro(events, baseUrl)`: a Playwright test that replays navigation, clicks, typed placeholders and submits up to the error, then asserts the error does not happen.
- `fromRrweb(rrwebEvents)`: converts PostHog and Sentry rrweb recordings (meta, incremental mouse interactions, inputs, the console and network plugins) into the same events, so mirrored replays read the same way.

The SDK recorder (`@platform/analytics/replay`) keeps a ring buffer of the last
60 seconds and uploads it when an error happens (always), or for a sampled
share of sessions (`replaySampleRate`, default 0). It never records an input
value, and drops URLs matching `redactUrl`. It costs one capture listener per
event type and a throttled outline walk at navigation, nothing per mutation.
This is the lesson from the August 2026 rrweb slowdown.

## X6. Promotion to the line

A transition listed in the source's `promote` set schedules
`internal.signals.ingestAs` with the source's owner as filer, an explicit
`{ workspace, team_id }`, the source's `project_id`, `source: <provider>:<name>`,
and the kind map: error new is `bug`, error regressed and spike are
`regression`, check failed is `bug`, job failed is `bug`, metric alert is `ux`.
The fingerprint is the group fingerprint, prefixed by the source's
`fingerprint_prefix` when set, so a Union check promoted here joins the same
cause the line-union `invariantFinder` files (`union:invariant:<id>`).
`signals.ts` does not change. A filer who has left the team pauses the source
with the reason rather than retrying.

## X7. Provider adapters

**Sentry** (`sources/sentry.ts`). Connection: auth token plus org slug,
validated with `GET /api/0/organizations/<org>/`. A poll every 2 minutes
(cron, one action per source) reads unresolved issues sorted by date for the
configured projects and environments, and mirrors each into a group
(`external.provider = "sentry"`, count, first and last seen, release, level).
Status changes in Sentry (resolved, regressed) become group transitions. The
optional webhook (an internal integration's issue and error alert hooks)
removes the 2-minute lag. Reads on demand: issue detail, latest event with
stack, and the replay id when present, which `cast replay show` imports through
`fromRrweb`. Writes (resolve, ignore) go through `cast events resolve` only on a
person's grant (X8 rules).

Sentry counts are totals, so issues fold through `applyMirror` (lib/ingestGroups.ts),
not the occurrence rules: vendor counts and hourly stats replace ours, a read
that changes nothing writes nothing, and the transition names and silences are
the same. An issue first seen before the source was created is backfill and is
never announced as new. Sentry's resolve and ignore are followed, a local mute
sticks, and a group resolved here stays resolved until Sentry shows activity
after the resolve. An open issue that drops out of the poll's list is re-read by
id (10 per run), which is how a resolve reaches the mirror without the webhook.
The webhook secret is the internal integration's client secret in
`SENTRY_WEBHOOK_SECRET`; a delivery is matched to sources by the org slug in its
URLs and the source's projects, and deduped by `Request-ID` in
`webhook_deliveries` (shared by every vendor webhook, pruned after 7 days).

**PostHog** (`sources/posthog.ts`). Connection: personal API key, host and
project id, validated with `GET /api/projects/<id>/`. PostHog stays the
analytics product: codecast keeps watched metrics, not events.
`metric_watches` rows (a HogQL query or an insight id, a threshold, a
direction, an interval) are polled, their last 60 values kept on the row, and
crossings become `metric` group transitions. `cast metrics query "<hogql>"`
passes a query through and stores nothing. Recordings: `cast replay ls
--source posthog` lists them from the API; `show` imports one (snapshots to
`fromRrweb` to chunks and `timeline_md`) the first time it is read. A PostHog
destination webhook can post actions to the generic door.

**Generic HTTP** (`provider: http`). Any system that can POST JSON uses the
ingest door with its key. Documented with curl.

## X8. App connector

The product declares what codecast may read and do. `GET <base_url>/codecast/manifest`
(bearer secret) returns:

```
{ name, version,
  readers: [{ name, title, description, method, path, input: JSONSchema, output_hint? }],
  actions: [{ name, title, description, method, path, input: JSONSchema, idempotent: boolean, risk: "low"|"high" }],
  watches: [{ reader, every: "5m"|"1h"|..., kind: "check"|"job", map: { id, ok, title, detail } }] }
```

Connecting stores the base url and secret as an `app_installations` row (`provider: "app"`),
fetches and caches the manifest on the source, and refreshes it daily or on `cast connector refresh`.

- `cast connector readers|actions <source>` lists them. The token is `connector` because `cast app` already drives the codecast app itself.
- `cast connector read <source> <reader> [--arg k=v ...] [--args -] [--json]` calls the reader from a Convex action with the secret. The response goes back to the caller and is not stored. Output is capped at 256 KB.
- `cast connector do <source> <action> ...` runs only when the action is granted. A person grants an action in the UI or with `cast connector grant <source> <action> [--until 30d]`. A high-risk action also needs `--yes` per call. A non-idempotent action takes an idempotency key, sent as a header.
- Every call writes an `app_calls` row: who (session, person), reader or action, args hash, status, ms, bytes. Bodies are not stored.
- Watches turn polled readers into `check` or `job` groups, which is how Union's invariants and job failures arrive without codecast reading its database.

Raw SQL is never a reader.

## X9. Union parity

| Aivery sees or does | Codecast |
|---|---|
| Slack DMs, mentions, threads | chat mirror plus anchor (shipped) |
| Huddle transcripts | `cast calls` (shipped) |
| Check-in every 3h | `trigger --every 3h` (shipped) |
| CI failed | `pr_check_failed`, plus `check_failed` from a GitHub Actions source for main |
| Claude Code sessions: create, read, send, kill | `cast spawn --subagent`, `read`, `send`, `kill` (shipped) |
| Job failures (`job_failed` activities) | SDK `job_failed` from `logError`, plus a `jobs.failed` watch |
| `error_logs` and Sentry | SDK errors from `logError` and a Sentry source |
| Invariants (61 checks, every 6h) | an `invariants.list` watch on the app connector |
| `read_history` over contacts, calls, emails | app connector readers `history.timeline`, `history.search`, `history.item` |
| `rerun_job`, `cancel_job` | app connector actions `jobs.rerun`, `jobs.cancel` (granted) |
| AgentWatch findings and spotlights | the line (signals, causes, owned by the line sessions) |
| Admin chat with page context | out of scope for this plan; noted in the parity doc |

The Union side is one router (`outreach/backend/src/routes/codecast.ts`)
behind a `CODECAST_CONNECTOR_KEY` with its own service identity and the
`aiveryRoutePolicy` deny-list, readers and actions that point at existing
routes, two new job routes, and one call in `logError`. The ops role on the
Union team is armed on `error_new`, `error_regressed`, `job_failed`,
`check_failed` and every 3h, and its standing text covers what Aivery's ops
prompt does with `cast` verbs. Retiring Aivery is the human's call, asked once
parity is verified end to end.

## X10. Surfaces

**CLI**: `cast sources` (ls, add, show, key rotate, pause, resume, rm, test),
`cast events` (ls, groups, show, resolve, ignore, -w), `cast replay` (ls, show,
repro), `cast metrics` (ls, add, show, query, rm), `cast connector` (ls, readers,
actions, read, do, grant, revoke, calls, refresh), and `--source` on `cast
trigger add` and `update`. Every verb takes `--json`. An External data
subsection of the Triggers snippet teaches agents the verbs. The web trigger
form saves through `eventFilterForSave`, so a `--source` or `--repo` armed from
the CLI survives an edit.

**Web**: `/ops` with tabs Timeline (transitions across sources, with deploy and
release markers), Issues (groups, with sparklines from `buckets`), Replays,
Metrics, and Apps (manifest, grants, call audit). Detail pages
`/ops/issues/:id` (stack, samples, release, commit, the session that wrote it,
cause, triggers fired, replays) and `/ops/replays/:id` (a player with a
scrubber, event list, view outline, console and network panes, and buttons to
copy the repro or start a fix session). Source setup sits on Settings →
Integrations next to the other connections. Ingestion transitions render
inline in transcripts and timelines through `registerExternalEventStyles`.

## X11. Limits and safety

- Payloads are attacker-controlled text. Runs woken by ingestion get the event as quoted data in the frame, under a line saying so.
- Every public function authenticates itself and never returns `access_token_enc`, config secrets or key hashes (`publicFunctionSecretLeak.test.ts`).
- Batch caps: 500 items or 1 MB per request, 20 samples per group, 72 hourly buckets, 60 metric points.
- Convex is deployed with `packages/convex/deploy.sh` before any web or CLI push that calls new functions.
