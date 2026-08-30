# Sync convergence: a provable inbox

Status: design draft, pre review. Companion to sync-log-migration.md, which owns transport
(ordered per scope catch up). This document owns the layer above: the guarantee that every
client renders the same inbox, and the machinery that detects, measures, and heals drift.

## The problem, stated precisely

Three clients of one account showed Needs Input 24, 25, and 50, and Pinned 20, 17, and 20,
at the same time. This is the third attack on the symptom. The first (July) introduced the
server authoritative active set (`liveInboxIds`) and hide old parity. The second (August)
introduced the append only sync log. Drift returned because both designs stop one layer
short of the thing the user sees:

- The sync log proves ordered delivery of changed ids per scope. It does not prove the
  client's rendered set matches anything.
- `liveInboxIds` gates the render, but with permanent per device exemptions (pinned rows,
  parents, hidden rows), a no filter fallback when the set is empty, and consumers that
  apply it differently (panel vs badge vs mobile).
- Bucket classification runs client side over each device's never pruned cache, with five
  unsynchronized clocks and per surface extra passes (question lift, trigger absorption,
  chip filters, revive stamps).

Investigation of the current code produced thirty two enumerated divergence paths (twelve
server side, twenty client side). They collapse into four root causes:

1. **The counted set is the local cache, not the server answer.** Every device counts
   `categorizeSessions` over its own union of everything it ever synced, narrowed by a
   client recorded id list with exemptions that defeat it.
2. **The authoritative set is not deterministic.** `computeInboxSessions` mixes a wall
   clock (`now` in five window bounds and a 90s heartbeat threshold), a sample dependent
   12 hour cluster cut over 200 row capped windows, and silent truncation. Two executions
   seconds apart return different sets from identical data.
3. **Classification is computed in N places over N input sets.** The server classifies
   only for the CLI. Web and mobile share classifier code but not inputs: enrichment
   differs per query path (`include_liveness`, AskUserQuestion probe, EMPTY_INBOX_MAPS),
   the liveness overlay covers a narrower set than the cache, and each surface adds its
   own passes.
4. **Nothing measures drift.** No digest, no count comparison, no telemetry. Divergence is
   invisible until a human holds two screens side by side.

## The invariant we commit to

> For one account, define the **inbox projection** P(S) = the ordered set of
> (conversation id, bucket) pairs, computed by one pure function over server state S.
> Every client renders exactly P(S') for some recent S', plus a small set of DECLARED
> local overlays, each bounded in time and enumerable in code. Two clients disagree only
> by (a) the age difference of their S', which is measurable and bounded by the transport,
> and (b) their declared overlays. Any other disagreement is a defect, and the system
> itself detects, reports, and repairs it.

"Provable" means three concrete things:

- **Deterministic projection**: P is a pure function of server state — no wall clock terms
  that flip results between executions over unchanged data, no sample dependent cuts, no
  silent truncation.
- **Single computation**: P including bucket assignment is computed server side, once, in
  the same execution that serves the rows. Clients render it; they do not recompute it.
- **Continuous verification**: clients compare what they render against a server digest
  and emit drift telemetry; mismatch triggers self heal. The invariant is checked in
  production, permanently, not asserted in a design doc.

## Design

### C1 — The projection is computed server side, buckets included

`computeInboxSessions` already enriches every row it returns; `classifyWorkState`
(inboxFilters.ts) already runs server side for the CLI. Promote that: the same execution
stamps each row with `bucket` (the classified work state) and returns a `tally`
(count per bucket) plus a `set_digest` (order independent hash of (id, bucket) pairs) and
`as_of` (server timestamp + the caller's scope head positions from `sync_heads`).

Clients render the server's buckets. The client side classifier survives only to apply
DECLARED overlays (C4) and for cached rows between payloads — and any disagreement between
its verdict and the server's stamped bucket on the same row is emitted as telemetry, which
turns classifier skew from an invisible bug class into a measured one.

The liveness overlay (`sessionsLiveness`) is the designed churn channel; it gains the same
treatment: per row bucket + tally + digest, computed over the same candidate set. Base
subscription and overlay therefore never disagree about what the set IS, only about how
fresh liveness is.

### C2 — The projection is deterministic

Three changes to `computeInboxSessions` and its scan:

- **Quantized clock.** All window bounds derive from `epoch = floor(now / 60s) * 60s`.
  Two executions inside the same minute see identical windows. (Index range values remain
  stable within a pagination run per the InvalidCursor rule; the paginated crawl keeps its
  caller seeded `since`.) The 90s heartbeat threshold and the 1h status trust TTL compare
  against server stamps with the same quantized now, so liveness coercion is identical
  across executions in the same minute.
- **The cluster cut moves out of set membership.** Today it silently drops active rows
  from the payload. It becomes a presentation hint: the server still computes the cutoff
  but returns rows below it with `below_fold: true` instead of omitting them. Bucket
  tallies count the projection, fold state only affects default rendering — identically on
  every client. This removes the single largest nondeterminism (sample dependent gaps).
- **Truncation is explicit.** Every window cap that fires sets a `truncated` flag on the
  payload naming the window. A truncated projection is still deterministic (caps applied
  to a deterministic ordering), and clients surface it instead of silently rendering a
  different subset. The pinned window cap rises from 20 to a bound that fails loudly.

### C3 — The rendered set is the projection, with no permanent exemptions

- The bucket gate becomes: a row counts if and only if its id is in the last projection
  payload. The pinned, parent, and hidden exemptions in `isOldSession` are deleted — the
  server projection already includes pinned rows, children ride their parents in the
  payload, and hidden rows have their own reconcile channel. A pinned row the server
  stopped returning stops counting on every device at once.
- The empty set fallback inverts: an empty or unseeded `liveInboxIds` renders an explicit
  cold state (cached rows visible but counts withheld) rather than counting the whole
  cache. Persisted seeding stays; "no data yet" is shown as such, never as 50.
- The cache stays never prune (search, open, reuse — per the standing product decision).
  Divergent caches become harmless because nothing counts them.

### C4 — Declared overlays, and only declared overlays

Local adjustments to the projection are enumerated in ONE place, each with a name, a
scope, and a time bound:

| Overlay | Effect | Bound |
|---|---|---|
| optimistic create stub | appears in Working | until server row supersedes (altKey) |
| optimistic triage gesture (dismiss/pin/stash) | moves/removes row | until ack or HIDDEN_OVERRIDE_SETTLE_MS |
| focused session | stays visible while open | while focused, never counted if outside projection |
| queued message in open view | Needs Input → Working | while view holds the queue |
| revive request | Needs Input → Working | 120s |

Everything else that today mutates counts per surface — the question lift over the whole
cache, trigger absorption only on the panel, chip filters bleeding into headline counts —
either moves into the shared computation with identical defaults on every surface, or is
re scoped to presentation that cannot change the headline tallies.

### C5 — One bucket computation, one mount set

- One function computes buckets for every surface (panel, sidebar badge, dock badge,
  active agents pill, fleet board, threads, palette, mobile), replacing today's two paths
  (panel pre partition vs badge opts). A source level guard test bans direct
  `categorizeSessions` calls outside the chokepoint, in the style of the registered feeds
  guard.
- One `useSyncCore()` composition hook owns the full feeder mount set (sync log applier,
  live sessions, liveness overlay, recovery poll, crawls, dismissed/stashed reconciles,
  clientState). Web's DashboardLayout and mobile's StoreSyncBridge both mount it. Mobile
  can no longer run a subset by omission; a feeder added to the registry reaches every
  platform or fails a guard test.

### C6 — Anti entropy: digest compare, self heal, drift telemetry

The continuous verification loop:

- The projection payload carries `set_digest` and `as_of` (C1). The client stores them.
- After each apply and on a slow timer, the client digests its own RENDERED projection
  (post overlay removal — overlays are excluded from the compared set by construction)
  and compares against the stored server digest. Equal is the ordinary case and costs one
  hash.
- On mismatch: emit `inbox_drift { missing, extra, bucket_deltas, payload_age }` through
  the analytics channel (zeros included, like `synclog_crawl_healed` — absence of drift
  must be distinguishable from the check not running), then self heal by re requesting the
  projection and overlaying it. Healing is subtractive for the rendered set (the
  projection replaces it) and additive only for the cache.
- A stalled subscription now has a bounded blast radius: the recovery poll already
  re fetches every 15s; the digest check makes a silent stall VISIBLE (payload age grows)
  and pages the existing recovery path instead of quietly rendering stale counts.

This is the production proof: the invariant runs as code on every client, drift is a
metric with a dashboard instead of a screenshot comparison, and two weeks of zeros is the
evidence of convergence — the same standard the sync log used for crawl demotion.

### C7 — Transport closures (from the server side findings)

Small holes in the sync log that the investigation surfaced, fixed alongside:

- The raw builder bypass class: extend the functions guard test to catch patch/delete
  (not just insert) of tracked tables via unwrapped builders.
- The churn exemption vs classification stamps: `isUserDormant` and
  `isSettleVerdictCurrent` expire against `updated_at`, which is churn exempt — a bucket
  changing transition that emits no sync action. With C1 the projection payload carries
  the bucket, so the live subscription delivers the transition; the digest loop catches
  any residue. Document the dependency; no new log traffic.
- Retention floor audit: verify the partial prune path cannot leave a cursor that misses
  pruned actions without `resync` (suspected edge in the floor advance; prove or fix with
  a unit test).
- Zombie subscription discipline (from the 2026-08-30 daemon outage, same class): every
  client `onUpdate`/`useQuery` sync feeder pairs with an error handler and a poll
  backstop; the digest loop is the universal detector for the ones we miss.

## What this deliberately does not do

- No client cache pruning (standing decision; the cache is not the counted set anymore).
- No CRDTs, no vector clocks, no second source of truth. Convex serializable transactions
  plus per scope positions already give a total order per scope; the work is making the
  derived projection deterministic and verified, not re founding the transport.
- No change to workspace/access semantics; scope keys remain routing, access stays in the
  stage two byIds queries.
- The CLI (`inboxForCLI`) keeps its server tally — it converges by construction once the
  shared projection function is the one it calls.

## Rollout

1. Convex: quantized clock + fold flag + truncation flags + per row bucket + tally +
   digest + as_of on `listInboxSessions` / `sessionsLiveness` / paginated / byIds paths
   (additive fields; deployed bundles ignore them). Deploy before any client ships (the
   standing convex before web rule).
2. Web: chokepoint bucket function + projection gate + declared overlays + digest loop +
   `useSyncCore()`. Mobile: mount `useSyncCore()`, delete local divergences (OTA).
3. Telemetry watch: `inbox_drift` dashboards; the acceptance bar is two weeks of zero
   drift events across web, desktop, and mobile in prod.

## Validation plan

- Unit: projection determinism (two executions, same data, same minute → identical digest);
  cluster fold never changes tallies; truncation flags; digest algorithm cross platform
  (JS number hashing pitfalls); overlay exclusion from the compared set.
- Simulation: a store level convergence test that replays interleaved live payloads,
  overlay gestures, crawls, and reconnects on two simulated clients and asserts equal
  rendered projections at quiescence — the eventual consistency proof as a test.
- End to end: two real clients (web + mobile sim) against dev convex, drive pin/dismiss/
  settle transitions, assert equal counts within one payload cycle; kill one client's
  subscription and assert the digest loop detects and heals.
- Prod: the drift metric itself.
