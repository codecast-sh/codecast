# Sync log cargo: patches and access in the log

Status: design for pl-498. Companion to `sync-log-migration.md`
(transport: per scope ordered catch up, D1–D13) and `sync-convergence.md` (the replica
model: facts replicate, derived state is computed on the replica by shared pure code).
This document extends the log so its rows CARRY the change, and makes the log the sole
steady state delivery path for tracked collections. It does not change positions, heads,
acks, retention, or the doorbell + one shot read topology.

## Why

Convex's subscription protocol has one primitive: re-run the query and push its complete
result (`QueryUpdated` carries the full value; verified against the client source and
Convex's own architecture writeup). Every efficient design on top of it keeps the
subscribed value tiny (the head integer) and moves data through one shot reads (the
range). We already do that. What the range rows carry today is only the id, so the applier
pays a third leg — the authorized `byIds` fetch — and the fat live list queries still
re push their whole window on every write. With payloads in the rows, a change reaches an
open client once, as the fields that changed: doorbell + range, O(changed bytes).

This is Linear's actual model (sync actions carry `data`) and the transport the
convergence design assumes ("facts replicate to client DBs, denormalized at write time
where joins existed").

## Decisions

### E1 — Patch semantics: merge patch, never operation lists

A row's `patch` is `{ field: newValue }` over TOP LEVEL document fields (RFC 7386 shape).
Removed fields are listed in `unset: string[]` (Convex `patch(id, { f: undefined })` unsets;
undefined cannot ride JSON). Applying a patch is field assignment, so it is idempotent and
merge associative — load bearing, because coalescing merges patches when it moves a row
forward and a client can re see a moved row. RFC 6902 style ops ("insert at index 3") are
neither and are banned.

`full: true` marks a patch that is the entire document (insert, replace): the client needs
no base row. A non full patch for a row the client lacks falls back to a `byIds` fetch of
that id (the row lives outside the client's cached window).

### E2 — Coalescing merges cargo

Moving an entity's row to the new head (D1) now also merges cargo: `patch = { ...old,
...new }`, `unset = union minus keys reintroduced by new`, `full = old.full || new.full`.
The coalesced row therefore carries every field changed since the row was last pruned — at
worst the whole document, which is the insert case anyway. The table stays bounded by
churned entity count.

### E3 — Payload denylist and size guard

`PAYLOAD_DENYLIST[table]` names fields that never ride the log: `docs.content` (doc bodies
have their own delta channel and the list caches are deliberately thin), plus any field the
enrichment audit classifies as heavy. A patch that touches a denylisted field carries the
other fields and sets `partial: true`. A serialized patch over 64 KB is dropped to
`partial: true` with no fields (protects the 1 MB document ceiling and keeps range pages
cheap). `partial` tells the client to schedule a `byIds` refetch of that id after applying
what it has — the enrichment path, not the hot path.

### E4 — Access enters the log, enforced at read

Each action row gains an ACCESS stamp, distinct from `scope_key` (routing):

```
access_owner:  user id           (always)
access_key:    workspace key      (tasks/docs/plans/projects: the stored `workspace`;
                                   conversations: none — owner scope only)
access_grants: user id[]          (tasks: assignee; extension point, usually empty)
```

`getRange` PROJECTS every row through the caller before returning it: caller is owner, or
in grants, or holds `access_key` (a team membership) → the row as written (`upsert` +
cargo); otherwise → `{ op: "delete" }` with no cargo. Delivery of an id you may not read is
today's behavior (the change feed fans ids); delivery of FIELDS you may not read never
happens, and a caller who loses access sees a delete on the next range — which is how a
`workspace` recompute (private inside a team) or an assignee change revokes without per
viewer rows and survives coalescing (the LATEST stamp governs, so a revoke then restore
resolves correctly for every reader).

Owner scope rows are always authorized (caller is owner by construction). The stamp is
read from the document AFTER the write (the same post write read the interceptor already
does when scope fields change); `computeWorkspaceKey` writers are ordinary patches through
the wrapped builders, so an access change appends an action like any other.

This crosses the routing/access line from CLAUDE.md deliberately: `scope_key` remains
routing and is never compared to `workspace`; `access_key` IS the access predicate and is
enforced by one equality in `getRange`, exactly like every other workspace read. The
source guard test extends to assert (a) `getRange` is the only reader of `access_key`, and
(b) no path derives access from `scope_key`.

### E5 — Deletes keep authorized absence

A `delete` (real, revocation on a scope move, or the E4 projection) still prunes only after
the `byIds` check confirms the authorized query omits the id (D4's rule). Deletes are rare;
one small query per delete is cheap, and it keeps cross scope reasoning out of the log (a
viewer in both departed and entered team still holds the row).

### E6 — Client application

For each range action, in position order, through the store's sync actions only
(replication invariant 4: replicated data enters via `syncTable`/`syncRecord`):

1. `delete` → collect for the E5 verification batch.
2. `full` → `clearFeedExcludes` + `syncTable(coll, [row], isDelta)`.
3. patch, base present → `syncRecord(coll, id, fields)` (per field merge; the engine's
   `applySyncRecord` re asserts pending field locks, so local first protection is
   unchanged), then apply `unset`.
4. patch, base absent → collect for the `byIds` batch (out of window row).
5. `partial` or a patch touching `ENRICH_TRIGGER_FIELDS[coll]` → also collect for a
   `byIds` refetch (re enrichment), after applying the raw fields so the visible change is
   instant and the joins catch up a round trip later.
6. Sessions/conversations: strip `INBOX_FACT_FIELDS` from every patch before applying —
   the liveness overlay is the single fact writer (convergence C1).

The applier counts, per run, patches applied directly vs ids sent to `byIds`, and exposes
the ratio in the sync pill's detail panel and `synclog_apply` analytics: the number that
proves the hot path moved.

### E7 — Enrichment: derive on the replica, denormalize only low frequency joins

Per collection, the enrichment audit classifies every field a `byIds` row carries beyond
the raw document as: raw (patch carries it), replica derivable (compute at render from
collections the client holds — `liveEntities`, the convergence rule), write time
denormalized (a low frequency join stamped onto the row by its writer, like
`armed_trigger_kind`), or refetch (an `ENRICH_TRIGGER_FIELDS` entry). The audit's verdict
per collection is the acceptance gate for retiring that collection's fat query (E8). High
frequency joins are never denormalized (they would serialize on the head row — the ask
state precedent in convergence C1).

### E8 — Retiring the fat live queries, one collection at a time

Once a collection's patches apply directly and its enrichment is settled, its live list
subscription becomes BOOTSTRAP ONLY: run once on cold cache and workspace switch (the
snapshot floor, cut at the captured head per D9), never held open. Steady state freshness
rides the log alone. Order: tasks (`webList` delta cursor machinery deleted), then docs,
plans, projects. Sessions' `listInboxSessions` is deliberately NOT retired here — the
convergence design (C1/C4) currently depends on the live window delivering row bodies and
on the liveness overlay; conversation patches DO apply through the log (so `byIds` leaves
the sessions hot path), and window retirement is filed as a follow up gated on pl-484.

Each retirement is measured: WebSocket bytes per write for the collection before and after
(the wsframes harness), and the E6 direct/refetch ratio. A retirement that does not move
the bytes is reverted, not kept.

### E9 — Rollout and compat

Server first, additive: new optional fields; emission on by default with an env kill switch
(`SYNC_LOG_PAYLOADS_DISABLED=1` → rows carry no cargo, clients fall back to `byIds`
automatically because absence of `patch` IS the fallback signal). Old client bundles ignore
the new fields and keep working (they call `byIds` for every id as today). The projected
delete in E4 is safe for them too: an unauthorized id already pruned via absence. Client
second, per collection, behind the E8 measurements. Every phase lists what it deletes.

### E10 — Validation

- Server unit: merge patch associativity and idempotence; unset handling; coalesce merge;
  denylist and size guard → `partial`; access projection (owner / grant / workspace /
  none → delete); revoke then restore under coalescing; conversations carry no team scope
  cargo; churn exemption unchanged.
- Client unit: patch onto base with a pending lock (lock wins, ack retires it); full row
  path; no base → byIds; partial → refetch; fact strip; unset; delete → authorized absence.
- Guard tests: `access_key` single reader; `scope_key` never an access input; payload
  denylist covers `docs.content`.
- Shadow comparator v2 (dev flag): after a direct patch apply, fetch the row via `byIds` and
  assert every raw field the patch carried is equal — directional, so enrichment noise
  cannot mask a wrong patch.
- End to end (browser, dev web against prod convex): edit a task from the CLI → the tab
  applies the patch with zero `byIds` calls (counter); make a task private inside a team
  from one account → the teammate's tab prunes it on the next range; kill a session →
  exclude retires by ack as before.
- Prod: WS bytes per collection before/after each E8 retirement; `synclog_apply` ratio;
  head OCC retry rate unchanged.

### E11 — Deletion ledger

Per collection at E8: the live list subscription's steady state re push, the 30 s delta
cursor resubscribe machinery (`useSyncTasks`), and the `byIds` hot path call. Kept: the
bootstrap snapshot queries, the `byIds` queries themselves (deletes, out of window,
re enrichment, the convergence heal), the cold backfill and its demoted 24 h schedule
(D12 conditions unchanged), change_log dual write (D12).

## Non goals

Per viewer materialized rows (the E4 projection replaces them). Sub field patches
(nested paths) — top level fields only; a nested edit ships the whole field. Message
streams (demand driven, own channel). Retiring `listInboxSessions` (pl-484 dependent).
