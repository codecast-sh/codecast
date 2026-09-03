# Sync convergence: local first replicas that provably agree

Status: design, ready for implementation (ct-47200 to ct-47205). Companion to
sync-log-migration.md, which owns transport (ordered per scope catch up). This document
owns the layer above: multiplayer sync into local first client databases that is
eventually consistent by construction, one shared computation over that data, and
monitoring that proves convergence in production over time. Code comments reference the
numbered sections below (C1, C2, ...).

## The model

Every client with a replica (web, desktop, mobile) is a local first database. The server
database is canonical; each client's store holds a replicated subset. Bucket counts and
lists are VIEWS computed locally, on the client, from the replica. Convergence needs
exactly three identities:

1. **Same data.** Within a declared working set, every replica eventually holds the same
   rows with the same field values. This is the sync layer's whole job and its only job.
2. **Same computation.** One pure module, in shared code, computes membership, fold, and
   bucket from row fields. Every replica surface calls it. The server runs the SAME
   module over canonical state, but only to produce checking data: a per row stamp map
   and a digest. Nothing the server computes is a render source on a replica client.
3. **Same parameters.** View state (show old, scope) is synced user state. Time enters
   only as a minute epoch, and the epoch a replica compares at is the one the server's
   payload names, so a device clock never enters the comparison.

The CLI has no replica of the inbox, so `inboxForCLI` renders the server's own run of
the shared module. For a client without a replica, the canonical computation is the
view. The convergence proof below concerns the replica clients.

"Provable" is operational: the server stamps the placement it derives from canonical
state; each replica computes its own placement from its replica; the two are diffed per
row, continuously, in prod. Drift is a metric with an alarm, and mismatch triggers a
bounded self heal. Eventual consistency stops being an assumption and becomes a
monitored invariant.

## Why the previous designs did not converge

Three clients of one account showed Needs Input 24, 25, and 50, and Pinned 20, 17, 20.
The July fix (`liveInboxIds` gating) and the August fix (append only sync log) each
repaired one layer. The remaining causes, verified against current code and one live
client:

1. Membership is not data. "In the inbox" is `liveInboxIds`, a per device memory of the
   last payload, with exemptions (pinned, parents, hidden, focused) that keep stale rows
   countable forever, and a no filter fallback when empty. With the synced
   `inbox_show_old` preference on (it is on for this account), the gate is skipped and
   every device counts its own never pruned cache: measured 2,270 cached rows vs 1,062
   authoritative ids on one client.
2. The server set is nondeterministic. `computeInboxSessions` mixes `Date.now()` into
   window bounds and liveness thresholds, applies a 12 hour cluster cut over a sample,
   and truncates silently. Two executions seconds apart differ on identical data.
3. Field values differ per channel. The same conversation yields different rows from
   `listInboxSessions`, `listInboxSessionsPaginated`, and `getInboxSessionsByIds`, and
   the last writer wins in the store.
4. The computation differs per surface. The panel, the sidebar badge, and mobile call
   different code paths with different passes (question lift over the whole cache,
   trigger absorption, revive stamps, focus exemptions), and mobile freezes its snapshot
   under a moving trust TTL clock.
5. Nothing measures drift.

## Design

### C1 Facts and channels

**Replication channels deliver the working set and keep it current.** The live window
query (`listInboxSessions`) delivers row bodies; the sync log delivers every semantic
transition per scope with ordered positions — hides, restores, pins, renames and hard
deletes included — and is the only healer for hide state; the completeness floor
(`listInboxSessionsPaginated`) is cut once per cold or resynced cache and stamps
`backfilledAt`; `getInboxSessionsByIds` hydrates named ids. There is no crawl on a
timer and no subtractive reconcile: the dismissed and stashed reconcile crawls, whose
clear pass read a stale hidden set as a restore, were removed (ct-47927, 2026-09-02).
The one bounded reconcile left runs only when the log had a hole (retention passed the
cursor, or no cursor existed): the recut floor cannot carry what left the inbox scan
while the client was away, so the cached rows it did not return are re-read by id
through the same authorized byIds path the log applier uses — returned rows land with
their stamps, omitted ids are gone or foreign and prune.

**The liveness overlay is the fact writer.** `sessionsLiveness` (and its team twin)
carries FACTS, never verdicts, for every row the scan shows: `agent_status`, `is_idle`,
`is_unresponsive`, `awaiting_input`, `is_connected`, `agent_started_at`, `open_tasks`,
`open_tasks_at`, `message_count`, `updated_at`, plus `last_turn_allows_park` (whether
the newest turn permits a park verdict; the server computes it from the newest message,
including the probed fallback the row's preview lacks, so the replica never needs the
message body). The overlay also carries fact rows for the live CHILDREN it probes
(subagents of shown parents), so a replica can compute parent rollups from replicated
child facts. Facts have one writer: `syncTable` strips fact fields from every other
sessions channel, so no channel can write a torn or stale value over a fresher one. The
fact field names live in one shared constant; the server strip list and the client
preserve list both derive from it, with a signature test. Every fact is explicit on the
wire, null when there is none, and the replica reads an absent fact as null. Convex drops
an undefined key, and a merge that only writes the keys it receives keeps the previous
execution's value: a "stopped" from the day a daemon died outlived the managed row and
filed a declared done session under Needs Input on every replica while the stamp beside
it said done.

Rows the scan does not cover (past a window cap, killed and unpinned, outside every
window) keep their last synced facts until a crawl or a semantic transition refreshes
the row. Those rows are also outside the stamped set, so the compare does not cover
them; C7's heartbeat reports the uncovered count so this residue is visible, and the
crawl period bounds it.

**Stamps are checking data.** Each overlay payload also stamps, per shown row:
`bucket`, `work_state`, `asking`, `below_fold`, `bucket_stale_at`, `stale_bucket`.
These are the server's run of the shared module over canonical state. A replica client
stores them in a per scope buffer (`sessionsProjection[scope]`), NEVER on the session
row, and reads them only in the compare (C6) and the recompute scheduler (C2). A source
guard bans reading them anywhere else. Because the buffer is keyed by scope, the
personal overlay and the team overlay never write the same slot, and a row's fold in
team scope can differ from its fold in personal scope without any field ping pong.

**Ask state is derived, not stored.** No conversation row field records an open ask.
The server derives it per overlay execution with zero writes: own open question or
permission prompt (from the message probe), pending `cast decide` rows (one
session_decisions read), and the child rollup (bounded child probes). The replica
derives the same thing from replicated inputs: its own `awaiting_input` fact, the
synced session_decisions collection, and its replica children's facts. This is
deliberate: an ask flips at tool prompt cadence across subagent fleets, and stamping it
on the parent row would serialize every flip on the row the message flush path already
patches, plus the scope's sync head. Write time denormalization is reserved for low
frequency transitions.

**The one denormalized fact is `armed_trigger_kind`** (`"none" | "standing" | "once"`),
written on every trigger lifecycle transition through `patchTask`, and on `webDelete`
(which must refresh the old home after the delete). An exhaustive test enumerates every
mutation that writes `agent_tasks` and asserts each path restamps the home. A client
reads an absent value as `none`; the one shot backfill has landed and trigger homes are
rare.

### C2 Determinism and time

**The epoch.** Every time term in the shared module compares against
`epoch = floor(now / 60s) * 60s`. The server evaluates at the epoch of its execution
and names it in the payload.

**Payloads are deterministic.** No payload field carries a raw execution timestamp: the
projection envelope carries `epoch`, never `Date.now()`. Two executions inside one
minute over the same data are byte identical, so Convex suppresses the push and a
stable inbox costs zero pushes between real changes. A unit test pins this. Payload age
is measured on the client from receipt time on a monotonic clock; it needs no server
timestamp.

**The replica's clock.** For the compare, the client evaluates the shared module AT THE
PAYLOAD'S EPOCH over its replica, so device clock skew cannot desynchronize the
comparison. For rendering, the client's epoch is the latest payload epoch advanced by
the local coarse tick (15 seconds, quantized to the minute); raw device wall clock
never enters the computation.

**Time flips without writes.** Convex re-executes a subscription only when a document
in its read set changes, so a payload can outlive the time thresholds it was computed
with (trust TTL expiry, idle grace, heartbeat windows). `computeBucketStale` stamps,
per row, the earliest deadline whose passing changes the bucket. The client uses
`bucket_stale_at` as a scheduling hint: when its coarse tick passes the stamp, it
recomputes that row's placement LOCALLY (the replica holds the same facts, so the same
flip falls out) and treats the payload as stale. It never renders `stale_bucket`; the
stamp exists so a passed deadline is recognizable.

**Quiet scopes get probed.** When no data changes (daemon offline, weekend, a mobile
only user), the payload freezes exactly where time driven reclassification accumulates.
When the payload age passes a bound (5 minutes) and the scope is due for a check, the
client issues one `sessionsLiveness` probe (the `_probe` arg) on a slow, budgeted
schedule to force a fresh execution. Skips for a stale payload are counted separately
in the heartbeat so "no checks ran" always names its cause.

### C3 One placement

`packages/shared/contracts/inboxProjection.ts` is pure isomorphic code (no Node or DOM
APIs, no BigInt) imported by Convex, the web store, mobile, and the daemon. It exports:

- `classifyWorkState(input)`: the one work state classifier, merging the server rules
  and the web rules (killed outranks everything; an unresolved API error banner with
  content is needs input; declared and structural rest verdicts; the settle classifier
  only files done).
- `placeInboxRow(input)`: the mutually exclusive bucket, first rule wins: dismissed,
  stashed, hidden (an anchor row that is not hard blocked), questions (asking), pinned,
  new (no messages), then the work state. Pinned outranks the work buckets, so Needs
  Input never counts a pinned row.
- `inWorkingSet`, `selectWorkingSet`, `computeFold`, `projectInbox`: membership and
  fold (C4).
- `digestProjection(entries)`: an order independent hash over
  `(id, bucket, below_fold)` triples: FNV 1a 32 per triple folded into two 32 bit
  lanes, 16 hex characters. Fold is in the digest on purpose: with show old off, the
  headline count is the shown tally, so two replicas that agree on every bucket but cut
  the fold differently are diverged, and the digest must say so. A property test
  asserts a fold flip with unchanged buckets changes the digest.
- `computeBucketStale`: the time flip stamp (C2).
- `INBOX_PROJECTION_VERSION = 3`, carried as `v` in every projection envelope. Golden
  fixtures (input rows to expected buckets, fold, and digest) are pinned in the shared
  package tests, and a second assertion ties the fixture hash to the version constant:
  a behavior change fails the fixtures, and updating the fixtures without bumping the
  version fails too. The client compares only when the payload's `v` equals its own
  constant (C6).

Consumers: the client store chokepoint (C5), `inboxForCLI` (rendering the server's own
run), and the overlay's stamping pass (C1). The store's parallel classifiers
(`categorizeSessions`, the `isSessionWaitingForInput` chain, `liftQuestions`,
`partitionOldSessions`) and the server's separate `tallyInboxRows` path are deleted,
not wrapped. The one per-row verdict a surface outside the chokepoint may read
(`classifySession`: the sidebar rank and wake signature, the sessions page, trigger
absorption, the waiting chime) is a thin adapter over `placeProjectableRow`, with the
row's facts as they stand; a source guard bans the deleted names.

**The asking rollup is one shared rule.** `rollupParentIdOf` (shared module) names the
parent a child's ask lifts: a subagent or orphan rolls up to its `parent_conversation_id`;
a plan handoff (parent pointer plus parent message) is its own member and speaks for
itself; an agent team teammate rolls up to its lead. The server pool grouping and the
replica's asking derivation both group by it, and a child's pending `cast decide` lifts
its parent on both sides.

### C4 The working set

**Membership is the shared selection, caps included.** The server's scan reads five
capped windows; an honest replica predicate must select the same rows, so the selection
is shared, not just the predicate. `selectWorkingSet(rows, epoch)` applies, over rows
that pass `shouldShowInInbox` (lifted into the shared module: drops subagent and orphan
rows, killed rows unless pinned, noise titles, completed rows with zero messages) and
are top level:

| Window | Eligibility | Sort key | Cap |
|---|---|---|---|
| recent | status active or completed, `updated_at` within 30 days of the epoch | `updated_at` desc | 200 |
| pinned | `inbox_pinned_at` set | `inbox_pinned_at` desc | 100 |
| dismissed | `inbox_dismissed_at` within 30 days, not killed | `inbox_dismissed_at` desc | 200 |
| stashed | `inbox_stashed_at` within 30 days, not killed | `inbox_stashed_at` desc | 200 |
| owned | `owned_by_me`, same status and recency rule as recent | server side only | 200 |

The caps and sort keys are shared constants; the server scan and the client selection
must agree, pinned by a test that runs both over one fixture set. The working set is
the union of the window survivors. When a window overflows, the server names it in
`truncated`, and the compare drops that window's rows on both sides (C6): a capped
window is dark to the proof, and the heartbeat counts it. The owned window's cap order
is a server side detail (owner row order) the replica does not hold, so an overflowing
owned window is likewise dropped; under the cap, ordering does not matter.

Team scope membership depends on inputs the replica does not hold (member visibility
settings, redaction). The team overlay still delivers facts and stamps for rendering
freshness, but team scope is outside the compare, stated here and counted in the
heartbeat as uncovered. Extending the proof to team scope means replicating those
visibility inputs as synced facts; that is future work, not an implied capability.

**Fold is deterministic and shared.** `computeFold(members, epoch)` computes the 12
hour gap cut over the selection's rows, sorted by `updated_at` (the overlay carries
`updated_at` as a fact, so the sort input is fresh for every covered row). Rows that
are members through a deliberate window (pinned, dismissed, stashed, owned) are exempt
from the cut. Rows outside the selection (label extras hydrated for the CLI) are fold
exempt everywhere, so the CLI and the overlay compute the same cutoff from the same
set. Fold affects default rendering and splits the tally (`shown` vs `folded`); show
old means rendering and counting `shown + folded`. Fold never changes membership.

**Fold rows ride the existing channels, not a wider payload.** The base list keeps
today's transport behavior: with show old off it omits rows under the fold cut, so
deployed bundles keep receiving today's payload and today's rendered set, and the live
channel does not grow by hundreds of enriched row bodies. This is safe because
membership never depends on the payload: the replica already holds fold row bodies (the
cache never prunes and the completeness floor was cut), the overlay keeps their
facts fresh at about thirty bytes per row, and a replica that lacks one heals it by id
(C7). Bodies for show old browsing come from `listInboxSessionsPaginated` on demand.

**View state parameterizes, never bypasses.** `inbox_show_old`, `inbox_scope`, and the
other stamped view keys stay in the synced LWW bag. Show old selects `shown + folded`
inside the shared computation. No preference may bypass the selection or widen the
counted set beyond it; a guard test asserts the chokepoint is the only reader of these
keys for counting purposes.

### C5 The client replica

**One chokepoint.** `placeInboxRows` in the store calls the shared module with (replica
rows, synced view state, epoch, declared overlays) and returns placed buckets and
tallies. Every consumer uses it: panel, sidebar badge, dock badge, active agents pill,
fleet board, thread cards, palette, mobile inbox. A source guard bans the deleted
classifiers outside it.

**The chokepoint is incremental, verified against the full computation.** A full
recompute over a never pruned cache every 15 seconds is the re-render class that pegged
the sidebar, and Hermes pays it several times over. So:

- Working set membership is an index maintained in the sync apply path (the
  SYNC_REGISTRY indexes mechanism): a row's membership changes only when a membership
  relevant field changes or a time boundary passes. Each member carries one precomputed
  expiry instant (when it ages out of its window), held in a coarse bucketed heap.
- Placement is kept per row. A deadline heap holds the server's `bucket_stale_at`
  stamps plus the bounded local overlay expiries (revive 120 seconds, triage settle).
  On a coarse tick, only rows whose deadline passed are re placed; on data arrival,
  only rows whose wake signature changed. Tallies update by delta. The digest recomputes
  only when some triple changed or the epoch advanced. When nothing moved, every
  returned ref is stable, so downstream memos hold.
- A dev mode assertion runs the full computation and asserts the incremental result
  equals it, for both membership and placement. That assertion is itself a convergence
  check in the spirit of C6.

**Declared overlays** are the only local adjustments, enumerated in one module, each
named, bounded, and excluded from the compare:

| Overlay | Effect | Bound |
|---|---|---|
| optimistic create stub | appears in Working | until the server row supersedes (altKey) |
| optimistic triage gesture | moves or removes the row | until ack or HIDDEN_OVERRIDE_SETTLE_MS |
| focused session | stays visible while open | while focused; never counted outside the working set |
| queued or pending send in the open view | Needs Input to Working | while the queue holds |
| revive request | Needs Input to Working | 120s |
| draft or blank engagement | renders a `new` row locally | rendering only, never counts |

Chip filters, label lenses, and schedule grouping are presentation over placed rows and
cannot change headline tallies. Trigger absorption stops being a pass: the
`armed_trigger_kind` fact reaches the classifier as data, identically everywhere.

**The staleness sweep is gated on overlay coverage.** The server's `is_idle` and
`has_pending` facts come from inputs the replica does not hold (`last_message_role`,
`agent_status_updated_at`, a producing subagent), so a row the latest overlay payload
stamps, while that payload is younger than the compare's payload age bound, is placed
from those facts exactly as the server placed it. The client only sweep (a quiet row
past the idle grace reads as settled; a trust stale row blanks its queue flag) applies
only to rows the payload cannot vouch for: liveness never delivered, a row outside the
payload, or a payload past the bound (the stale probe refreshes it within five
minutes). The status trust decay stays ungated: it reads the same two inputs the server
reads. The two replica simulation found the ungated sweep filing a parent with a
producing child, and a live daemon holding an unanswered message, under needs input
while the server and the CLI kept them working.

**Feeder parity.** `useSyncCore(profile)` owns the full feeder mount set: sync log
applier, live window, liveness overlay, team feeders (mounted per scope), recovery
probes, the completeness floor, the stub sweep, session decisions, client state,
current user, buckets. Web `DashboardLayout` and mobile `StoreSyncBridge` both
mount it; a guard asserts every registered feeder is in the profile. The recovery poll
calls the live window with the SAME args as the subscription, so a stalled subscription
cannot flap the store between two payload shapes. Mobile pauses the set on AppState
background and resumes with one catch up pass, replacing the document gated nonce that
never re-ticks on iOS today.

**Recovery discipline.** Every subscription pairs with an error handler and a
controller backed probe; no feeder adds a bespoke interval beyond the ones named here.

**A team files as one group.** A subagent is never its own member and rides its
present parent. An agent team teammate is a member (it holds a seat, it lists, and its
own `work_state` is what an orchestrator watches to see a worker finish) but it never
stands alone: while its lead is a member too, the teammate takes the lead's bucket
(`rideLeadPlacements`) and the lead's fold (inside `computeFold`), on the server, in
the CLI stamping and on every replica, so the team nests under the lead card wherever
the lead files and a section header count is the rows placed in that bucket, nested
ones included. A teammate the viewer pinned, stashed or dismissed on its own keeps that
place; a teammate whose lead is absent keeps its own placement and renders flat.

### C6 The compare

The compare medium is the stamp map, not an opaque hash: the client diffs its own per
row placement against the server's stamps for the same epoch. Two hashes cannot name
missing ids, exclude an optimistic gesture, or say which bucket disagreed; a per row
diff does all three.

**Gates.** A compare runs on the coarse tick only when ALL hold:

1. The payload carries a digest (`set_digest` not null; C8 kill switch).
2. The payload's `v` equals the client's `INBOX_PROJECTION_VERSION`. On mismatch, skip
   and emit a low rate `inbox_digest_version_skew` metric: a deploy skew window becomes
   silence plus a signal, never a storm.
3. Payload age (receipt clock) is under the bound; otherwise skip, count, and consider
   a probe (C2).
4. The appliers are quiescent: no committed row apply inside a short settle window
   (five seconds; a value identical re-push does not count), no in flight sync log
   range, crawl page, or recovery poll. Mid catch up divergence is ordinary eventual
   consistency, not drift. The window is short on purpose: on a busy account a real
   row change lands every 20 to 30 seconds, so a rule of "N ticks of silence" never
   held in production and the compare stayed dark. A steady state apply is not catch
   up, because the overlay re-executes on the same server change and re-stamps; the
   gate only needs to outlast the pair of pushes one change produces.
5. The replica is complete for the scope: the completeness floor has stamped
   `backfilledAt`. A cold device compares nothing until it can honestly claim the set.
6. Scope is covered (personal scope; team scope is out, C4).

**A killed row never asks.** Kill is triage: nobody can answer a torn down session's
prompt or pending decide, so the shared placement ignores an ask on a killed row (a killed
pinned row files under Pinned). The rule lives in the shared module so the server stamp and
the replica cannot disagree on it; the replica's asking derivation and the web decision
queue skip killed rows for the same reason.

**A capped window excuses membership only.** When a window overflowed its cap on either
side, a row that only that window admits may be missing on one side and selected on the
other because of the cut, so such a row is not reported missing or extra. A bucket or fold
difference on a row BOTH sides selected is always reported: the cap explains a row one side
cut, never a verdict both sides hold. On a busy account the recent window overflows every
day, and treating every recent only row as dark blinded the proof to the rows that matter.
A foreign row under a budgeted foreign scan is dark for facts and membership alike, because
the server may not have probed it.

**Procedure.** Evaluate the shared module at the payload's epoch over the replica's
selection. If no declared overlay is active and the local digest equals `set_digest`,
the check passes (the digest is the cheap short circuit). Otherwise diff per row:
drop ids affected by a declared overlay, drop rows whose only window overflowed
(`truncated`), and drop foreign rows (rows the viewer does not run) when the
`foreign_scan` flag fired. What remains decomposes into `missing` (stamped ids the
replica lacks), `extra` (local members the stamps lack), `bucket_deltas`, and
`fold_deltas`.

**Persistence rule.** A nonempty diff counts as drift, and may spend a heal, only when
it persists across two consecutive compares against payloads with distinct epochs. A
single tick landing between the base push and the overlay push is a race, not
divergence.

### C7 Heal and telemetry

**Heal is targeted.** `missing` ids heal through `getInboxSessionsByIds` for exactly
those ids; their facts arrive with the next overlay payload (a probe forces one), since
the store now holds the row for `syncOverlay` to land on. `bucket_deltas` and
`fold_deltas` on rows the replica holds mean stale facts, and facts have one writer, so
the heal is one overlay probe, not a working set refetch. `extra` ids are re-read by id
through the same `getInboxSessionsByIds` call: a row the replica still counts but the
server does not stamp is usually a field the replica holds wrong (the two replica
simulation found a pin lock that re-asserted a local pin over a remote kill, and no
channel ever re-delivered the killed row once the lock settled), so the authoritative
row lands its fields. Before that merge the heal releases every pending field lock on
the named rows that is past `HIDDEN_OVERRIDE_SETTLE_MS`: past that bound the compare's
carve-out already stops treating the lock as an intentional deviation, so the lock and
the carve-out share one bound. A row the server does not return is left exactly as it
was and stays a reported extra (deletion truth remains authorized absence).

**Bounded.** Three heals per ten minutes, jittered, fixed window. The fourth emits
`inbox_drift_persistent` and latches healing OFF for the session; a reload rearms it.
A same version computation bug then costs one telemetry event per client, not a fleet
of synchronized refetch storms.

**Telemetry.**

- `inbox_drift { missing, extra, bucket_deltas, fold_deltas, payload_age_ms, scope,
  platform }`: counts only, never ids, deduped to one event per changed digest value.
- `inbox_digest_heartbeat`, hourly: `{ checks, mismatches, heals, max_payload_age_ms,
  skips: { stale_payload, version_skew, not_quiescent, cold_replica, truncated_windows,
  scope_uncovered } }`. Zeros included, so "no drift" is distinguishable from "the
  check never ran", and every skip names its cause.

The acceptance bar is two weeks of heartbeats with zero mismatches across web, desktop,
and mobile, with the skip counters low enough that coverage is real. The metric stays
on permanently as the regression alarm for every future sync change.

### C8 Kill switch

`INBOX_DIGEST_DISABLED=1` on the Convex env makes every overlay payload carry
`set_digest: null`; every client then skips compare and heal. No deploy needed; it
propagates at overlay cadence. It is the reactive stop for a bad ship; the version gate
(C6) is the proactive one.

### C9 Compatibility contracts

**Additive changes only, precisely defined.** Public function changes add OPTIONAL args
and new result fields only. An optional arg ships server first, defaults to today's
behavior, and the client latches it off for the session on an ArgumentValidationError
naming it (the `ack_positions` precedent), so a Convex revert degrades instead of
breaking writes. This design needs no new args at all: the digest and stamps are new
result fields on an existing payload, and the base list is byte identical for old
callers.

**Frozen contracts for old binaries.** Mobile binaries live for months. A Convex side
contract test pins, while they exist: `listInboxSessions` `include_liveness` defaults
to true; the `sessionsLiveness` payload keeps its `liveness` key; and every field the
old classifiers read (`agent_status`, `is_idle`, `awaiting_input`, `has_pending`,
`message_count`) stays present on each channel that carries it today. The test is the
freeze: a cleanup cannot pass CI while old binaries exist. Deleting these guarantees is
tied to a named minimum supported mobile version, not an open ended watch.

**Deploy order.** The shared module ships to every web client on the next push to main,
while the server copy waits for `deploy.sh`. So: deploy Convex BEFORE pushing any
behavior change to the shared module. The version gate makes the failure mode of
forgetting a silent skew metric instead of a heal storm, but the order stands.

**The cache schema bump preserves data.** A Dexie version bump with the same tables
keeps every row; nothing wipes. Session rows written before this design persist
indefinitely without the new fact fields, and the classifier must read an absent fact
as unknown and fall back honestly, forever. An upgrade test opens a seeded old version
database, bumps, and asserts rows survive and the registry reads them. On deploy day,
tabs on the old bundle can hit VersionError and run without the cache until reload; a
metric fires when `loadCache` disables the cache so that noise is measurable.

## What this deliberately does not do

- No server rendered verdicts on replica clients. Stamps are checking data in a scope
  keyed buffer; a guard test keeps them out of render paths.
- No denormalized ask fields. Ask state flips too often to stamp on the conversation
  row without recreating the head contention and flush starvation incident classes; it
  is derived on both sides from replicated inputs.
- No client cache pruning (standing decision). The cache beyond the working set backs
  search and reopening; the selection keeps it out of every count.
- No CRDTs, no vector clocks. Single writer per fact and per scope ordered positions
  give convergence; the work is making inputs replicated data and the computation
  shared.
- No team scope compare yet. The replica cannot evaluate team visibility inputs; the
  heartbeat counts the scope as uncovered rather than pretending.
- No change to workspace or access semantics.

## Rollout

1. Convex + shared module (ct-47200): fold and caps into the shared selection; digest
   over triples, version 2; `last_turn_allows_park` and child fact rows on the overlay;
   `epoch` replaces the raw timestamp in the envelope; `webDelete` trigger refresh; the
   frozen contracts test; kill switch. Deploy before any client ships. Deployed bundles
   see byte compatible payloads plus ignored new fields.
2. Web (ct-47201, ct-47202, ct-47203): selection membership and deleted gate
   exemptions; scope keyed stamp buffer and guard; chokepoint with the incremental
   engine; `useSyncCore`; declared overlays module; compare, heal, telemetry. Mobile
   mounts `useSyncCore` and deletes its local passes in the same change (the store is
   shared; OTA carries it). `CACHE_SCHEMA_VERSION` bump.
3. Transport closures (ct-47204) ship with either step.
4. Telemetry watch (ct-47205): drift dashboard; two weeks of zero mismatch heartbeats
   with honest coverage.

## Validation plan

- Unit, shared module: classifier, selection, and fold determinism (same data and epoch
  give identical output, property tested across generated rows); the digest test
  vector; a fold flip changes the digest; every truncation flag fires at its cap; the
  golden fixtures tied to the version constant; the scan and the shared selection agree
  over one fixture set.
- Unit, server: two executions in one minute return byte identical payloads; a pinned
  read budget on the overlay (child probes cached by child id and message count, cheap
  set checks before probes) so enrichment cannot silently regrow the read count; every
  `agent_tasks` writer restamps `armed_trigger_kind`, enumerated exhaustively; the
  frozen contracts test.
- Unit, client: fact fields have one writer and the strip and preserve lists derive
  from the shared constant; stamps never reach a render path; the chokepoint guard;
  the incremental engine equals the full computation; the compare gates, persistence
  rule, heal budget, latch, and kill switch; feeder profile parity between web and
  mobile; both recovery call sites use identical args; the Dexie upgrade test.
- Simulation: two simulated replicas receive interleaved payloads, sync log ranges,
  crawls, gestures, reconnects, and epoch ticks in different orders, and at quiescence
  hold identical working sets, placements, and digests, equal to a directly computed
  server projection. A cold replica case: fold rows present server side, empty client
  cache; assert the compare stays gated until the crawl completes and the heal then
  converges within one budget. Landed as
  `packages/web/store/__tests__/inboxConvergenceSim.test.ts`: the real Convex compute
  functions over a fake db, the real store appliers and gestures, one virtual clock
  behind `Date.now` and `performance.now`, twelve seeded random schedules of sixty steps
  (replay one with `SIM_SEEDS=<seed>`), plus the dead subscription cases and the two
  drills (wrong client version, `INBOX_DIGEST_DISABLED`). The sync channels alone leave
  a bounded residue (the settled pin lock case above); the anti-entropy loop closes it
  within one heal, and the test prints which seeds needed it.
- Golden fixtures and property tests: `packages/shared/contracts/inboxProjection.golden.test.ts`
  over `__fixtures__/inboxProjection/*.json` (regenerate with `INBOX_GOLDEN_REGEN=1`,
  then bump the version and pin the printed hash), and
  `inboxProjection.property.test.ts` over seeded generated row sets
  (`__fixtures__/inboxProjectionGen.ts`, shared with the convex and web suites).
  Server determinism over generated worlds:
  `packages/convex/convex/conversations.convergence.test.ts`.
- End to end: web plus mobile simulator against dev Convex; drive pin, dismiss, settle,
  trigger arm; assert equal counts within one payload cycle; kill one client's
  subscription and assert detection and heal within budget. Two drills: ship a client a
  deliberately wrong module and confirm silence plus the skew metric; set
  `INBOX_DIGEST_DISABLED` and time the null propagating.
- Prod: the drift metric, permanently.
