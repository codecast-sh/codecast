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
  provider                   sentry | posthog | sdk | http | app, which a person adds, and github, which codecast
                             creates itself (github-ci, X7); createSource refuses github and the name github-ci
  name                       unique per workspace, used by --source filters
  connection_id?             app_installations row holding the credential (sentry, posthog, app)
  ingest_key_hash?           sha256 of the write-only ingest key (sdk, http)
  key_prefix?                first 8 chars of the key, shown in the UI
  fingerprint_prefix?        e.g. "union": promoted signals file as union:<kind>:<fp>, the scheme line finders
                             use; the group keeps the bare <kind>:<fp> (groupFingerprint, X6)
  config                     non-secret, what it reads inside its connection: org, project slugs, project_id,
                             environments, sample rates, allowed_origins (the browser origins the door
                             accepts, X2). Host and base_url are the connection's alone. Checked per
                             provider (sourceConfigProblem); a bad value is refused, never replaced

  manifest_fetched_at?       when the app connector manifest (X8) was fetched; the manifest itself is
                             in app_manifests (keyed by source), off the row every query reads
  next_watch_at?             when the earliest manifest watch is due; the watch cron reads by it
  grants?                    [{ action, granted_by, granted_at, until?, via? }] the actions a person allowed (X8);
                             via is session (the web) or api_token (their CLI)
  watch_state?               [{ key, polled_at, cursor?, last_error? }] one per manifest watch (X8)
  promote                    which group transitions become signals (X6), default on for new and regressed errors
  status                     active | paused | error, last_error
}

event_source_stats {         one per source: what moves on every batch and poll, kept off the source
  source_id, workspace       row so a batch does not re-run every query that reads the source
  counters_day               the UTC day the *_today counts are for; a new day reads as zero
  events_today, dropped_today, groups_open, last_event_at, last_poll_at
  event_names?               analytics event names counted per hour, never stored (X2)
}
```

A workspace holds one app connector: its base url (and a secret, if it has
one) are the workspace's one `app` connection (`connectionIdForSource`), so a
second app source would call the same app, and `createSource` refuses it.

Credentials live in `app_installations` (`oauthConnectorsSchema.ts`), the one
credential table, through a new token connector (`tokenConnectors.ts`): a pasted
token is validated by a live call in an action, encrypted with the googleOAuth
AES-GCM helpers under its own HKDF info string and the deployment key
`CONNECTION_SECRETS_KEY`, and stored confirmed. Non-secret settings go in a new
optional `config` field. `appDescriptors.ts` gains `sentry`, `posthog` and `app`
with `connectKind: "token-paste"` (`app` with `tokenOptional`: its secret is
optional, X8 signed requests); `appConnections.connectedAt` answers for
every `app_installations` provider from one registry, not literal branches.
Tokens never leave the backend. `CONNECTION_SECRETS_KEY` is a Convex
deployment env var holding at least 32 random bytes (for example
`openssl rand -base64 32`); without it `connectWithToken` refuses with "Token
connections not configured", and rotating it orphans every stored token
connection, so people reconnect.

A connection is a write, so it names its workspace. A team connection takes
an explicit `team` (an id, or a name among the caller's own teams,
`connectTarget`); without one, or with a team the caller is not in,
`connectWithToken` refuses and lists their teams. It never falls back to
`active_team_id` or `users.team_id`. The web passes the workspace being looked
at; the CLI needs `cast integrations connect <provider> --team <name>` or
`--personal`.

**Lost connections** (`lib/sourceHealth.ts`). Every adapter that polls through
a connection (app watches and the manifest refresh, the Sentry poll, PostHog
metric watches) follows one rule: a poll that finds no connection, cannot read
it, or gets a 401 or 403 from the vendor puts the source in `error` with
`last_error` naming the cause (`markConnectionLost`, through the
`ingest.sourceConnectionLost` mutation from an action). Every poller reads
only active sources, so polling stops there: no fetch and no audit row on
later ticks. A paused source stays paused. Storing a connection again
(`storeTokenConnection`) resumes every errored source of that provider in its
workspace (`resumeSourcesOnConnect`; an app source also refetches its
manifest, and a source naming a deleted connection row reads through the new
one), and so does a person's resume (`cast sources resume`, or Resume on the
Ops source list). `cast sources ls` and the web source list print the status
and `last_error`.

Write-only ingest keys (`cc_ing_<random>`) are safe to ship in a browser
bundle. Only the hash is stored; the key is shown once and can be rotated.

**Committed config: codecast.json.** A product sets up codecast with no env
vars and no shared secret in its own deployment. Everything it needs is in a
committed `codecast.json` (schema and merge in
`packages/shared/contracts/codecastConfig.ts`), which holds nothing secret:

```
{
  "endpoint": "https://...",          only when not codecast prod (https://convex.codecast.sh/cli/ingest)
  "ingestKey": "cc_ing_...",          the keyed source's write-only key, public by design like a Sentry DSN
  "sources": { "<name>": { "id": "src-N", "workspace": "team:<id>" } },
  "replay": { "dom": "off", "sampleRate": 0 }   optional; the browser recorder's settings (X5)
}
```

`cast sources add` and `cast sources key rotate` write it (`packages/cli/src/
codecastJson.ts`): `--write <path>` names the file (a directory means its
codecast.json), otherwise the nearest existing codecast.json from the working
directory up to the checkout root, else one at the root; `--no-write` writes
nothing, and outside a checkout nothing is written and the command says so.
The merge records the source under its name, a keyed source's new key (one
key per file; a new one replaces the old and the command says so) and a
non-prod endpoint, keeps a `replay` block as it is, keeps key order stable,
and prints every change; a file
that does not parse, or carries a key the schema does not know, is left
alone. The web's Add source shows the same file (`codecastJsonFor`,
`components/ops/opsModel.ts`). Readers: the platform SDK
(`createCodecastSink({ config })`, `initAnalytics({ codecastConfig })`), the
verifier (X8) and Union's client. An explicit value or env var still wins
over the file, as an override. `cast sources test` reads the key from the
file before `$CODECAST_INGEST_KEY`. Codecast's own web reads the committed
`packages/web/codecast.json`, with `VITE_CODECAST_INGEST_KEY` as the override.

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
SDK can retry on (429, 5xx), drop the batch on (400), or stop on (401, and 403
for a refused origin). An unknown key is counted against the caller's address
(`UNKNOWN_KEY_RATE`, 30 per 10 minutes, through `ipRateLimited`); an address
past it gets a 429 before its next key is even looked up, so a right guess
earns nothing either and guessing is bounded. A known key spends nothing from
that window. A paused source answers 503 with a Retry-After, never a
stop status, so running SDKs keep backing off and resume on their own after
`cast sources resume`.

`config.allowed_origins` limits which browser pages may post with a key. With
the list set, a request whose `Origin` header is not on it gets the 403, and
the CORS answer names the caller's origin instead of `*`. Without the list any
origin may post, and a request with no `Origin` header (a server) always may.

The key ships in browser pages, so what one source can cost is capped per
hour, whoever holds its key (`SOURCE_CAPS` in `ingest.ts`): at most 200 new
groups an hour and 1,000 open; a new fingerprint past either folds into the
source's overflow group of its kind (the batch's `folded` count). At most 30
promotions an hour (past it a transition still writes the timeline and fires
triggers) and 30 new deploy markers. Replays have their own cap (X5).

An `event` item is counted, not kept: its name goes into the source row's
`event_names`, one list of hourly buckets per name over the same 72 hours a
group keeps (`countEventNames` in `lib/ingestGroups.ts`), and its props are
dropped. A source counts at most 50 names separately; a new name past that
counts under `(other)`, and a name with nothing left in the window frees its
place. `cast sources show` and the source card list the busiest names over the
last day (`eventNameRows`).

The Sentry webhook is `/api/webhooks/sentry`; PostHog has no webhook of its
own, and a PostHog destination posts to the generic door (X7). A vendor webhook
must fail closed without a secret, verify HMAC with `lib/hmac.ts`, dedupe by
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
- **regressed**: an occurrence on a resolved group, or one from a newer release than `resolved_in`. A release is ordered only when it reads as `name@1.2.3`, `v1.2.3` or `1.2.3` (`releaseParts`); a sha or `name-1.2.3` has no order and counts as newer, so `resolve --in` holds back nothing for it.
- **spike**: the current hour is at least 5 times the trailing 24-hour mean and at least 20 occurrences, with a 6-hour cooldown per group.
- **check failed / recovered**: a check flips state. A check that stays red is counted, not re-announced.
- **job failed**: a new job group, or 3 or more failures of one job within an hour, with a 6-hour cooldown.
- **metric alert / recovered**: a watched metric crosses its threshold (X7).

Only a transition writes an `external_events` row (through
`recordExternalEvent`, now carrying `workspace`, `source_id`, `group_id` and a
small generic `data` object), fires triggers (X4) and may promote (X6). An
occurrence that is not a transition only moves counts, and within a minute of
the group row's last write it moves them on the group's tally
(`event_group_tallies`) instead of the row, flushed after the minute, so the
issues list (which subscribes to the rows) re-runs at most once a minute per
busy group. A reader of one group overlays the tally (`withTally`). A
retried batch that repeats a transition already on the timeline fires nothing
again (`recordExternalEventOnce`). Each group keeps `sample_count`, so the
sample trim reads only the rows it deletes.

`last_sha` joins a group to the commit its release was built from: an
occurrence whose release has a deploy marker with a sha (in the same batch or
recorded before) stamps it, and a release with none clears it. `getGroup`
returns that commit and the session that wrote it when the reader may see it,
and `cast events show` prints it.

`external_events` stays the one timeline. Ingestion rows carry `source_id`;
`listForTeam` and the Changes scans exclude them through the
`by_team_source_created` index (`source_id` unset), the source's own timeline
reads `by_source_created`, and the workspace's reads `by_workspace_created`, so a noisy product never pushes git activity out of the team feed.
`external_events` gains a `workspace` key; access for ingestion rows is
equality on it.

## X4. Triggers

New derived names in `triggerEvents.ts`: `error_new`, `error_regressed`,
`error_spike`, `job_failed`, `check_failed`, `check_recovered`,
`metric_alert`, `metric_recovered`, `deploy`. Every transition a group kind
can make, apart from `resolved`, has a name a trigger can be armed on. `event_filter` gains `source` (a source name),
hoisted into one shared validator that schema.ts and agentTasks.ts import. The
CLI gets `--source <name|src-N>` for these names, and the web trigger form
keeps it on save. Create and edit resolve it against the sources of the
workspace the trigger fires in and store the canonical name
(`storedEventFilter`); an unknown source is refused with the known ones listed,
since a firing matches on the name and a wrong one would never fire.

A firing carries the event. `matchTaskTriggers` takes an optional `event_ref`
(external event id, title, group short id) and appends it to the task's
capped `pending_events`; the run frame lists them. They are spent when the run
ends and the trigger re-arms (`nextArmingAfterRun`), not at the claim, because
an inject run reads its frame from the row after claiming. Two transitions
before a claim still make one run, which knows about both. A firing that lands
while a run holds the trigger is appended marked `after_claim`; completion
keeps those and makes the trigger due again at once, so a transition during a
run gets the next run rather than none. An ingestion firing wakes only a
trigger whose runs land in the event's workspace: the one its project path
resolves to (`triggerWorkspaceKey`), personal when it names none, so one
team's product errors never reach a session another team can read.
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
manifest cannot pile up downloads. An assembly that could not read a chunk
signed in the last ten minutes (an upload still landing, or a PUT the SDK
retries) leaves the timeline older than the chunk list, so that chunk's own
manifest queues another. The presigned PUT signs the declared size as its
content-length, so R2 refuses another size; the hash is not signed, so
assembly still checks each chunk's sha, holds it to the 2 MB cap while
streaming it and gives up on one that inflates past 8 MB. A source opens at
most 300 new recordings an hour (`REPLAYS_NEW_PER_HOUR`); past it a sign for an
unknown replay id answers 400. A replay id outside `[A-Za-z0-9_-]` becomes a path
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

Four things read the stream (`packages/shared/replay/`); the fourth, `replayMoment` (`moment.ts`), is one moment as text (below, "Playing a replay"):

- `renderTimeline(events)`: the text timeline `cast replay show` prints and the summary stores.
- `toRepro(events, baseUrl)`: a Playwright test that replays navigation, clicks, typed placeholders and submits up to the error, then asserts the error does not happen.
- `fromRrweb(rrwebEvents)`: converts PostHog and Sentry rrweb recordings (meta, incremental mouse interactions, inputs, the console and network plugins) into the same events, so mirrored replays read the same way.

A PostHog or Sentry recording is imported the first time it is read (X7), or
all at once by a source's bulk import (`sources/replayBackfill.ts`), shaped
like the Slack history import (slack-chat-mirror.md, "Bringing channels
over"). `cast replay import --source <name> [--since 7d|30d|90d|all]`, the
source card on Settings, Integrations and the Ops Replays tab all start the
same `replayBackfill.start`. Its one state object is the source row's
`replay_backfill` (status running, done, paused or error; window, since and
an `until` pinned at the start so pages walk a set new recordings do not
shift; cursor; listed, imported, skipped, failed; last error), written once
per page, and every surface reads it (`cast sources show`, `cast replay
import --status`, the web line). One scheduled action runs one page: list 10
recordings (PostHog's `session_recordings` by offset inside `date_from` and
`date_to`; Sentry's org `replays` list by cursor inside `start` and `end`),
skip those already imported (`replays.importedReplays`), and import the rest
two at a time, each in its own action, through the same
`importVendorRecording` a read takes, with its byte caps. A page that imported
anything pauses 15 s before the next, which keeps PostHog near 150 calls a
minute. A 429 waits the vendor's Retry-After (60 s without one, 10 min at
most) and redoes the page from where it stopped: the ids it already handled
ride `page_seen`, so each recording counts once and the cursor moves only past
a finished page. Rate limited for two hours with nothing imported
(`rate_limited_since`), the import stops on that error instead of waiting
forever. A refused token pauses the import and stops the source
through `lib/sourceHealth.markConnectionLost`; ten failures in a row stop it on
the error. A stop, a pause or a stalled run (no page for 30 minutes, longer
than the longest wait plus the longest action, so a live import never reads as
stalled) continues from the cursor on the next start; `--restart` or another
window starts over.
`started_at` names the run, so a page left scheduled by an earlier run does
nothing. Imported recordings link to no groups: a Sentry replay is linked
through its issue as before, and matching a PostHog recording's errors to
groups is left out. Chunks still expire with the bucket's 30-day lifecycle
rule, so "all" brings older recordings over only for a month.

The import is paced, not cheap on the scheduler. Each recording costs up to
three actions (the page, `importOne`, and `replays.importExternal` inside
it), so 10,000 recordings are about 1,000 pages, 20,000 to 30,000 scheduled
functions and, at 15 s between pages, five hours or more. That stays inside
Convex's limits, but on a project with that many recordings prefer a window
(`--since 30d`) to `all`, and watch the scheduler backlog while it runs.

The SDK recorder (`@platform/analytics/replay`) keeps a ring buffer of the last
60 seconds and uploads it when an error happens (always), or for a sampled
share of sessions (`sampleRate`, default 0). It never records an input
value, and drops URLs matching `redactUrl`. It costs one capture listener per
event type and a throttled outline walk at navigation, nothing per mutation.
This is the lesson from the August 2026 rrweb slowdown.

Its DOM mode (`replayDom: "off" | "onError" | "sampled"`, default off) adds
the page capture the player plays, and is the one part that does cost per
mutation, so an app turns it on knowing that. `"onError"` uploads the capture
only when an error keeps the recording; `"sampled"` also uploads it from the
start in sessions the sample keeps. rrweb's record (`@rrweb/record` 2.1.7, an
optional peer, the version the player pins) is imported on demand only when
the mode is on, configured in `replayDom.ts`: no mouse movement, clicks only
among mouse interactions, scroll every 500 ms and media every 800 ms at most,
every input masked, the text of any editable region masked, `[data-private]`
blocked whole (an empty box its size), no canvas, fonts, inline images or
cross-origin iframes. A checkout (fresh full snapshot) every 30 s or 5,000
events bounds the ring: until the capture ships, the recorder holds the
current segment and the one before, so the oldest event it ships is always a
snapshot the player can start from. Each event is serialized once at upload,
its strings through the app's `scrubUrl` (per string, never over the JSON
text) and a Meta href through `cleanUrl` too. A door that keeps refusing drops
the capture back to a ring opening on a fresh snapshot; past 60 DOM chunks the
DOM recording stops and the semantic one carries on.

An app sets both in its codecast.json `replay` block (X1), which the platform
and codecast parsers read alike (a drift test holds the two, and the DOM caps,
equal). Codecast's own web ships `"dom": "off"`, `"sampleRate": 0`.

Measured in Chrome (`platform/packages/analytics/bench/replayDomBench.ts`,
2026-10-07, layout settled before each step, means over 450 steps). On a
2,000-row synthetic list (8,015 nodes), a burst of 50 text updates, 20 class
toggles and 5 rows in and out costs 0.83 ms with no recorder, 1.05 ms with the
semantic recorder and 3.5 ms with DOM mode on: about 2.5 ms per burst for
rrweb (p95 8.4 ms against 3.4 ms). A click plus a keystroke costs 0.2 ms more.
The one-off costs are larger. rrweb's start (its first full snapshot) took
51 to 66 ms and a checkout 25 ms on that page. On the codecast inbox (5,200 to
5,500 nodes, stylesheets inlined) they were 83 to 90 ms and 56 ms, so DOM mode
there is a ~56 ms long task every 30 s. Two snapshots of the inbox were
4.3 MB of JSON and 520 KB gzipped, with 17 ms to serialize at upload.

### Playing a replay

The semantic stream is what an agent reads. Beside it a recording may keep
its page capture, the raw rrweb events, so people can watch it and agents can
see frames of it. The contract every piece below shares is
`packages/shared/contracts/replayPlayer.ts`.

**Storage.** A vendor import keeps the capture (VENDOR_CONVERTER_VERSION 3,
so older copies re-import on their next read or backfill pass). It is masked
first by the semantic stream's own rule (`shared/replay/dom.ts`
`prepareDomCapture`): an input event's text, a field's value attribute, a
textarea's text and every text node under `[data-private]`, an editable
region or rrweb's and the vendors' block classes become stars of the same
length, in snapshots, added nodes and later mutations, and a Meta href goes
through `cleanUrl`. A capture with no full snapshot is not kept (nothing could
draw it). The masked events are packed into gzipped chunks of about 6 MB of
JSON (`REPLAY_DOM_LIMITS`: 8 MB gzipped per chunk, 60 chunks; a single event
past the cap is dropped) and uploaded by the adapter's own action
(`vendorReplay.storeDomCapture`, `replays.storeReplayDom`), because a capture
of tens of MB cannot ride an action's arguments. Keys are
`replays/<source>/<replay>/dom/<seq>-<sha256>.json.gz`: content addressed, in
the same private bucket, expired by the same bucket-wide 30 day rule. The row
lists them as `dom_chunk_keys` with `dom_bytes`, and `dom_t0`, the epoch ms of
the replay clock's zero. A failed upload costs the player, not the import.
A re-import that kept no capture clears the old keys.

**The replay clock.** Every time the player, a reference and the CLI speak is
ms since the stream's first event, the clock `renderTimeline` prints. For an
import `dom_t0` is the capture's first rrweb timestamp plus the stream's first
`t`; for our recorder the assembly sets it to `started_at` plus the first `t`.
The player maps an rrweb timestamp to the clock as `timestamp - dom_t0`.
rrweb draws only events strictly before the offset it is given, so a moment
is drawn one millisecond past, and an event at exactly `t` shows.

**The capability.** The player holds no codecast session.
`replays.playerLink` (an action; `/cli/replays/player-link` for the CLI)
checks the caller can read the replay and mints
`<base64url {v, r, u, exp}>.<hex HMAC-SHA256>` for one replay and one person,
good for ten minutes (`lib/replayCap.ts`). The key is derived from
`REPLAYS_R2_SECRET_ACCESS_KEY` with a fixed label, so there is no new secret
and only Convex signs or verifies. `GET /cli/replays/player?cap=` opens it,
re-checks that the named person can still read the replay (a removal lands
on the next load), and answers `ReplayPlayerManifest`: the replay's summary,
`t0` and the DOM chunks as GETs signed for a few minutes. A forged, lapsed or
revoked capability and a replay with no capture answer the same 404. The
answer carries CORS `*`: the capability is the whole authorization. The
replays bucket already allows GET from any origin.

**The player** is `infra/replay-player`, a Worker on `replay.codecast.sh`, its
own origin: customer DOM never renders on codecast.sh, nor on a.codecast.sh
where anyone's published HTML runs. `GET /p/<cap>?t=<ms>&mode=frame&controls=0&autoplay=1`
(`replayPlayerUrl`) serves a page with `script-src 'self'`,
`Referrer-Policy: no-referrer` and no caching; its script (`src/player.ts`,
bundled with `@rrweb/replay` into `public/player.js`) reads the manifest and
the chunks and hands them to rrweb's Replayer, whose iframe is sandboxed with
`allow-same-origin` only (no scripts; rrweb also turns `<script>` into
`<noscript>`). Interactive mode has a control bar (hidden by `controls=0`)
and speaks postMessage with whatever embeds it: the player posts `ready`,
`time` (on every seek and four times a second while playing), `state`,
`frame` and `error`, tagged `source: "codecast-replay-player"`, to its parent
with targetOrigin `*` (it says nothing private); the host posts `seek`
(`t_ms`, optional `play`), `play`, `pause` and `speed`, tagged
`codecast-replay-host`, and should check `event.origin` against
`REPLAY_PLAYER_ORIGIN`. Frame mode draws the page at `t`, waits for its images
and fonts (at most 4 s), exposes `window.__codecastReplay` (state, url,
visible text, size) and `window.__codecastReplaySeek(t)`, and posts `frame`.

**Frames** are rendered server side, so a cloud host sees what a laptop sees.
`POST https://replay.codecast.sh/frame { cap, times_ms }` (at most 12 per
request) first asks the manifest route whether the capability opens, so a
forged one costs one GET and no browser time, then loads the frame-mode page
in Cloudflare Browser Rendering (the Worker's `browser` binding; the account
is on Workers Paid, checked 2026-10-07 with `cf accounts subscriptions get`,
and a REST screenshot probe answered), screenshots the stage per time and
answers `{ frames: [{ t_ms, png_base64, url, outline, width, height, error? }] }`.
A full browser pool answers 429 with Retry-After. A recording is drawn at its
own size, scaled down past 1600 px.

**SDK captures** (DOM mode, above) upload through the same sign
route: `POST /cli/ingest/replay-sign/<key> { replay_id, seq, sha256, size, kind: "dom" }`
signs a DOM chunk (a gzipped JSON array of rrweb events with epoch
timestamps) under the recording's `dom/` prefix, held to `REPLAY_DOM_LIMITS`,
and lists it in `dom_chunk_keys`, never in `chunk_keys`, so the assembly never
reads it. The chunk read redirect takes `&kind=dom` too.

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

The cause is written back (`linkSignal`): the group keeps it as
`signal_task_id`, and the transition that promoted gains it as `task_id` and
`task_ids` on its `external_events` row. Every later transition of the group
is recorded with that task, so the cause task's timeline
(`externalEvents.listForTask`) shows the promotion and everything the group
did after it.

## X7. Provider adapters

**Sentry** (`sources/sentry.ts`). Connection: auth token plus org slug,
validated with `GET /api/0/organizations/<org>/`. A poll every 2 minutes
(cron, one action per source) reads unresolved issues sorted by date for the
configured projects and environments, and mirrors each into a group
(`external.provider = "sentry"`, count, first and last seen, release, level).
Status changes in Sentry (resolved, regressed) become group transitions. The
optional webhook (an internal integration's issue and error alert hooks)
removes the 2-minute lag. Reads on demand: issue detail, latest event with
stack, and the replay id when present, which is linked to the group. The
replay is imported the first time it is read (`cast replay show`, or the web
replay page opening it): the replay's detail names its project, then its
recording segments (`GET /api/0/projects/<org>/<project>/replays/<id>/recording-segments/?download`,
a list of segments, each a list of rrweb events) are read page by page, at most
10 pages and 24 MB, and go through `fromRrweb` and `replays.importExternal`.
The steps PostHog and Sentry share live in `sources/vendorReplay.ts`
(`importVendorRecording`, and `importLinked` for an existing replay row); each
adapter supplies only its read. Writes are the actions `issue.resolve`
(resolve, and reopen) and `issue.ignore`, run by `cast events resolve` and
`cast events ignore` on a mirrored group only while a person's grant covers
them, checked and audited exactly as an app connector's actions are (X8).

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
passes a query through and stores nothing.

A watch fills its past instead of waiting 60 polls for a chart
(`metrics.loadHistory` and `readHistory`, `cast metrics backfill [mw-N]
[--source s] [--days 30]`, the Metrics tab's "Load history"; a new watch
runs it on creation). An insight answers its own dated series. A HogQL
query is asked again at past instants with now() bound to each one
(`bindHogqlNow`): every now() compared straight against a column becomes
`toDateTime('<iso>Z')`, and a lower bound (`timestamp > now() - interval 1
day`) also gains `timestamp <= <instant>`, because the window must end at
the instant and not at the present. Anything else that reads the clock
(today(), now('UTC'), toStartOfDay(now()), arithmetic around the bound, no
now() at all) is refused with the reason on the watch, since binding it
would answer a different question. Instants run back from the oldest point
the watch holds, a day apart when the query's window is a day or more and
one interval apart otherwise, within `--days` and at most the 60 the row
keeps. Each is read through `fetchMetricValue`, the poll's own read, newest
first; a 429 is retried after its Retry-After, and a read that stops partway
keeps what it has and says why. Watches on one source start 20 s apart.
Past points go under the polled ones (`mergeMetricHistory`, oldest first)
and never pass through the group upsert: history fires no alert and the
watch's state and group follow the live polls alone. Recordings: `cast replay ls
--source posthog` lists them from the API; `show` imports one (snapshots to
`fromRrweb` to chunks and `timeline_md`) the first time it is read, and
`cast replay import` brings every retained one over (X5). Each PostHog and
Sentry call keeps its status and Retry-After (`VendorCallError`,
`lib/tokenHttp` `retry_after_ms`) so the bulk import can wait out a 429 and
stop on a refused token. A PostHog
destination webhook can post actions to the generic door.

**Generic HTTP** (`provider: http`). Any system that can POST JSON uses the
ingest door with its key. Documented with curl.

**GitHub CI** (`provider: github`, name `github-ci`). CI on a repository's
default branch arrives through the GitHub App's webhook
(`/api/webhooks/github-app`) with no setup. `processWorkflowRunEvent` hands
every completed `workflow_run` to `defaultBranchCiRun` (githubWebhooks.ts),
which takes a run only when its `head_branch` is the payload repository's
`default_branch`, its event is not a pull request one, and its head
repository is the repository itself (a pull request from a fork's `main`
reports `head_branch: main` too). Pull request runs stay the PR pipeline's
(`pr_check_failed`, `pr_checks_green`) and never touch this source. A
cancelled, skipped, neutral, stale or action_required run says nothing about
the branch and is dropped; success is green, any other conclusion (failure,
timed_out, startup_failure) is red. `check_suite` is not read here: an
Actions suite does not name its workflow.

`ingest.recordCiRun` files the run. The source is the team workspace's (the
team `resolveTeamForRepository` routes the repository to; a repository no team
routes to files nowhere), created on the first run with the team's earliest
admin as owner and `promote: []`, so it fires triggers but files no cause
until a person turns promotion on with `cast sources update`. It is listed by
`cast sources ls` like any other, and pausing it stops CI filing. A person's
own source already named `github-ci` keeps the name and CI then files nowhere.
Each run is one `check` occurrence through `upsertGroup`, the path every feed
shares: one group per repository and workflow, fingerprint
`ci:<repo>:<workflow>` (`ciCheckFingerprint`, stored as
`invariant:ci:<repo>:<workflow>`), so a red run after red is counted, a
flip announces `check_failed` or `check_recovered`, and a green first run is on
record without announcing. Runs are judged by `run_started_at` (a re-run
attempt restarts it): a run that started no later than the group's
`last_seen` (an older run finishing after a newer one, a redelivery) is
skipped. The timeline row carries the repository, branch, sha and run url,
and the firing passes the repository, so `--source github-ci` and `--repo`
both filter triggers. `--source github-ci` is accepted in a team workspace
before the first run creates the source (`triggerSourceName`).

## X8. App connector

The product declares what codecast may read and do. `GET <base_url>/codecast/manifest`
(signed, below) returns:

```
{ name, version,
  readers: [{ name, title, description, method, path, input: JSONSchema, output_hint? }],
  actions: [{ name, title, description, method, path, input: JSONSchema, idempotent: boolean, risk: "low"|"high" }],
  watches: [{ reader, every: "5m"|"1h"|..., kind: "check"|"job", map: { id, ok, title?, detail?, at? } }] }
```

Each `map` entry names a field of the reader's rows. `at` is required on a job
watch: the time the failure happened, used as the poll cursor, so a failure
listed again on the next poll counts once. A watch missing a required field is
dropped, and the manifest parse reports why.

Connecting stores the base url (and a secret, when one is given) as an
`app_installations` row (`provider: "app"`), fetches and caches the manifest
in `app_manifests`, and refreshes it daily or on `cast connector refresh`.
`cast sources add app <name> --base-url <url> --team <t>` (and the web's Add
source, kind App) creates the source and its connection in one step, with no
secret: `createSource` stores a signed connection (`connectSignedApp` in
`ingest.ts`, through `tokenConnectors.storeConnection`) in the same
transaction, and keeps an existing connection to the same base url as it is,
secret and all. `cast integrations connect app --base-url <url> --signed`, or
leaving the secret empty on the web form, makes the same connection on its
own. A signed connection is not called when it is made: the app accepts the
signature only once its codecast.json names the source, so the manifest is
fetched when the source exists, and a refusal then puts the source in `error`
saying which source and workspace the app's codecast.json must name; after
the app deploys, `cast connector refresh` recovers it.

**Signed requests.** Codecast signs every request it makes to an app
connector (the manifest, `read`, `do`, watch polls) with one Ed25519 key, so a
product verifies codecast with no shared secret. The scheme is one module,
`packages/shared/contracts/codecastSignature.ts`. Headers:
`Codecast-Signature` (base64url Ed25519 signature), `Codecast-Key-Id`,
`Codecast-Timestamp` (unix seconds), `Codecast-Source` (src-N),
`Codecast-Workspace` (`team:<id>` or `user:<id>`), `Codecast-Nonce` (16
random bytes, base64url), beside `X-Codecast-Actor`. The signed bytes are the
UTF-8 of seven lines joined by `\n`:

```
codecast-signature-v1
<METHOD, uppercase>
<path and query as requested>
<lowercase hex sha256 of the body bytes, of the empty string without a body>
<Codecast-Timestamp>
<Codecast-Source>
<Codecast-Workspace>
<Codecast-Nonce>
```

The private key is `CODECAST_SIGNING_KEY`, a Convex deployment env var on
codecast's side only (`convex/lib/codecastSigning.ts`): one private Ed25519
JWK with a `kid`, or a JSON array of them. The first signs and every one is
published as a JWKS at `GET /.well-known/codecast-keys.json` on the Convex
site (the Caddy proxy forwards `/.well-known`; cached an hour). Generate one
with `bun packages/convex/scripts/codecast-signing-key.ts <kid>`. To rotate,
put the new key first in the array (a verifier refetches the key set when a
request names a kid it has not seen), then drop the old one once its last
requests are past the 5 minute window. WebCrypto Ed25519 runs in Convex's
default runtime, so no dependency is added. Without the env var nothing is
published or signed: a connection with a bearer secret still works, and a
signed connection's calls fail before anything is sent, naming the env var.

A verifier accepts a request when the signature verifies under the published
key the kid names, the timestamp is within 5 minutes of its clock, the nonce
was not seen in that window (an in-memory memory; only a valid signature
spends a nonce), and `Codecast-Source` and `Codecast-Workspace` name a source
its codecast.json lists. Two copies verify: `@platform/analytics/codecast-verify`
(`createCodecastVerifier({ config })`, `verify(request)` for a Fetch Request or
`verifyParts` for any server; fetches and caches the key set) for any product,
and Union's inline copy (`outreach/backend/src/lib/codecastSignature.ts`,
which takes no dependency). Both are drift tested against the committed
vectors (`contracts/__fixtures__/codecastSignature.vectors.json`) in
`codecastSignature.drift.test.ts`; Union's half runs where that checkout
exists and is skipped in CI. A path rewriting proxy in front of an app must
hand its verifier the path codecast requested.

A bearer secret stays supported for apps that prefer one: a connection made
with a secret sends it as `Authorization: Bearer` beside the signature.

- `cast connector readers|actions <source>` lists them. The token is `connector` because `cast app` already drives the codecast app itself.
- `cast connector read <source> <reader> [--arg k=v ...] [--args -] [--json]` calls the reader from a Convex action, signed (and with the secret, if the connection has one). The response goes back to the caller and is not stored. Output is capped at 256 KB.
- `cast connector do <source> <action> ...` runs only when the action is granted. A high-risk action also needs `--yes` per call. A non-idempotent action takes an idempotency key, sent as a header.
- Every call writes an `app_calls` row: who (session, person), reader or action, args hash, status, ms, bytes. Bodies are not stored.

**Grants are a person's.** One grant model covers every write codecast makes
outside itself: the source's `grants` list, keyed by action name. An app
connector's actions are the ones its manifest declares; a vendor source's are
fixed (`VENDOR_ACTIONS`: Sentry's `issue.resolve` and `issue.ignore`). A grant
may run for a while (`until`) and records who made it. Granting and revoking
take a signed-in web session, a person in the browser under Ops, Apps
(`sources/app.ts` `grant` and `revoke`, reached from the web through dispatch);
a call carrying an api token is refused, because an agent runs with one and
must never approve its own writes. A grant an api token made before this rule
counts for nothing. `cast connector grant|revoke` only print the page where a
person does it (`/ops/apps?app=<src-N>`) and exit non-zero. Every outside write,
an app's `do` and a Sentry status change alike, passes the one check
`writeRefusal` (`@codecast/shared/contracts/appConnector`), and a refusal names
that page.
- Watches turn polled readers into `check` or `job` groups, which is how Union's invariants and job failures arrive without codecast reading its database. A watch that fails (an HTTP error, rows that do not map) records `last_error` in `watch_state` and an error row in the call audit, and nothing else: the source stays `active`, no group or transition is written, no trigger fires. A lost connection is different (X1, Lost connections): no connection, or a 401 or 403 from the app, stops the source in `error` after at most one audited call, and the watches are not polled again until a connection is stored or a person resumes it.

Raw SQL is never a reader.

## X9. Union parity

| Aivery sees or does | Codecast |
|---|---|
| Slack DMs, mentions, threads | chat mirror plus anchor (shipped) |
| Huddle transcripts | `cast calls` (shipped) |
| Check-in every 3h | `trigger --every 3h` (shipped) |
| CI failed | `pr_check_failed` on pull requests; on the default branch `check_failed` and `check_recovered` from the system `github-ci` source, one group per repository and workflow, with no setup (X7) |
| Claude Code sessions: create, read, send, kill | `cast spawn --subagent`, `read`, `send`, `kill` (shipped) |
| Job failures (`job_failed` activities) | SDK `job_failed` from `logError`, plus a `jobs.failed` watch |
| `error_logs` and Sentry | SDK errors from `logError` and a Sentry source |
| Invariants (61 checks, every 6h) | an `invariants.list` watch on the app connector |
| `read_history` over contacts, calls, emails | app connector readers `history.timeline`, `history.search`, `history.item` |
| `rerun_job`, `cancel_job` | app connector actions `jobs.rerun`, `jobs.cancel` (granted) |
| AgentWatch findings and spotlights | the line (signals, causes, owned by the line sessions) |
| Admin chat with page context | out of scope for this plan; noted in the parity doc |

The Union side is one router (`outreach/backend/src/routes/codecast.ts`)
reached only by a request codecast signed for a source in Union's committed
`outreach/backend/codecast.json` (`lib/codecastSignature.ts`, checked in
`middleware/auth.ts`; a `CODECAST_CONNECTOR_KEY` bearer is an optional
fallback when that env var is set), with its own service identity and the
`aiveryRoutePolicy` deny-list, readers and actions that point at existing
routes, two new job routes, and one call in `logError`. Union sets no env var
for codecast: `lib/codecastConfig.ts` imports codecast.json statically (so
`bun build` bundles it), and `CODECAST_INGEST_KEY` and `CODECAST_INGEST_URL`
are optional overrides (an empty `CODECAST_INGEST_KEY` turns the hook off).
Its ingest client (`src/lib/codecastIngest.ts`) sends `GIT_SHA` (CI's short
sha) as every batch's release, and the api process posts one `deploy` item at
boot (`postDeployToCodecast` in `src/index.ts`, fire and forget, skipped
without a key or a built sha) whose version and environment are that same release and
errorLog's environment, so `last_sha` joins Union error groups to their
commit. Every api machine of a rollout announces; the door's version and
environment dedupe keeps it one marker, and the other process groups (worker,
calls, agents) never announce. The ops role on the
Union team is armed on `error_new`, `error_regressed`, `job_failed`,
`check_failed` (which covers both its app connector's invariants and CI on
main from `github-ci`) and every 3h, and its standing text covers what Aivery's ops
prompt does with `cast` verbs. Retiring Aivery is the human's call, asked once
parity is verified end to end.

## X10. Surfaces

**CLI**: `cast sources` (ls, add, show, key rotate, pause, resume, rm, test),
`cast events` (ls, groups, show, resolve, ignore, -w), `cast replay` (ls, show,
repro, snap; `show --at 1:23` prints one moment), `cast metrics` (ls, add, show, query, rm), `cast connector` (ls, readers,
actions, read, do, calls, refresh; grant and revoke print the browser page
where a person grants), and `--source` on `cast
trigger add` and `update` (an unknown source is refused in one line, the
server's message without its stack, through `cliErrorMessage`). Every verb
takes `--json` and `--team <name|id|personal>`. An eg-N is global, so on
`events show`, `resolve` and `ignore` `--team` only narrows the lookup: a group
in another workspace is refused in one line before anything is written.
`cast sources add` takes no `--host`: where a Sentry or PostHog source reads
(host, token) is its connection's, made with `cast integrations connect
<provider>`; add only picks what to read through it (`--org`, `--projects`,
`--project-id`). An app source takes `--base-url`, which makes its signed
connection in the same step (X8). add and `key rotate` write codecast.json
(X1, `--write`, `--no-write`). An External data
subsection of the Triggers snippet teaches agents the verbs. The web trigger
form saves through `eventFilterForSave`, so a `--source` or `--repo` armed from
the CLI survives an edit.

`cast replay snap rp-N@1:23` (a stretch: `rp-N@1:00-2:30 --every 10s`, or
`--every` alone across the whole replay, at most 50 frames) mints a
capability, has the replay player render the frames server side, and writes
each PNG to the owner-only scratch directory, remembered by `callFrameRefs`
so a Read of it syncs as `Frame of the replay: rp-N@1:23`, never as the
customer's page. Beside each frame it prints, fenced as product text, the
moment (`replayMoment`): the page's URL, its visible text (the rendered
frame's, else the stream's last outline), the last few actions before it, and
the console and failed or slow requests within 5 s. A replay with no capture
says so and prints the text alone. `cast replay show rp-N --at 1:23` (or
`show rp-N@1:23`) prints the moment without a frame. A moment reference is
`rp-N@m:ss` (`parseReplayRef`, the call moment's clock grammar); an event
index form is left out because the timeline prints times, not indices.

**Web**: `/ops` with tabs Timeline (transitions across sources, with deploy and
release markers), Issues (groups, with sparklines from `buckets`), Replays,
Metrics, and Apps (each app connector's manifest and each Sentry source's
writes, with the grant toggles a person uses, and the call audit). Detail pages
`/ops/issues/:id` (stack, samples, release, commit, the session that wrote it,
cause, triggers fired, replays) and `/ops/replays/:id` (a player with a
scrubber, event list, view outline, console and network panes, and buttons to
copy the repro or start a fix session; the replay player embeds there when the
replay keeps a page capture, X5 "Playing a replay"). Source setup sits on Settings →
Integrations next to the other connections. Ingestion transitions render
inline in transcripts and timelines through `registerExternalEventStyles`.

## X11. Limits and safety

- Payloads are attacker-controlled text. Runs woken by ingestion get the event as quoted data in the frame, under a line saying so.
- Every public function authenticates itself and never returns `access_token_enc`, config secrets or key hashes (`publicFunctionSecretLeak.test.ts`).
- Codecast's signing key never leaves the deployment env; the key set route publishes only the public halves (`publicJwks`). A signed connection stores no secret at all (`access_token_enc` is empty, `tokenConnectors.SIGNED_CONNECTION`).
- Batch caps: 500 items or 1 MB per request, 20 samples per group, 72 hourly buckets, 60 metric points.
- Convex is deployed with `packages/convex/deploy.sh` before any web or CLI push that calls new functions.
