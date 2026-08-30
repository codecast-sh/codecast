# Sync convergence: a provable inbox

Status: design, ready for implementation (ct-47200 to ct-47205). Companion to
sync-log-migration.md, which owns transport (ordered per scope catch up). This document
owns the layer above: the guarantee that every client renders the same inbox, and the
machinery that detects, measures, and heals drift.

## The problem

Three clients of one account showed Needs Input 24, 25, and 50, and Pinned 20, 17, and 20,
at the same time. Two earlier designs attacked the symptom. The July design introduced the
server authoritative active set (`liveInboxIds`) and hide old parity. The August design
introduced the append only sync log. Drift returned because both stop one layer short of
the thing the user sees:

- The sync log proves ordered delivery of changed ids per scope. It does not prove the
  client's rendered set matches anything.
- `liveInboxIds` gates the render, but with permanent per device exemptions (pinned rows,
  parents, hidden rows), a no filter fallback when the set is empty, and consumers that
  apply it differently (panel, badge, mobile).
- Bucket classification runs client side over each device's never pruned cache, with
  several unsynchronized clocks and per surface extra passes (question lift, trigger
  absorption, chip filters, revive stamps).

The divergence paths collapse into four root causes:

1. **The counted set is the local cache, not the server answer.** Every device counts
   `categorizeSessions` over its own union of everything it ever synced, narrowed by a
   client recorded id list with exemptions that defeat it. With the synced
   `inbox_show_old` preference on, the narrowing is skipped entirely (measured on this
   account: 2,270 cached rows, 855 top level, 1,062 ids in the authoritative list, 323
   cached top level rows outside it).
2. **The authoritative set is not deterministic.** `computeInboxSessions` mixes a wall
   clock into window bounds and liveness thresholds, applies a sample dependent 12 hour
   cluster cut over capped windows, and truncates silently. Two executions seconds apart
   return different sets from identical data.
3. **Classification is computed in N places over N input sets.** The server classifies
   only for the CLI (`classifyWorkState` in `tallyInboxRows`). The web store has its own
   classifier (`isSessionWaitingForInput` and friends) with rules the server lacks
   (`pending_api_error`, the pinned exclusion, the anchor rule, the New bucket) and
   inputs the server never reads (`sessionDecisions`, cached child rows, the trigger
   absorption pass). Web and mobile share that code but not its inputs.
4. **Nothing measures drift.** No digest, no count comparison, no telemetry. Divergence
   is invisible until a human holds two screens side by side.

## The invariant

> For one account and one inbox scope, the **inbox projection** P(S, epoch) is the set of
> (conversation id, bucket) pairs computed by one pure function over server state S and
> a server chosen minute `epoch`. Every client renders exactly P for some recent
> (S, epoch), plus a small set of DECLARED local overlays, each named in code and bounded
> in time. Two clients disagree only by (a) the age difference of their payloads, which
> is stamped, measured, and bounded by the recovery poll, and (b) their declared
> overlays. Any other disagreement is a defect, and the system detects, reports, and
> repairs it.

"Provable" means three concrete things:

- **Deterministic projection.** P is a pure function of (S, epoch). Within one minute,
  two executions over the same data return byte identical results. Every truncation is
  flagged, never silent.
- **Single computation.** Buckets are computed server side, once, in the liveness
  overlay, and every surface on every platform renders the stamped bucket. No client
  classifies.
- **Continuous verification.** Clients compare what they render against the server's
  digest and emit drift telemetry; mismatch heals through the existing recovery path
  under a budget. The invariant runs as code in production.

## Design

### C1 The projection lives on the liveness overlay

`sessionsLiveness` and `teamSessionsLiveness` (`computeSessionsLiveness`) are the only
inbox executions that hold every classifier input: the managed session maps, the
AskUserQuestion probe, the producing parents set, and the liveness thresholds. The base
list on the web path (`include_liveness: false`) deliberately reads none of that, which is
what keeps it off the heartbeat cadence. So the overlay carries the projection: per row
`bucket`, `work_state`, `asking`, `below_fold`, and the time flip stamps, plus one
`projection` object per payload with `as_of`, `epoch`, the scope key, the tally, the
digest, and the truncation flags. The full contract is in the payload section below.

The projection id set is exactly the overlay's key set: the top level rows that pass
`shouldShowInInbox` in the shared scan, including dismissed, stashed, pinned, and below
fold rows. Subagent children are never projection members; they ride their parent in the
base payload for rendering and contribute to the parent's stamps only.

The base list (`listInboxSessions`, `listTeamInboxSessions`) carries membership hints,
row bodies (the cold fields), and child rows. It never carries a bucket, a digest, or a
liveness field. `getInboxSessionsByIds` and `listInboxSessionsPaginated` never carry a
bucket either; they strip liveness exactly as byIds already does. A test asserts the base
payload contains no projection field.

Bucket stamping adds no reads to the overlay. Every input is either on the conversation
document, in the maps the overlay already builds, or derived from the candidate pool the
scan already returned. The two inputs that would have needed reads are moved:

- Armed trigger state is denormalized onto the conversation row as `armed_trigger_kind`
  (`none | standing | once`), written when a trigger is armed, paused, completed, or
  rehomed. It is a semantic field, so it rides the sync log and the base list for free,
  and `loadArmedTriggerHomes` leaves the inbox path.
- Pending `cast decide` questions are one indexed read per execution over
  `session_decisions` for the user (written only on post and answer, so it re executes
  the overlay rarely). The client's `sessionDecisions` feeder stays for rendering the
  cards; the count comes from the stamp.

`as_of` is the query's own `Date.now()`. The inbox queries never read `sync_heads`: that
would put the head row in the read set of the heaviest query and re execute the whole
inbox on every task or doc edit, and it buys no ordering because the inbox and `getHeads`
run in different transactions.

### C2 The projection is deterministic

- **Server chosen epoch.** `epoch = floor(as_of / 60s) * 60s`. Every window bound, the
  cluster cut, the heartbeat threshold, the trust TTL, the idle grace, and the daemon
  alive windows compare against `epoch`, not `as_of`. Two executions inside one minute
  over the same data are byte identical. The epoch is never a query argument: an
  argument would mint a new subscription per minute per client and force a full
  recompute and full payload every minute.
- **Time passage is a declared overlay, and the poll is its wake.** Convex re executes a
  subscription only when a document in its read set changes, so a stamped bucket can
  outlive the thresholds it was computed with (all daemons closed, nothing writes). The
  overlay therefore stamps `bucket_stale_at` (the earliest instant a time term flips the
  bucket if nothing else changes) and `stale_bucket` (the bucket the same function
  yields at that instant). The client renders `stale_bucket` once its coarse clock passes
  the stamp. That flip is a declared overlay, excluded from the digest compare, and it
  bridges the gap until the next fresh execution. The fresh execution comes from the
  recovery controller: a passed `bucket_stale_at` counts as staleness for the overlay
  probe, so the load bearing channel for time driven transitions is the existing probe,
  with its in flight guard and backoff, not a client classifier.
- **The cluster cut is a fold, not membership.** The overlay stamps `below_fold: true`
  on rows under the cut instead of the base omitting them. The cut is computed from the
  same sample on every execution, and the payload carries both tallies (`shown` and
  `folded`), so the headline counts stay what they are today and the fold count is a
  separate figure. The base list's `show_all: false` contract does not change (it keeps
  omitting fold bodies), so deployed bundles are unaffected. A client that shows old
  rows subscribes with `show_all: true` and counts `shown + folded`; that is the only
  meaning of the show old preference, and no client path widens the counted set beyond
  a payload.
- **Truncation is explicit.** Every cap that fires names itself in
  `projection.truncated`: the recent, pinned, dismissed, stashed, and owned windows,
  the team member cap, the per member row cap, and the foreign scan budget. The pinned
  window orders by `inbox_pinned_at` descending so the newest pins win, reads cap plus
  one so overflow costs one row, and the cap rises to 100. `pinConversation` refuses
  past the cap with a clear error, so the limit is enforced where the user can see it.
  Pinned rows past the newest 20 skip the children scan in non show_all base
  executions (children are not counted, and this is the read that hit the system
  operation limit on the census).
- **The foreign scan budget is priority ordered.** The 40 slot budget for foreign run
  parents goes to the 40 most recently updated foreign idle parents, in `updated_at`
  order, not in iteration order; overflow sets the `foreign_scan` truncation flag.
  Adding an unrelated teammate row can then only take a slot from an older row, and the
  flag says so.

### C3 One classifier, one alphabet

One pure function in `packages/shared/contracts/inboxProjection.ts` computes every
placement. It consumes only stamped row fields plus the enumerated overlay inputs, and
both the overlay query and `inboxForCLI` call it. No other classifier survives:
`tallyInboxRows` reads the stamped `work_state`, and the store's
`isSessionWaitingForInput` chain, `classifySession`, and the trust sweep in
`categorizeSessions` are deleted.

Two stamps per row:

- `work_state` is `classifyWorkState`'s verdict (`working | needs_input | done | dormant
  | idle`), extended with the rule the web had and the server lacked: an unresolved
  `pending_api_error` on a row with content is `needs_input`.
- `bucket` is the mutually exclusive placement, derived from `work_state` and the row's
  triage fields, in this precedence:

  | Bucket | Rule |
  |---|---|
  | `dismissed` | `inbox_dismissed_at` set (a pinned killed row still shows as `pinned`) |
  | `stashed` | `inbox_stashed_at` set |
  | `hidden` | an anchor row (`is_anchor`) that is not hard blocked; ships liveness, never places or counts |
  | `questions` | `asking` is true: own open AskUserQuestion or permission prompt, a pending `cast decide`, or a child's open ask |
  | `pinned` | `inbox_pinned_at` set |
  | `new` | `message_count` is 0 |
  | `needs_input`, `done`, `dormant`, `working` | the `work_state` |
  | `idle` | `work_state` idle (an empty or killed row that still shows) |

  `pinned` outranks the work buckets, so Needs Input never counts a pinned row (the web
  rule). `work_state` is still stamped on pinned rows, so the CLI keeps its tallies
  (`pinned` and `live` alongside the work figures) unchanged.

`asking` folds the child case in server side: the candidate pool already contains a
parent's recent children, so a child with `permission_blocked` status (from the maps) or
an open AskUserQuestion (the same probe, run only for children with a non idle trusted
status, so bounded by live children) marks its parent. The client's `liftQuestions` reads
the stamp and nothing else; the walk over the whole cache is gone.

Trigger absorption stops changing counts. Standing and once triggers reach the classifier
through `armed_trigger_kind`, which is the whole of their effect on placement. The panel's
schedule grouping (`partitionTriggerInbox`) becomes presentation: it groups rows under a
trigger row without moving them between buckets.

### C4 The rendered set is the projection

- **Membership comes from the overlay.** `liveInboxIds` (and `teamInboxIds`) are the key
  set of the last overlay payload for that scope, no longer the base payload's ids. A row
  counts if and only if its id is in that set. The pinned, parent, hidden, and nest parent
  exemptions in `isOldSession` are deleted: the projection already includes pinned rows,
  children are never counted, fold rows carry their own flag, and a fork or teammate row
  is a projection member only through its own windows.
- **Fold rows render behind the existing toggle.** A projection member with
  `below_fold: true` renders only when show old is on; its count is the `folded` tally.
  Because old bundles derive `liveInboxIds` from the base, which still omits fold rows,
  this ships dark.
- **Bodies are the base's job.** A projection id whose row body has not arrived counts
  (the pair exists) and renders once the body lands. The base and the overlay re execute
  in the same Convex transition for any write that affects membership, and the client
  applies both feeds in one store commit, so the gap is transient; the heal path fetches
  persistent gaps through `getInboxSessionsByIds`.
- **Cold state is a tri state.** The store keeps `projection` as never received
  (`null`), received empty, or received nonempty, and persists the last payload's id set
  and buckets keyed by user id and scope. A persisted snapshot whose key does not match
  the hydrated user is discarded. Counts are withheld only when never received; a stale
  snapshot renders its counts with an age label from `as_of`, because good stale data
  beats no data on a plane. Rows outside the projection stay in the cache (search, open,
  reuse, per the standing never prune decision) and never count.
- **Overlay owned fields have one writer.** The sessions registry lists the fields only
  `syncOverlay` may write: the liveness fields, `bucket`, `work_state`, `asking`,
  `below_fold`, `bucket_stale_at`, `stale_bucket`. `syncTable` strips them from every
  incoming sessions row (base, byIds, crawl pages, sync log applies) before the merge, so
  the preserve rule keeps the overlay's value and no other execution can write a torn
  status onto a counted row.

### C5 Declared overlays

Local adjustments to the projection are enumerated in one place, each with a name, an
effect, and a bound. Every one is excluded from the digest compare by construction.

| Overlay | Effect | Bound |
|---|---|---|
| optimistic create stub | appears in Working | until the server row supersedes it (altKey) |
| optimistic triage gesture (dismiss, pin, stash, un dismiss) | moves or removes the row; a pin or un dismiss of a row outside the projection renders it in Pinned and counts it there | until the ack retires the pending entry or HIDDEN_OVERRIDE_SETTLE_MS |
| focused session | stays visible while open | while focused; never counted if outside the projection |
| queued or pending send in the open view | Needs Input to Working | while the queue or pending entry holds |
| revive request | Needs Input to Working | BLOCKED_REVIVE_TTL_MS (120s) |
| time flip | `bucket` to `stale_bucket` | from `bucket_stale_at` until the next payload |
| blank hiding | a `new` row renders only when engaged locally (draft, pending create, focused) | rendering only; `new` tallies are the server's |
| draft | a row with a local draft renders in New | while the draft exists; rendering only |

Nothing else may change a count. Chip filters, label lenses, and the schedule grouping are
presentation over the placed rows and cannot touch the headline tallies.

### C6 Channels

- **One argument set.** `INBOX_PROJECTION_ARGS` is the single constant the live base
  subscription, the base recovery probe, and the heal fetch use (plus `_probe` on the
  probes). The overlay probe likewise mirrors the overlay subscription's args. A test
  pins them.
- **One commit per transition.** The base and overlay feeds share one coalescer in
  `useSyncInboxSessions`, so rows, membership, and buckets that arrive in the same Convex
  transition land in one store commit, and the digest never sees a torn frame.
- **Every backstop is the recovery controller.** No feeder adds a bespoke interval; each
  goes through `createRecoveryController`, with its base staleness set to at least twice
  the feeder's expected push interval so a healthy subscription never probes. A passed
  `bucket_stale_at` is the one extra staleness input, on the overlay probe only.
- **Feeders never unmount each other.** The live sessions query moves behind a wrapper
  that reports a thrown query error and keeps its siblings mounted (`useQueryNoThrow`
  semantics), on web and mobile alike. The `DashboardSync` error boundary stops being the
  only thing between a bad query and a silently frozen inbox.

### C7 One placement surface, one feeder set

- One chokepoint (`placeInboxRows` in the store) takes the projection, the cached rows,
  and the declared overlay inputs, and returns the placed buckets and tallies. Every
  consumer calls it: the panel, the sidebar badge, the dock badge, the active agents pill,
  the fleet board, the thread cards, the palette, and mobile's inbox. A source level guard
  bans `categorizeSessions`, `partitionOldSessions`, and `liftQuestions` outside the
  chokepoint, in the style of the registered feeds guard.
- One `useSyncCore(profile)` hook owns the feeder mount set: sync log applier, live base,
  liveness overlay, team base and team overlay, recovery probes, completeness crawl,
  dismissed and stashed reconciles, session decisions, client state, current user,
  buckets. Web's `DashboardLayout` and mobile's `StoreSyncBridge` both mount it. The
  profile declares each feeder's mount condition: team feeders mount only while team scope
  is active on every platform, and the guard asserts every registered feeder is in the
  profile rather than mounted by hand. On mobile the whole set pauses on AppState
  background and resumes with one catch up (a heads pass and one probe), which also
  replaces the `document` visibility nonce the crawls use today.

### C8 Anti entropy: digest compare, heal, telemetry

- **Digest.** `set_digest` is an order independent hash over the projection's
  (id, bucket) pairs: FNV 1a 32 over `id + ":" + bucket` per pair, folded into two 32 bit
  lanes (a plain sum and a sum of `Math.imul(h, h | 1)`), rendered as 16 hex characters.
  No sorting, no BigInt, no string concatenation of the whole set. One implementation in
  `packages/shared/contracts/inboxProjection.ts` with a fixed test vector, used by the
  server and by every client.
- **Compare.** The client digests the pairs it would render, computed inside the
  chokepoint's memo so it costs nothing extra, and compares on the 15 second coarse tick,
  never per apply. The compared set is: every projection id, with its server bucket,
  minus rows holding a pending field or exclude entry, minus optimistic stubs, minus the
  focused row when outside the projection; time flips, blank hiding, drafts, queued
  sends, and revive stamps use the server bucket. Nothing outside the projection is
  counted. A comparison is skipped when the client's projection snapshot is not the one
  the digest was computed for (the digest carries `as_of`).
- **Missing bodies are a separate class.** Projection ids with no cached row are
  counted as `missing_bodies`, healed through `getInboxSessionsByIds`, and never trigger
  a projection refetch.
- **Heal.** A mismatch that is not a missing body re requests the overlay through the
  recovery controller (in flight guard, timeout, doubling backoff) under a budget of
  three heals per ten minutes per client; the fourth emits `inbox_drift_persistent` and
  stops. Heal respects pending entries exactly as `syncTable` does; it never bypasses
  them.
- **Kill switch.** With the `INBOX_DIGEST_DISABLED` Convex env var set, the server
  returns `set_digest: null` and every client skips compare and heal, so one env change
  silences every deployed bundle without a redeploy.
- **Telemetry.** `inbox_drift` fires immediately on a nonzero mismatch, deduplicated per
  (server digest, client digest) pair, with counts only: `missing`, `extra`,
  `bucket_deltas`, `missing_bodies`, `payload_age_ms`, `epoch_age_ms`, `scope`,
  `platform`. `inbox_digest_heartbeat` fires once per client per hour with `checks`,
  `mismatches`, `heals`, and `max_payload_age_ms`, which is how "no drift" is
  distinguishable from "the check did not run". Never id lists (mobile's `track` takes
  scalars only, and conversation ids are not for PostHog). The acceptance bar is two
  weeks of heartbeats with zero mismatches across web, desktop, and mobile.

### C9 Transport closures

- **Raw builder bypass.** The functions guard test fails any file that imports
  `mutation` or `internalMutation` from `_generated/server` unless it is on a short
  explicit allowlist, regardless of which tables it writes today. Eight files currently
  import the raw builders for untracked tables; a future patch of `conversations` in one
  of them would emit no sync action, and the guard closes that class.
- **Churn exempt classification inputs.** `isUserDormant` and `isSettleVerdictCurrent`
  expire against `updated_at`, which is churn exempt. That transition emits no sync
  action, and it does not need to: the overlay re executes on the `updated_at` write and
  delivers the new bucket. Documented dependency, no new log traffic.
- **Retention floor.** Traced: the prune walk deletes a contiguous prefix from the old
  floor, sets the floor to the last deleted position (or to head when the scope drained),
  and `readRangePage` resyncs when the floor passed the cursor. Non monotonic timestamps
  can only over retain. A unit test pins both floor branches and closes the item.
- **Zombie subscriptions.** Every `useQuery` or `onUpdate` feeder pairs with an error
  handler and a controller backed probe; the digest loop is the universal detector for
  the ones this misses.

## Payload contract

`sessionsLiveness` and `teamSessionsLiveness` return:

```
{
  liveness: Record<conversationId, LivenessFields & {
    bucket: InboxBucket;            // placement, see C3
    work_state: WorkState;          // classifyWorkState verdict
    asking: boolean;                // own ask, pending cast decide, or a child's ask
    below_fold: boolean;            // under the cluster cut; renders only with show old
    bucket_stale_at: number | null; // ms; earliest instant a time term flips the bucket
    stale_bucket: InboxBucket | null; // the bucket at bucket_stale_at, or null
  }>,
  projection: {
    v: 1,
    as_of: number,                  // the execution's Date.now()
    epoch: number,                  // floor(as_of / 60000) * 60000, used by every time term
    user_id: string,
    scope: "mine" | "team",
    team_id: string | null,
    tally: {
      shown: Record<InboxBucket, number>,   // rows with below_fold false
      folded: Record<InboxBucket, number>,  // rows with below_fold true
    },
    set_digest: string | null,      // 16 hex chars; null when INBOX_DIGEST_DISABLED
    truncated: Array<"recent" | "pinned" | "dismissed" | "stashed" | "owned" | "members" | "member_rows" | "foreign_scan">,
  }
}
```

`InboxBucket = "questions" | "pinned" | "new" | "needs_input" | "done" | "dormant" |
"working" | "idle" | "stashed" | "dismissed" | "hidden"`. The projection id set is
`Object.keys(liveness)`. The digest covers every pair in that set, `hidden` included;
the tallies exclude `hidden`.

`listInboxSessions` and `listTeamInboxSessions` gain only `truncated` (same alphabet) and
keep every existing field and argument. `getInboxSessionsByIds`, `listInboxSessionsPaginated`,
and `inboxForCLI` keep their shapes; `inboxForCLI` rows gain `bucket` and `below_fold`
next to the existing `work_state`, and its counts gain `below_fold`.

Conversation documents gain `armed_trigger_kind?: "none" | "standing" | "once"`.

## Client store contract

```
projection: {
  received_at: number;              // client clock at apply
  as_of: number; epoch: number;
  user_id: string; scope: "mine" | "team"; team_id: string | null;
  tally: { shown: Record<InboxBucket, number>; folded: Record<InboxBucket, number> };
  set_digest: string | null;
  truncated: string[];
} | null                            // null = never received (cold)
projectionSnapshot: {               // persisted; replaces liveInboxIdList and teamInboxIdSnapshot
  user_id: string; scope: "mine" | "team"; team_id: string | null;
  as_of: number; epoch: number;
  ids: string[];
  buckets: Record<string, InboxBucket>;
} | null
liveInboxIds: Set<string>           // Object.keys(liveness) of the last mine overlay
teamInboxIds: Set<string>           // same, team overlay
```

Per session row, written only by `syncOverlay`: the existing liveness fields plus
`bucket`, `work_state`, `asking`, `below_fold`, `bucket_stale_at`, `stale_bucket`.
`CACHE_SCHEMA_VERSION` moves to 23 with the registry change.

## What this deliberately does not do

- No client cache pruning (standing decision; the cache is not the counted set).
- No CRDTs, no vector clocks, no second source of truth. Convex serializable transactions
  plus per scope positions already give a total order per scope; the work is making the
  derived projection deterministic and verified.
- No change to workspace or access semantics; scope keys remain routing, access stays in
  the stage two byIds queries.
- No new query arguments. Every new field is a result field, so no deployed bundle can
  hit an argument validation error, and a Convex revert degrades a new client to the
  honest cold state (cards visible, counts withheld, a banner), never to wrong numbers.
  The revert path is the forward redeploy of the Convex commit.
- No epoch as a subscription argument, and no `sync_heads` read inside the inbox queries.

## Rollout

1. Convex (ct-47200): shared classifier and digest in `packages/shared/contracts`;
   overlay stamps and `projection`; `armed_trigger_kind` on conversations with its
   writers; `session_decisions` read; child asks; epoch; fold flag; truncation flags;
   pinned window order, cap, and mutation guard; priority ordered foreign scan;
   `inboxForCLI` on the shared function; kill switch. Deploy before any client ships.
   The base `show_all: false` payload is byte identical for deployed bundles, and the
   overlay's new keys are ignored by them.
2. Web (ct-47201, ct-47202, ct-47203): registry and snapshot changes, projection gate,
   declared overlays, chokepoint, `useSyncCore`, digest loop. Mobile mounts `useSyncCore`
   and deletes its local partition and categorize passes in the same change; the store is
   shared, so the OTA carries it.
3. Transport closures (ct-47204) ship with either step; they are independent.
4. Telemetry watch (ct-47205): two weeks of `inbox_digest_heartbeat` with zero mismatches
   across web, desktop, and mobile in prod.

## Validation plan

- Unit, server: two overlay executions over the same data in the same minute produce
  identical `liveness`, `tally`, and `set_digest`; the base payload contains no
  projection field; `computeInboxSessions` with liveness off performs no
  `managed_sessions` or `messages` reads (the `_skip` seam); `computeSessionsLiveness`
  read count does not grow with stamping (the timing harness); fold never changes
  `shown + folded`; every truncation flag fires at its cap; the pinned window returns the
  newest pins; the classifier's pending API error, pinned, anchor, and child ask rules;
  `bucket_stale_at` and `stale_bucket` for each time term; the digest test vector.
- Unit, client: `syncTable` strips overlay owned fields from every sessions channel;
  the compare rule excludes each declared overlay; the projection snapshot is rejected on
  a user key mismatch; the tri state withholds counts only when never received; the heal
  budget and the kill switch; the args constant pins the live, probe, and heal calls;
  every registered feeder is in the `useSyncCore` profile; the chokepoint guard.
- Simulation: a store level convergence test replays interleaved overlay payloads, base
  payloads, gestures, crawls, time flips, and reconnects on two simulated clients and
  asserts equal placed projections and equal digests at quiescence.
- End to end: web and the mobile simulator against dev Convex; drive pin, dismiss,
  settle, and trigger arm transitions; assert equal counts within one payload cycle;
  kill one client's subscription and assert the digest loop detects and heals within the
  budget; revert the Convex commit on dev and assert the client renders the cold state
  with siblings still mounted.
- Prod: the drift metric itself.
