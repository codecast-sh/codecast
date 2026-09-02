# Sync log migration

Status: in progress (pl-399). This note pins the decisions the local-first restart brief
required before any client work, revised after a three lens adversarial design review
(ordering/convergence, rollout/operations, guardrails). It is deliberately small: the design
is an append only log next to the existing machinery, not a second domain model.

## What we are building

An append only, per scope sync action log on the server, and a client applier that treats it
as the single catch up path. The log replaces three heuristics:

1. `change_log`'s mutable one row per entity with `seq = Date.now()` and a 10 second client
   overlap window (a recovery heuristic, not an ordering proof).
2. The tasks/docs reconcile crawls' `updated_at` watermark (`since` mode) as the way a client
   learns what changed while it was away.
3. Value echo as the only rule that retires a pending (optimistic) entry.

Live Convex table queries stay exactly as they are. They are the realtime push transport and
the snapshot floor; the log owns ordered catch up, deletion, revocation, and write
acknowledgement. Both feed the same `syncTable` appliers with idempotent upserts.

> Superseded in part by `sync-log-cargo.md` (pl-498): the list queries for tasks, docs,
> plans and projects are now one shot bootstrap floors (E8), and log rows carry the changed
> fields (E1), so the log is the steady state delivery path for those collections.

Honest scope of the proof: the log proves everything from a scope's first contact forward.
The pre contact past keeps today's contract (cache + snapshot floors + cold backfill). That
is a strict improvement, not a regression, and it avoids inventing a coverage matrix.

## Decisions

### D1 — Ordering primitive: per scope counter, advanced in the writing transaction

Two new tables (see schema.ts):

```
sync_heads:   { scope_key, position, floor, updated_at }         index by_scope
sync_actions: { scope_key, position, entity_type, entity_id,
                op, ts }                                          index by_scope_position
                                                                  index by_scope_entity
                                                                  index by_ts
```

`scope_key` is `user:<userId>` or `team:<teamId>`. On every tracked write, inside the same
Convex mutation transaction: read the scope's head, `position = head + 1`, patch the head,
insert (or move, below) the action. Convex mutations are serializable, so per scope positions
are strictly increasing in commit order and a reader who has seen head H has provably seen
every action at or below H. That is the whole ordering proof; `ts` is retention/debug
metadata and never an ordering key.

**Churn exemption (review blocker).** Conversation rows are patched at message batch and
heartbeat cadence (`message_count`, `updated_at`, `last_heartbeat`, …). Emitting those would
serialize every streaming session of a user on one head row (OCC retry storms into the
daemon's serial mutation queue — the documented flush starvation class) and wake every online
client per flush. Rule: a patch touching only fields in `CHURN_ONLY_FIELDS[table]` emits no
sync action (change_log still updates for old clients). Accepted staleness: counter fields on
rows outside the live windows lag until the next semantic transition; the live snapshot floor
re-delivers them for everything in window. The D11 comparator whitelists exactly this
divergence. The list must cover what the message flush path ACTUALLY writes — prod measured
~0.7 conversation upserts/sec on one user scope before `last_user_message_at`,
`last_message_preview`, `image_preview_url` and `recent_files` joined it (review, verified
against live data). `pending_api_error*`/`loop_state` stay non exempt: the patch includes
them only on genuine transitions.

**What the exemption does to placement.** The inbox placement of a settled row (sync
convergence C2, C6) reads two kinds of input: transition fields (`thread_state_status`,
`settle_verdict`, `settle_verdict_at`, `armed_trigger_kind`) and clock fields that decide
whether those verdicts have expired (`updated_at`, `last_heartbeat`, `agent_status_updated_at`,
through `bucket_stale_at`). The transition fields change on real transitions and emit sync
actions, so a replica holds them exactly. The clock fields are churn exempt, so a replica's
copy of them lags for every row outside the live windows. That lag is why the liveness
overlay is the fact writer for `updated_at` and the trust decay: a replica must never expire
a dormant or done verdict from its own stale copy of a churn exempt clock. The rule the two
documents share: a verdict expiry is evaluated only against clock facts the overlay refreshed
inside the compare's payload age bound, and a row the overlay stopped covering keeps its last
verdict until a semantic transition or the completeness crawl re-delivers it. Widening
`CHURN_ONLY_FIELDS` with a field the placement reads as a transition breaks that rule.

**Coalescing (bounded table).** An entity's active row in a scope is MOVED to the new head
(patch position + op + ts) instead of appended again, so the table is bounded by churned
entity count per scope plus revocation tombstones — not change volume. The rule is keyed by
`(scope_key, entity_id)` and the LAST op wins; a move+patch or double scope move therefore
keeps every revocation (each departed scope gets its own delete action; review major). A
moved row is either seen at its old position or re-seen at its new one; applies are
idempotent either way.

**Within transaction**: the collector dedupes identical `(scope, entity, op)` appends (safe:
the transaction commits atomically) and caches head row IDS so bulk mutations skip the index
lookup — but the cached position is never trusted: a `ctx.runMutation` sub mutation runs in
the same transaction with its own collector, so every allocation re reads the head row by id
(transaction local read). Duplicate positions are impossible by construction, not by handler
write ordering (review). The collector is created per handler invocation, so an OCC retry
starts clean and an ack can never carry positions from an aborted attempt.

**Contention gate.** Bulk server sweeps that patch many rows of one scope across parallel
scheduled mutations (title floods, teamScopeSweep pages, cascade closes) now conflict on that
scope's head. Validation (D11) measures OCC retry rates before any legacy demotion, and bulk
writers that page one scope should batch rows per transaction. Kill switch: setting the
`SYNC_LOG_DISABLED=1` Convex env var stops emission without a redeploy (reads and dual
written change_log continue, so both client generations keep working).

**Cost note.** Since the cargo design (E4) every tracked write already reads the post write
document once (memoized) for the access stamp, the fan out scopes and the self heal, so the
change_log removal in D12 no longer changes the hot path's cost.

### D2 — Tracked tables

Exactly the `change_log` set: conversations, tasks, docs, plans, projects, plus scope
membership actions (D5). Extension is declarative: a table joins by entering the tracked set
and satisfying the access stamp shape (owner, workspace key, grants — cargo E4; the
`{ user_id, team_id? }` shape below is change_log's).

### D3 — Scope stamping (superseded by sync-log-cargo E4)

Originally one action row per ROUTING scope (owner + `team_id`). Since the cargo design
(pl-498) the log's scopes derive from ACCESS facts — owner, the workspace key's team, and
explicit grants — so every reader who may read a row holds a scope it fans to and a private
inside a team row never enters the team scope. `change_log` (old clients) keeps routing
semantics. The paragraph below describes the routing era and is kept for history.

One action row per scope. Tasks, docs, plans, projects: always the owner scope
(`user:<user_id>`); additionally the team scope (`team:<team_id>`) when `team_id` is set.
Conversations: owner scope only.

**Routing, not access.** `scope_key` is stamped from routing fields (`user_id`/`team_id`).
It shares the `workspace` key's spelling but is a different predicate and must never be
compared against `workspace` or used as an access input. Access is enforced where it always
was: stage two, the authorized `*byIds` queries. An id fanned to a viewer who cannot fetch it
(e.g. a task with `team_id: T` but `workspace: user:<owner>` — the locked private inside a
team case) returns nothing and the client discards it. This is the existing change feed
contract, restated.

### D4 — Scope moves append a revocation

When a patch changes `team_id`, `user_id`, `workspace` or `assignee` (the scope fields since
cargo E4), the interceptor reads the document before the write and appends `delete` in each
departed scope and `upsert` in each current scope. Entity
deletion appends `delete` in every visible scope. The pre read happens only when the patch
touches scope fields; the hot path stays head read + move/insert.

**Client rule (review blocker):** a log `delete` is scope local and never prunes the store by
itself. Deletes go through the authorized stage two fetch and only ids the authorized query
omits are pruned (since cargo E6, upserts with a patch apply directly instead) (restart brief invariant 6: deletion
truth is authorized absence). A multi scope viewer who receives the departed scope's delete
after the entered scope's upsert therefore never loses the row.

### D5 — Scope set lifecycle

`team_memberships` insert/delete appends `{ entity_type: "scope", entity_id: <team_id>,
op: scope_added | scope_removed }` in the affected user's own scope. Client on
`scope_added`: clear the scope's crawl watermarks (ALL wsArgs variants, via the predicate
based `clearCrawlMetaForScope` — the crawl keys are JSON serialized workspace args and are
never reconstructable by concatenation; review C6) so the next crawl runs a full backfill,
and the cursor stamps cold on the next heads pass. On `scope_removed`: purge rows whose
`workspace` is `team:<id>`, drop the scope's cursor, and fence the rest of the run (a run
local purged set — the heads loop skips a scope revoked mid run; review C21). A getRange
`authorized: false` is treated as scope drop, not a retryable error. Backstop for a
revocation whose scope_removed action was retention pruned while the client was away: after
every heads fetch, any persisted team cursor whose scope getHeads no longer lists is treated
as revoked — purge, drop cursor, clear crawl marks (guarded on a non empty heads response so
an auth blip cannot purge; review C3). Rejoin heals fully because the crawls lift excludes
for every row an authorized page returns (review C7). The purge's vocabulary crossing
(cursors keyed by log scope, purge keyed by workspace) relies on the invariant that
`workspace: team:T` implies `team_id: T`, maintained by `computeWorkspaceKey`.

### D6 — Read API (additive, `convex/syncLog.ts`)

- `getHeads {}` — the caller's scopes (own user scope + team memberships) with
  `{ position, floor }` each. Tiny payload; the live wake signal. With the churn exemption it
  re-runs on semantic transitions only. The applier additionally debounces bursts (positions
  are cumulative, nothing is lost).
- `getRange { scope_key, from, limit, cargo? }` — membership checked, ascending page of
  actions past `from` (bounded by rows and bytes), projected per caller (cargo E4),
  `hasMore`/`nextFrom`, `resync: true` when `from < floor` (retention passed the cursor), and
  `authorized: false` for a scope the caller no longer holds — distinguishable from an empty
  caught up scope, because the client treats it as revocation (review C3).

Stage two (`conversations.getInboxSessionsByIds`, `tasks/docs/plans/projects.webGetByIds`)
now serves deletes, rows without cargo or base, partial cargo and re enrichment (cargo E5/E6).

### D7 — Client applier (replaces the internals of `useSyncChangeFeed`)

Per scope cursor persisted in `syncMeta` under `synclog:v1:<scope_key>`, forward only. The
applier owns the cursor lifecycle alone — crawls never stamp it (review: the two stamper
design was unsound). One serialized apply pipeline: scopes may fetch ranges concurrently, but
retire/apply/advance run through a single queue so a stale stage two fetch can never land
after a fresher one.

Run order (review C5/C10/C15): capture `getHeads` FIRST, then drain the legacy
`changefeed:v1` bridge (which then reaches past every captured head, so a cold cursor
stamped at a captured head leaves no window), then the per scope catch up, then — only when
the drain completed (`!hasMore`, not a page cap or failed query) AND the scope cursors are
stamped — drop the legacy cursor. An incomplete drain keeps its progressively checkpointed
cursor and resumes next run; a crash between drain and stamps redoes the bridge (idempotent).

Cold scope (no cursor): stamp at the captured head (position 0 is a valid initial cursor — a
newborn scope's first actions must replay from 0; review C8). Warm scope: replay
`(cursor, head]` on head movement (debounced) and on wake/focus/online.

Applying a range:

1. Dedupe actions by `(entity_type, entity_id)`, latest position wins.
2. Retire acked pending entries for this scope up to the range's top position FIRST — so the
   authoritative post write rows land unblocked (review major: retiring after the apply
   strands a diverged field with no lock and no re fetch).
3. Apply cargo directly where a base row exists (cargo E6); lift feed excludes and fetch
   the rest through stage two byIds (chunked ≤300), `syncTable(..., isDelta)`, prune only
   ids the authorized fetch omitted.
4. Advance the cursor; handle scope lifecycle actions per D5.
5. `resync: true`: clear the scope cursor and the affected workspaces' `backfilledAt`, then
   re-run the cold flow (the cold backfill heals the pre floor past).

### D8 — Position based acknowledgement for pending entries

`dispatch` gains optional `ack_positions: boolean`. The interceptor's collector accumulates
`{ scope_key, position }` per appended action; with the flag set, dispatch returns
`{ __syncAckV1, result }`. Only clients that send the flag see the envelope; deployed bundles
keep the unchanged shape (old outbox rows redriven by a new client get the flag added at call
time — the flag is a binding concern, not a persisted one).

Client rules (review majors):

- Protocol lives in the store: `stampSyncAck(patches, ack, sentAt)` derives the pending keys
  from the dispatched patches and stamps only entries that still protect the DISPATCHED
  VALUE (value match, not send time ordering — an outbox redrive's send time is attempt
  time, so a time guard would let an old write's ack retire the entry protecting a newer
  write; review C9). A newer local write changes the protected value and is never stamped.
- Only FIELD entries ack retire. Exclude/include entries are not stamped (their keys carry
  no field for the patch walk to match); their lifecycle stays value echo, authorized
  absence pruning, and the 30 day hydration expiry — stated here so nobody later "optimizes"
  value echo away.
- If the scope cursor already passed `p` when the ack arrives, retire immediately (both
  directions, not only apply then scan).
- Value echo retirement is a PERMANENT invariant, not a transitional one: writes deferred to
  scheduled functions, receipt deduped redrives, and non flagged clients produce no ack by
  construction and must still converge. The engine's middleware is the eventual home for the
  unwrap once the in flight `@platform/engine` extraction settles; until then the binding
  unwraps and delegates to the store in one line.

### D9 — Bootstrap and the cold backfill

The cold backfill (tasks/docs full crawl; sessions live floor + union hydrate + bootEager
dismissed/stashed passes) is the permanent partner of the log: it owns the pre contact past
and the resync recovery. It no longer stamps any log cursor (D7 owns that), which dissolves
the shared sample problem and the resumed crawl `complete=false` trap. The `since`
incremental crawl mode stops being a correctness path; the periodic schedule is demoted to a
24 h safety net whose observed healing rate is the removal signal (D11/D12).

### D10 — Retention

A fixed slot cron (`45 2-22 * * *` — never inside the ~23:30–01:15 UTC backup window; an
interval cron's phase anchors to deploy time and drifts) starts a self continuing chain:
each transaction probes a bounded batch of scopes (one indexed `.first()` past the floor —
a quiet scope costs one read), walks prunable prefixes under a delete budget, and schedules
itself for the next batch, so the read set never grows with total scope count and can never
cross Convex transaction limits (review C1/C14). Per scope: delete the PREFIX of actions
older than 30 days by position, stop at the first young action; the floor advances to the
last deleted position, and a walk that empties the scope sets floor = head so returning
clients resync instead of reading emptiness as caught up. Heads are never deleted. The end
of each chain reads the oldest retained action via `by_ts` and logs an error when its age
exceeds 32 days — the implemented alarm for a stalled cron (review C18).

### D11 — Validation

- Unit (both packages): gap free positions under interleaved writers; move+patch and double
  move revocations; churn only patches emit nothing; membership lifecycle; range paging,
  floor and resync; prefix walk retention including the emptied scope; collector per attempt;
  applier plan/dedupe by (type, id); retire before apply ordering; ack skipped for entries
  with newer ts; authorized absence pruning.
- Shadow comparator, directional: dev flag gated; after each log apply, assert the log
  derived id set is a SUPERSET of `getChangesSince` over the same window, modulo the
  conversations churn whitelist. Old feed noise then cannot mask log gaps.
- Contention: measure head OCC retry rates in prod after deploy (bulk sweeps named: title
  generation, teamScopeSweep, cascade closes) before any demotion.
- End to end: convex deploy, then drive local web — cross device task edit converges through
  the log; kill retires its exclude by ack; frozen tab wake catches up without the crawls.
- Prod demotion signal: every completed incremental crawl emits `synclog_crawl_healed`
  { namespace, count } through the analytics channel, ZEROS INCLUDED — the removal condition
  is a negative ("two weeks of zeros"), and absence of nonzero events is indistinguishable
  from the crawl not running (review C20). Two weeks of zero counts in prod is the removal
  condition, not dev silence.

### D12 — Deletion ledger

Deleted now (new client): the change feed overlap/cursor heuristics (internals of
`useSyncChangeFeed`), `since` mode as correctness, `CHANGE_FEED_META_KEY` as a live cursor
(it is read once by the D7 bridge, then dropped).

Kept, with removal conditions:

- Cold backfill machinery (`runReconcileCrawl` and its fetchPage plumbing): KEPT permanently
  — it is the D9 partner and the D5/resync bootstrap. Only the periodic schedule and
  bootEager passes are deletable, on the D11 healing rate signal.
- `change_log` dual write + `getChangesSince`: removable only when deployed bundles rolled
  off. Mobile app store installs make this months long; name a forcing function (minimum
  supported version / forced upgrade) rather than an open ended watch. Until then the hot
  path pays both writes — the churn exemption keeps that affordable.
- Live table queries, liveness overlay, recovery poll: the sessions window and overlay stay
  (push transport); the tasks/docs/plans/projects list queries became one shot bootstrap
  floors under cargo E8.
- Dormant v2 receipt tables: untouched here; separate cleanup.

### D13 — Rollout order

1. Convex first: schema + interceptor dual write (churn exempted) + read API + cron + kill
   switch. Commit the sync log change and deploy a tree that matches what main will have;
   write the revert path (revert commit + deploy.sh) down before deploying, not mid incident.
   Note the shared checkout: other sessions' uncommitted convex work rides any deploy — check
   `git status` and coordinate per the repo deploy blocker rule.
2. Client (applier + acks + bridge + demotions) ships with the next web deploy after that.
   Old bundles are unaffected at every point. Mobile shares the web binding, so the flag
   reaches it with its next OTA — safe because the binding self heals version skew: an
   ArgumentValidationError naming `ack_positions` latches the flag off for the session and
   re issues the call unflagged, so a convex revert degrades to value echo retirement
   instead of a write outage (review C12).
3. Deletions wait for D12 conditions.

## Non goals

Turbopuffer or any secondary index store (a Convex index on `(scope_key, position)` is the
Postgres path before it hurt, at our scale). Team visible conversation actions. MobX style
object pools. Replacing live queries as the realtime transport. Event sourcing of message
streams (coverage markers for demand driven relations remain a follow up).
