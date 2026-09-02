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

Moving an entity's row to the new head (D1) also merges cargo, with these rules (the
implemented `mergeCargo`, pinned by unit tests):

- `patch = { ...old.patch, ...new.patch }`; a key in `new.unset` is removed from the merged
  patch; a key re set by `new.patch` drops out of `unset`; `unset` is otherwise the union.
- A FULL incoming cargo (insert/replace) replaces everything, including a prior partial.
- `partial` is STICKY: `old.partial || new.partial` until a full cargo replaces it (a reader
  whose cursor sat below the old position sees only the coalesced row and must keep
  refetching until the row can prove its contents again).
- An incoming cargo with no patch (kill switch, oversized) poisons the row to partial with
  no patch.
- `omitted` names accumulate (E3).
- A `delete` clears cargo AND the access stamp (a tombstone's stamp is never reused).

**Self heal.** Hot rows never prune (their `ts` stays young), so a merged cargo would grow
toward the whole document and a sticky partial would be permanent. Therefore, whenever the
merged cargo is partial or exceeds `CARGO_MAX_BYTES` (16 KB), the interceptor rebuilds it as
a FULL cargo from the post write document (denylist applied); if that fits it replaces the
merge, otherwise the row stays partial without a patch. Partial is thus a one time state
for any row whose document fits, and the row's cargo is bounded by the cap, not by its
lifetime.

### E3 — Payload denylist and size guard

`PAYLOAD_DENYLIST[table]` names OMIT class fields: ones the client's LIST rows never carry
(`docs.content`, `embedding`, `entries`; tasks' `drive`/`steps`/… detail only fields; plans'
logs; conversations' embeddings and machine state) plus `team_id` for docs and plans (the
list channels rewrite it to the effective team; the client derives it from `workspace`).
Dropping them loses nothing and must NOT mark the row partial — a partial that never heals
would put every edited doc on the byIds path for its whole life (review). Their NAMES ride
along in `omitted` so a client that derives something from one (a plan mode doc's
`display_title` from its body) can choose to refetch.

`CHURN_ONLY_FIELDS` never ride cargo at all, even inside a semantic patch (review): churn only
writes emit no action, so a churn value captured on a semantic write would go stale in the
coalesced row and revert the live value on the next move. The live window and the liveness
overlay own those fields (D1).

`partial: true` comes from exactly two places: the size guard (a serialized patch over
`CARGO_MAX_BYTES`) and the cargo kill switch. Both heal per E2.

### E4 — Access derived fan out, and a stamp enforced at read

**Fan out follows access, not routing (review blocker).** The transport's scopes are derived
from the access facts of the post write document: the owner's user scope always; the
workspace key's team when the stored key is a team key; each explicit grant (a task's
assignee) in their own user scope; conversations owner only. A routing `team_id` whose
workspace is `user:<owner>` (private inside a team) therefore never enters the team scope —
no existence leak, no projected delete probes — and every reader who may read a row holds a
scope it fans to, which is the property retiring the live lists needs (a task assigned to
you with no team, or in a team you are not in, reaches your user scope; today only
`webList`'s assignee union carries it). Assignee and workspace changes are scope moves (D4):
the departed scope gets a revocation delete.

**The stamp.** Each action row carries `access_owner`, `access_key` (the resolved workspace
key — stored, else computed — never for conversations) and `access_grants` (assignee). It is
ALWAYS read from the post write document, one memoized read per tracked write (a reused
stamp can outlive a scope move or a delete tombstone; review). `getRange` projects every row
per caller: owner, grant, or held key → the row with cargo; a row with no stamp → no cargo
(fail closed); otherwise → a bare `delete`. Cargo rides only when the caller opts in
(`cargo: true`), so deployed bundles keep thin rows.

**One predicate.** `accessStampFor` / `accessStampFromDoc` and `authorizedFor` live in
`lib/access.ts`, and `canAccessTask/Doc/Plan/Project` are DEFINED as evaluating that stamp,
so the log and the byIds queries cannot disagree by construction; a property test pins the
pure evaluator to the ctx bound one. The team list bootstrap queries (`webList`,
`webListPaginated`) filter their routing index reads through the same rule
(`visibleInTeamList`), closing a pre existing hole where a private inside a team task
reached teammates' floors.

This is the existing contract on a new table, not a crossing of the routing/access line:
`scope_key` derives from access facts, `access_key` is a write time copy of `workspace` read
only by `getRange`'s projection, and source guards in syncLog.test.ts pin both.

### E5 — Deletes keep authorized absence

A `delete` (real, revocation on a scope move, or the E4 projection) still prunes only after
the `byIds` check confirms the authorized query omits the id (D4's rule). Deletes are rare;
one small query per delete is cheap, and it keeps cross scope reasoning out of the log (a
viewer in both departed and entered team still holds the row).

### E6 — Client application

Scopes are fetched and applied strictly one at a time in one queue (review): positions
are per scope with no cross scope order, and a page's cargo is only as fresh as its fetch,
so pages must apply in fetch order. For each range action, in position order, through the
store's sync actions only (replication invariant 4):

1. `delete` → collect for the E5 verification batch, unless the replica does not hold the
   id (nothing to prune, no probe). For sessions "hold" means any of the three twins —
   the inbox row, the conversation meta, the message list — since an open per view
   conversation can exist without an inbox row and the prune clears all three.
2. `full` → `clearFeedExcludes` + `syncTable(coll, [row], isDelta)`.
3. full, no base, sessions → `byIds` only: an inbox row needs its triage stamps and
   liveness facts (the projection strips both from cargo), and a stamp less seed would
   render as a blank card for a round trip. Other collections seed from the full cargo
   and refetch for enrichment.
4. patch, base present → `applyCargoFields` → the engine's `applySyncPatch` (review
   blocker): it visits ONLY the locks for fields the patch or `unset` names, so a lock on an
   omitted field — a local clear is a lock with value undefined — survives; a named field's
   lock wins until its value echoes; an `unset` echoes an undefined valued lock. The
   collection's strip list applies here as on every channel. Only the collection itself is
   written — the `conversations` meta twin has its own feeders.
5. patch, base absent → collect for the `byIds` batch (out of window row).
6. `partial` or a patch touching `ENRICH_TRIGGER_FIELDS[coll]` → also collect for a
   `byIds` refetch (re enrichment), after applying the raw fields so the visible change is
   instant and the joins catch up a round trip later.
7. Sessions/conversations: strip `INBOX_FACT_FIELDS` from every patch before applying —
   the liveness overlay is the single fact writer (convergence C1).

The applier counts, per run, patches applied directly vs ids sent to `byIds`, shows the
tally in the sync pill's detail panel, and flushes it as `synclog_apply` analytics at most
once a minute (and on tab hide): the number that proves the hot path moved.

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
(`scripts/perf/ws-bytes.mjs`, a CDP frame meter that reassembles `TransitionChunk` parts
so the large pushes it exists to measure are attributed), and the E6 direct/refetch ratio.
A retirement that does not move the bytes is reverted, not kept.

**Measured (2026-09-02, dev web against prod convex, the host tab, 60 s, several agent
sessions writing).** After retirement the tasks, docs, plans and projects list queries no
longer appear on the socket at steady state at all; `syncLog:getRange` carried 29 KB in 24
calls; a CLI task status flip applied directly with one project count refetch and no task
or plan refetch. What remains is the sessions surface: `listInboxSessions` 29.8 MB in 17
pushes (1.75 MB each) and `sessionsLiveness` 10.5 MB in 50 pushes, 97 percent of all bytes.
That is the pl-484 gated follow up (ct-47800), and this number is why it is next.

**The floor's contract (review).** `useBootstrapCollection` is the one shot floor:

- It waits for `syncLogStampedAt`, which the applier sets after its first heads pass stamped
  every scope cursor (D9). A floor queried BEFORE the stamp can miss a write that commits
  between the floor's query and the heads capture; after it, such a write has a position
  above the cursor and replays.
- It applies its rows exactly once per (collection, args) per page session, however many
  mounts share the key. A remount after the floor landed re applies nothing: the snapshot
  is older than the patches that arrived since, and re overlaying it would revert them.
- A failed fetch is forgotten, so the next mount retries.

**Joined counts on projects.** A project row carries `task_counts`, `plan_count`,
`active_plan_count` and `doc_count`, joined by the server from other rows, so no patch on
the project ever moves them. The applier therefore refetches a HELD project whenever a
member change can change a count (a task or plan status change, a create, a delete, a
project move; `projectCountTouched`), and the projects collection compares `task_counts`
by content (`deepFields`) — the engine's identity reuse skips object fields, so without
that the refetched row would land as a no op.

### E9 — Rollout and compat

Server first, additive: new optional fields; emission on by default with an env kill switch
(`SYNC_LOG_PAYLOADS_DISABLED=1` → rows are poisoned to partial, clients fall back to `byIds`
automatically; the self heal restores full cargo on the next write after re enabling). Old
client bundles never see cargo (they do not send `cargo: true`) and keep working. The
projected delete in E4 is safe for them too: an unauthorized id already pruned via absence.
Client second, per collection, behind the E8 measurements. `localStorage SYNCLOG_CARGO_OFF=1`
is the client side kill switch.

**`SYNC_LOG_DISABLED` is different (review).** With emission off, writes reach documents
but no coalesced row, so after re enabling both the rows' cargo and every client's base
lie. Ops must run `packages/convex/run.sh syncLogPrune:markResyncAll` once after re enabling
(the wrapper does deploy.sh's env dance; a bare `npx convex run` targets the local dev backend): it sets every scope's
floor to its head, so every client takes the D7 resync path (drop cursor, full cold
backfill) instead of trusting its base. It bumps a synthetic position first so a client
that was fully caught up (cursor equal to the old head) falls below the floor too, and
the head change wakes open tabs. Rows at or below a floor are unreachable by every reader,
so the retention walk reaps them regardless of age (otherwise a sweep's rows would sit
below the floor forever and trip the retention alarm).

### E10 — Validation

- Server unit: merge patch associativity and idempotence; unset handling; coalesce merge;
  denylist → `omitted` only, size guard and kill switch → `partial`; access projection (owner / grant / workspace /
  none → delete); revoke then restore under coalescing; conversations carry no team scope
  cargo; churn exemption unchanged.
- Client unit: patch onto base with a pending lock (lock wins, ack retires it); full row
  path; no base → byIds; partial → refetch; fact strip; unset; delete → authorized absence.
- Guard tests (syncLog.test.ts): `access_key` appears only in syncLog.ts, schema.ts,
  changeLog.ts and lib/access.ts (the builder); lib/access.ts never mentions `scope_key` or
  `sync_actions`; every task_comments insert goes through insertTaskComment; the log's
  fan-out and `visibleInTeamList` agree with the stamp predicate over generated documents.
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
