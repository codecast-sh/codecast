# Sync log migration

Status: in progress (pl-399). This note pins the decisions the local-first restart brief
required before any client work. It is deliberately small: the design is an append only log
next to the existing machinery, not a second domain model.

## What we are building

An append only, per scope sync action log on the server, and a client applier that treats it
as the single completeness path. The log replaces three heuristics:

1. `change_log`'s mutable one row per entity with `seq = Date.now()` and a 10 second client
   overlap window (a recovery heuristic, not an ordering proof).
2. The tasks/docs reconcile crawls' `updated_at` watermark (`since` mode) as the way a client
   proves it has everything.
3. Value echo as the only rule that retires a pending (optimistic) entry.

Live Convex table queries stay exactly as they are. They are the realtime push transport and
the snapshot floor; the log owns ordering, catch up, deletion, revocation, and write
acknowledgement. Both feed the same `syncTable` appliers with idempotent upserts.

## Decisions

### D1 — Ordering primitive: per scope counter, advanced in the writing transaction

Two new tables:

```
sync_heads:   { scope_key, position, floor, updated_at }        index by_scope (scope_key)
sync_actions: { scope_key, position, entity_type, entity_id,
                op, ts }                                         index by_scope_position (scope_key, position)
                                                                 index by_ts (ts)
```

`scope_key` is `user:<userId>` or `team:<teamId>` — the same key vocabulary as the stored
`workspace` access key. On every tracked write, inside the same Convex mutation transaction:
read the scope's head, `position = head + 1`, patch the head, insert the action. Convex
mutations are serializable, so per scope positions are gap free and strictly increasing by
construction. That is the whole ordering proof; no wall clock is involved (`ts` is retention
and debugging metadata only).

Contention: concurrent writers to one scope conflict on the head row and Convex retries one
of them. Tracked writes are semantic transitions (no heartbeats, no message rows, no
managed_sessions), so the per scope rate is a few per second worst case. Within one
transaction the interceptor coalesces repeated writes to the same entity into one action, so
a mutation that patches a conversation five times appends once. We measure retry rates during
validation before widening coverage.

### D2 — Tracked tables

Exactly the `change_log` set: conversations, tasks, docs, plans, projects. Plus scope
membership actions (D5). Extension is declarative: a table joins by entering the tracked set
in `changeLog.ts` and satisfying the same uniform `{ user_id, team_id? }` scope shape.

### D3 — Scope stamping mirrors change_log semantics exactly

One action row per scope. Tasks, docs, plans, projects: always the owner scope
(`user:<user_id>`); additionally the team scope (`team:<team_id>`) when `team_id` is set.
Conversations: owner scope only — the inbox is owner only, and a teammate seeing my session
in the team feed is a separate axis with its own transport. This is a faithful migration of
today's visibility, not a semantics change.

The log is routing, not access: it carries opaque entity ids to users who may care. Access is
enforced where it always was — stage two, where the client fetches current state through the
authorized `*byIds` queries; an id the viewer cannot see returns nothing and the client
prunes it. This is the existing change feed contract, restated.

### D4 — Scope moves append a revocation

When a patch changes `team_id` (or `user_id`), the interceptor reads the document before the
write and appends `delete` in the departed scope and `upsert` in the entered scope. Entity
deletion appends `delete` in every scope the row was visible in. This fixes the revocation
loss inherent in change_log's mutable latest row (restart brief invariant 8). The pre read
happens only when the patch touches scope fields — the hot path (ordinary field change) stays
one indexed head read plus one insert.

### D5 — Scope set lifecycle

`team_memberships` insert/delete appends an action in the affected user's own scope:
`{ entity_type: "scope", entity_id: <team_id>, op: "scope_added" | "scope_removed" }`.
The client, on `scope_added`, starts tracking `team:<id>` (cold cursor bootstrap + workspace
backfill); on `scope_removed`, purges rows whose `workspace` is `team:<id>` from the log
covered collections and drops that scope's cursor. Today this requires a reload.

### D6 — Read API (additive, new file `convex/syncLog.ts`)

- `getHeads {}` — resolve the caller's scopes (own user scope + each team membership), return
  `[{ scope_key, position, floor }]`. Tiny payload; this is the live subscription that
  replaces "re-push the whole window on any change" as the wake signal.
- `getRange { scope_key, from, limit }` — verify the caller holds the scope, return actions
  with `position > from` ascending, `take(limit + 1)` for `hasMore`, plus `nextFrom`. If
  `from < floor` (retention passed the cursor) return `{ resync: true }` and the client falls
  back to a full backfill.

Stage two is unchanged: `conversations.getInboxSessionsByIds`, `tasks/docs/plans/projects
.webGetByIds`.

### D7 — Client applier (replaces the internals of `useSyncChangeFeed`)

Per scope cursor persisted in `syncMeta` under `synclog:v1:<scope_key>`, forward only.
Flow on head movement (subscription push) and on wake/focus/online:

1. Scope with no cursor: stamp cursor = head and stop (the change feed's bootstrap rule —
   completeness of the past is owned by the backfill, D9).
2. `head > cursor`: page `getRange`, dedupe by entity (latest op wins), then the existing
   apply shape: prune deletes, lift excludes, `byIds` fetch, `syncTable(..., isDelta)`,
   prune upsert ids the authorized query did not return.
3. Advance the cursor only after the page applied; then retire acked pending entries (D8).
4. `scope_added` / `scope_removed` actions run the D5 lifecycle.
5. `resync: true`: clear the scope's `backfilledAt` so the cold backfill re-runs, stamp
   cursor = head.

No overlap window, no `Date.now()` cursor, no `_probe`. The old `getChangesSince` server
query and the old client cursor stay untouched for deployed bundles.

### D8 — Position based acknowledgement for pending entries

`dispatch` gains an optional `ack_positions: boolean` arg. The write interceptor collects
`{ scope_key, position }` for every action it appends during the mutation; when the flag is
set, dispatch returns `{ __syncAckV1: positions, result: <original result> }`. Only the new
client sends the flag, so old clients see the unchanged shape.

On the client, the dispatch binding (useEnsureDispatch) unwraps the envelope, hands the inner
result to the engine unchanged, and stamps the pending entries generated by that action —
keys derived from the dispatched patches with the same rule as auto pending — with
`ack: [{ s: scope_key, p: position }]`. The log applier, after applying a range for scope S
up to P, deletes pending entries carrying an ack with `s === S && p <= P`: by construction
the stage two fetch returned state written after the acknowledged write.

Value echo retirement stays. Ack retirement is additive and finally gives `exclude`
tombstones (kills, dismissals) a deterministic end of life instead of the 30 day hydration
expiry.

### D9 — Snapshot cut at a position

The cold backfill (tasks/docs full crawl; sessions live floor + union hydrate) captures
`getHeads` before it starts. When the crawl completes fully, the client stamps the log cursor
to the captured head — everything the crawl could have missed arrives by replaying the log
from that position. The `since`/`updated_at` incremental crawl mode is no longer the
correctness path: the crawl runs on cold cache and after `resync`, and stays only as a
demoted safety net (24 h throttle) until the removal condition in D12 is met.

### D10 — Retention

A daily cron deletes `sync_actions` with `ts` older than 30 days (bounded batches) and
advances each scope's `floor` to the lowest retained position minus one. A client whose
cursor is under the floor gets `resync: true` (D6 → D7 step 5). Heads are never deleted.

### D11 — Validation

- Unit: gap free positions under interleaved writers; scope move revocation; membership
  lifecycle; range paging and resync; ack collection; client applier (plan/dedupe/purge,
  cursor advance, ack retirement) — pure function tests in both packages.
- Shadow: a dev only comparator (flag gated) that, after each log apply, runs
  `getChangesSince` over the same wall clock window and warns on entity id set divergence.
- End to end: convex deploy, then drive local web — edit a task from a second principal,
  freeze the tab, wake it, verify the log path converges; kill a session and verify the
  exclude retires by ack.

### D12 — What this deletes, what it keeps, and the removal conditions

Deleted now (new client): the change feed overlap/cursor heuristics (file internals),
`since` mode as correctness, the `CHANGE_FEED_META_KEY` cursor.

Kept, with removal conditions:

- `change_log` dual write + `getChangesSince`: remove when deployed web/desktop/mobile
  bundles that call it have rolled off (measure by query log), not before.
- Reconcile crawls at 24 h: remove after two weeks of shadow comparator silence in dev and
  no resync anomalies.
- Dismissed/stashed bootEager crawls: their healing role (dismiss does not move
  `updated_at`) is covered by the log since a dismiss patches `conversations` and appends an
  action; remove behind the same condition as the crawls.
- Live table queries, liveness overlay, recovery poll: not in scope; they are the push
  transport and are already load shaped.
- The dormant v2 receipt tables (`local_view_heads`, `local_command_receipts`) and their
  server writers: untouched here; position acks make the receipt design unnecessary for new
  work, and their deletion is a separate cleanup with its own compat check.

### D13 — Rollout order

1. Convex: schema + interceptor dual write + read API + cron (additive; deploy first).
2. Client: applier + acks + snapshot capture behind the normal build; ships with the next
   web deploy after the Convex deploy. Old bundles are unaffected at every point.
3. Demotions (crawl throttle) ship with the same client change; deletions wait for D12.

## Non goals

Turbopuffer or any secondary index store (a Convex index on `(scope_key, position)` is the
Postgres path before it hurt, at our scale). Team visible conversation actions (owner only
today, owner only here). MobX style object pools. Replacing live queries as the realtime
transport. Event sourcing of message streams (demand driven relations keep their scoped
queries and coverage markers remain a follow up).
