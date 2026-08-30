# Sync convergence: local first replicas that provably agree

Status: design, ready for implementation (ct-47200 to ct-47205). Companion to
sync-log-migration.md, which owns transport (ordered per scope catch up). This document
owns the layer above: multiplayer sync into local first client databases that is
eventually consistent by construction, one shared computation over that data, and hash
based monitoring that proves convergence in production over time.

## The model

Every client (web, desktop, mobile, CLI) is a replica. The server database is canonical;
each client's store holds a replicated subset. Bucket counts and lists are VIEWS computed
locally, on the client, from the replica. Convergence then needs exactly three identities,
and nothing else:

1. **Same data.** Within a declared working set, every replica eventually holds the same
   rows with the same field values. This is the sync layer's whole job and its only job.
2. **Same computation.** One pure function, in shared code, computes membership, fold,
   and bucket from row fields. Every surface on every platform calls it. The server runs
   the SAME function only to produce the digest that checks the replicas.
3. **Same parameters.** View state (show old, scope) is synced user state; time enters
   only as a minute epoch, so two clients in the same minute compute identical views.

Anything that breaks one of the three identities is the bug class this design removes:
per query enrichment that hands different field values to different clients, membership
decided by which payload a device happened to receive, per surface computation passes,
and unsynchronized clocks.

"Provable" is operational: the server hashes the view it derives from canonical state;
each client hashes the view it derives from its replica; the hashes are compared
continuously in prod, drift is a metric with an alarm, and mismatch triggers a bounded
self heal. Eventual consistency stops being an assumption and becomes a monitored
invariant.

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
   window bounds and liveness thresholds, applies a 12 hour cluster cut over a 200 row
   sample, and truncates silently. Two executions seconds apart differ on identical data.
3. Field values differ per channel. The same conversation yields different rows from
   `listInboxSessions` (liveness stripped, no ask probe), `listInboxSessionsPaginated`
   (full liveness), and `getInboxSessionsByIds` (empty maps) — last writer wins in the
   store.
4. The computation differs per surface. The panel, the sidebar badge, and mobile call the
   shared code through different paths with different passes (question lift over the
   whole cache, trigger absorption, revive stamps, focus exemptions), and mobile freezes
   its snapshot under a moving trust TTL clock.
5. Nothing measures drift.

## Design

### D1 The replicated working set: same data, by construction

**The working set is a predicate, not a payload.** `inWorkingSet(row, epoch)` is a pure
function over row fields: status active or completed, `updated_at` within the 30 day
window of the minute epoch, or pinned, or dismissed or stashed within their windows, or
owned. It lives in `packages/shared/contracts/inboxProjection.ts` and is the SAME code on
server and client. The server uses it to decide what to replicate; the client uses it to
decide what to count. A row's membership therefore depends only on its fields and the
minute — never on which payload a device received. `liveInboxIds` as a gate is deleted.

**Replication channels deliver the set and keep it current.** Unchanged machinery, with
its determinism fixed:

- The live window query (`listInboxSessions`) becomes a plain fetch of working set rows:
  epoch quantized bounds, no cluster cut on membership, explicit `truncated` flags for
  every cap (recent, pinned, dismissed, stashed, owned, team member, member rows). The
  pinned window orders newest first and its cap rises with a loud overflow flag.
- The sync log delivers semantic transitions per scope with ordered positions (as today).
- The completeness crawl and the dismissed and stashed reconciles remain the floor and
  the subtractive healers for hide state.
- The liveness overlay (`sessionsLiveness`) remains the churn channel, but it carries
  FACTS, not verdicts: heartbeat recency, trusted agent status, `awaiting_input`, open
  task counts. Facts written onto the row by exactly one writer (the overlay applier);
  `syncTable` strips fact fields from every other sessions channel, so no channel can
  write a torn or stale value over a fresher one. This closes cause 3: one field, one
  writer, every replica converges on the overlay's value.

**Ask state becomes data.** Today `awaiting_input` exists only where a query ran the
message probe. It stays an overlay delivered fact, and the two inputs that today require
client side joins become row fields maintained at write time, so they replicate through
the ordinary channels and the sync log:

- `armed_trigger_kind: "none" | "standing" | "once"` written when a trigger is armed,
  paused, completed, or rehomed.
- `has_open_ask` (own AskUserQuestion or permission prompt or pending `cast decide`) and
  `has_asking_child` (rollup from children), maintained by the writers that change those
  states (message settle, decision post and answer, child status transitions). Write
  time denormalization is the local first move: facts are stamped where they change,
  views never need a join.

**Eventual consistency claim, stated honestly.** For any row whose fields make it a
working set member, every online replica converges to the server's field values through
live push (in window), the sync log (semantic transitions, ordered per scope), or the
crawls (bounded staleness floor); hide state converges subtractively through the
reconciles; fact fields have one writer. The known residue: `updated_at` is churn exempt
in the sync log, so a row OUTSIDE the live window can hold a stale `updated_at` until
the next semantic transition or crawl. That residue is bounded by the crawl period and
is exactly what the digest monitor (D5) measures in prod. If the monitor shows it
matters, the fix is a sync log emit for window crossing transitions, decided on data.

### D2 One computation: the shared projection module

`packages/shared/contracts/inboxProjection.ts` (the precedent is `agentStatus.ts`, which
convex already imports) exports pure functions only:

- `inWorkingSet(row, epoch)` — membership (D1).
- `classifyRow(row, epoch)` — the one classifier: `work_state` (merging
  `classifyWorkState` with the web rules the server lacks: unresolved
  `pending_api_error` with content is needs input) and `bucket`, the mutually exclusive
  placement: dismissed, stashed, hidden (anchor rows), questions (`has_open_ask` or
  `has_asking_child` or `awaiting_input`), pinned, new (no messages), then the work
  state. Pinned outranks the work buckets, so Needs Input never counts a pinned row.
- `computeFold(rows, epoch)` — the 12 hour gap cut, computed over the CONVERGED working
  set rather than a per query sample, so it is deterministic and identical on every
  replica. Fold affects default rendering and splits the tally (`shown` vs `folded`);
  show old means rendering and counting `shown + folded`. Fold never changes membership.
- `projectInbox(rows, viewState, epoch, overlays)` — membership, fold, classification,
  ordering, tallies, in one call.
- `digestProjection(pairs)` — order independent hash over (id, bucket) pairs: FNV 1a 32
  per pair folded into two 32 bit lanes (plain sum and sum of `Math.imul(h, h | 1)`),
  16 hex characters. No sorting, no BigInt. One implementation, one test vector, used by
  server and every client.

Consumers: the client store chokepoint (D4), `inboxForCLI` (whose tallies converge by
construction once it calls the same function), and the server digest query (D5). The
store's parallel classifiers (`isSessionWaitingForInput` chain, the trust sweep inside
`categorizeSessions`) and the server's separate `tallyInboxRows` path are deleted, not
wrapped.

Time discipline: every time term compares against `epoch = floor(now / 60s) * 60s`.
Clients evaluate on the shared 15 second coarse tick but quantize to the minute, so two
replicas with the same data disagree at most across one minute boundary, and the digest
compare (D5) only compares matching epochs.

### D3 Same parameters: view state is synced state

`inbox_show_old`, `inbox_scope`, and the other stamped view keys remain in the synced
LWW bag — that part already works. What changes is their semantics: show old selects
`shown + folded` instead of `shown` inside the shared computation. No preference may
bypass the working set predicate or widen the counted set beyond it; the guard test
asserts the chokepoint is the only reader of these keys for counting purposes.

### D4 One chokepoint, one feeder set, declared overlays

- **Chokepoint.** `placeInboxRows` in the store calls `projectInbox` with (replica rows,
  synced view state, coarse epoch, declared overlays) and returns placed buckets and
  tallies. Every consumer uses it: panel, sidebar badge, dock badge, active agents pill,
  fleet board, thread cards, palette, mobile inbox. A source level guard bans
  `categorizeSessions`, `partitionOldSessions`, and `liftQuestions` outside it. The
  memoization contract is part of the chokepoint (fresh rows plus the coarse tick),
  which removes mobile's frozen snapshot class by construction.
- **Declared overlays** — the only local adjustments, enumerated in one module, each
  named, bounded, and excluded from the digest compare:

  | Overlay | Effect | Bound |
  |---|---|---|
  | optimistic create stub | appears in Working | until the server row supersedes (altKey) |
  | optimistic triage gesture | moves or removes the row | until ack or HIDDEN_OVERRIDE_SETTLE_MS |
  | focused session | stays visible while open | while focused; never counted outside the working set |
  | queued or pending send in the open view | Needs Input to Working | while the queue holds |
  | revive request | Needs Input to Working | 120s |
  | draft or blank engagement | renders a `new` row locally | rendering only, never counts |

  Chip filters, label lenses, and schedule grouping are presentation over placed rows and
  cannot change headline tallies. Trigger absorption stops moving rows between buckets:
  `armed_trigger_kind` reaches the classifier as data, identically everywhere.
- **Feeder parity.** `useSyncCore(profile)` owns the full feeder mount set: sync log
  applier, live window, liveness overlay, team feeders (mounted per scope), recovery
  probes, completeness crawl, dismissed and stashed reconciles, session decisions, client
  state, current user, buckets. Web `DashboardLayout` and mobile `StoreSyncBridge` both
  mount it; a guard asserts every registered feeder is in the profile. Mobile pauses the
  set on AppState background and resumes with one catch up pass, replacing the
  `document` gated nonce that never re ticks on iOS today.
- **Recovery discipline.** Every subscription pairs with an error handler and a
  controller backed probe (the zombie subscription class from the 2026-08-30 outage);
  no feeder adds a bespoke interval.

### D5 Hash monitoring: the convergence proof that runs in prod

- **Server digest.** A small query, `inboxProjectionDigest`, runs `projectInbox` over
  canonical state for the caller's scope at the current epoch and returns
  `{ v, as_of, epoch, scope, tally, set_digest, truncated }`. It rides the liveness
  overlay payload (same execution, same candidate rows, no extra reads) so every client
  receives a fresh digest at the overlay's cadence without a new subscription.
- **Client compare.** The chokepoint memo digests the pairs the replica computes — server
  buckets are not rendered, so the compare is genuinely replica vs canonical: same
  function, two databases. Compared on the coarse tick, only when epochs match, with
  overlay affected rows excluded by construction (pending entries, excludes, stubs,
  focused outside the set).
- **Drift telemetry.** Nonzero mismatch emits `inbox_drift { missing, extra,
  bucket_deltas, payload_age_ms, scope, platform }` (counts only, never ids);
  `inbox_digest_heartbeat` fires hourly with `{ checks, mismatches, heals,
  max_payload_age_ms }` so "no drift" is distinguishable from "the check never ran".
  This is the over time monitor: the acceptance bar is two weeks of heartbeats with zero
  mismatches across web, desktop, and mobile, and the metric stays on permanently as the
  regression alarm for every future sync change.
- **Self heal, bounded.** A mismatch re fetches the working set through the existing
  recovery path (in flight guard, backoff), applies it through the ordinary appliers
  (respecting pending entries), budgeted at three heals per ten minutes; the fourth
  emits `inbox_drift_persistent` and stops. Missing row bodies heal through
  `getInboxSessionsByIds` and count separately. Kill switch: `INBOX_DIGEST_DISABLED` on
  the Convex env returns `set_digest: null` and every client skips compare and heal.

### D6 Transport closures

- Functions guard: fail any file importing raw `mutation`/`internalMutation` from
  `_generated/server` unless allowlisted, regardless of the tables it writes today.
- Retention floor: unit test pinning both floor branches of the prune walk (traced
  correct; the test locks it).
- Churn exemption: documented dependency of classification stamps on `updated_at` (D1
  residue); the digest monitor decides whether a window crossing emit is needed.
- New fact fields (`armed_trigger_kind`, `has_open_ask`, `has_asking_child`) are
  semantic, therefore sync log tracked; a test asserts they are not on the churn list.

## What this deliberately does not do

- No server rendered verdicts. Buckets are computed on the replica; the server runs the
  shared function only to produce the checking digest.
- No client cache pruning (standing decision). The cache beyond the working set backs
  search and reopening; the predicate keeps it out of every count.
- No CRDTs, no vector clocks. Single writer per field group plus per scope ordered
  positions plus subtractive reconciles already give convergence; the work is making
  inputs replicated data and the computation shared.
- No new query arguments (result fields only, so deployed bundles never hit validation
  errors, and a Convex revert degrades new clients to stale but honest local computation,
  never wrong numbers).
- No change to workspace or access semantics.

## Rollout

1. Convex (ct-47200): shared projection module; deterministic windows + truncation
   flags; fact field denormalization and writers; overlay fact carriage; digest on the
   overlay payload; `inboxForCLI` onto the shared function; kill switch. Deploy before
   any client ships. Deployed bundles see byte compatible payloads plus ignored new
   fields.
2. Web (ct-47201, ct-47202, ct-47203): predicate membership + deleted gate exemptions,
   chokepoint + guard, `useSyncCore`, declared overlays module, digest compare + heal +
   telemetry. Mobile mounts `useSyncCore` and deletes its local passes in the same
   change (the store is shared; OTA carries it). `CACHE_SCHEMA_VERSION` bump.
3. Transport closures (ct-47204) ship with either step.
4. Telemetry watch (ct-47205): drift dashboard; two weeks of zero mismatch heartbeats.

## Validation plan

- Unit, shared module: classifier and membership and fold determinism (same data + same
  epoch = identical output, property tested across generated rows); digest test vector;
  fold never changes `shown + folded`; every truncation flag fires at its cap.
- Unit, server: two executions in one minute return identical payloads and digests; the
  overlay adds no per row reads beyond today's; fact writers stamp on every transition
  path (trigger lifecycle, decision post and answer, child transitions).
- Unit, client: fact fields have one writer (syncTable strips them elsewhere); the
  chokepoint guard; the overlay exclusion rules; the heal budget and kill switch; feeder
  profile parity between web and mobile.
- Simulation: the eventual consistency proof as a test — two simulated replicas receive
  interleaved payloads, sync log ranges, crawls, gestures, reconnects, and epoch ticks
  in different orders, and at quiescence hold identical working sets, identical placed
  buckets, and identical digests, equal to a directly computed server projection.
- End to end: web + mobile simulator against dev Convex; drive pin, dismiss, settle,
  trigger arm; assert equal counts within one payload cycle; kill one client's
  subscription and assert detection and heal within budget.
- Prod: the drift metric, permanently.
