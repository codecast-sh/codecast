# Sync host: one window syncs, the rest replicate

## Problem

Every window (main, detached tabs, palette, people, the prewarmed spare) runs a
full copy of the sync layer: the same ~25 workspace-wide subscriptions, the
same heartbeat churn, its own IndexedDB write-through. N windows pay N times
for one workspace of data, and a change made in one window reaches the others
only after a server round trip.

## Design

Exactly one window per origin is the **sync host**. Every other window is a
**follower**. Both run the same store, the same components, the same actions.

The host:
- mounts the global feeders (`useSyncCore` and the other always-on feeder
  hooks), exactly as every window did before;
- owns IndexedDB write-through and the storage watchdog;
- broadcasts every change to replicated keys over a `BroadcastChannel`.

A follower:
- skips every global feeder (gated at `useQueryNoThrow` via `REGISTERED_FEEDS`
  plus the replication classification — see below);
- does not wire `_setIDBWrite` (the host is the single state writer);
- applies the host's broadcasts through `syncTable`, so its own pending
  protection and no-op bails behave exactly as if the rows came from Convex;
- keeps its own Convex client, dispatch, and outbox: writes go to the server
  directly, and per-view queries (a conversation's messages, a doc body)
  subscribe as before.

The engine (`@platform/engine`) gains only pure pieces: the message protocol
and the patch-to-row extraction. Election, transport, and wiring are web-side.
Mobile, SSR, and tests have no `BroadcastChannel`/locks and resolve to host
in-process — their code path is unchanged.

## Why the tee is cheap

`mutativeMiddleware` computes a patch list for every store write — actions and
sync() alike — and hands it to the IDB write-through binding. The host wraps
that binding: persist, then extract the patches touching replicated keys into
row-level updates (`{key, upserts, removes}` for collections, `{key, value}`
for singletons, read from post-write state) and broadcast them. No middleware
changes; raw `setState` writes bypass the tee, and that is correct — they are
ephemeral by house rule.

## What replicates

The classification lives in `clientSyncRegistry.ts` as a per-entry
`replication` field with a derived default:

- **replicated** — server-backed keys: everything with `feeds`, a
  `dispatchTable`/`dispatchFieldTable`, or a `sync` entry, plus explicitly
  marked server-fed keys without registered feeds (`currentUser`, `teams`, …).
- **local** — per-window state that only rides IDB for boot: `pending`,
  `drafts`, `sidePanelSessionId`, and similar. `pending` must never replicate:
  it is the record of THIS window's unacknowledged writes.

Everything not in the registry (component state, `messages`, view pointers) was
never shared and stays per-window. A snapshot guard test pins the
classification so a new key is classified consciously.

## Protocol

All messages carry `{hostId, seq}`. Followers track `lastSeq`; a gap or a new
`hostId` triggers a fresh snapshot request. Messages:

- `hello` (follower → host): request a snapshot.
- `snapshot` (host → follower): `{seq, entries: {key: value}}` for every
  replicated key. Applied through the same row path as live updates; identical
  rows no-op via the engine's identity-reuse bails.
- `update` (host → all): the teed row updates.
- `mut` (follower → host): the follower's own action writes. A row the action
  EDITED ships as exactly the fields it wrote (`fields`, from the action's
  patches, with the action time); a row it created or replaced ships whole.
  The host lands the fields on its own copy under the same field locks the
  follower holds (`applyReplicatedFields`) and its tee rebroadcasts; a whole
  row merges through `syncTable` with every lock the host already held on it
  carried across the merge (`protectReplicatedWrite`), because the row's
  value echo would otherwise retire the gesture bridge's lock a moment after
  it was planted. So the origin window and its host both hold protection for
  the write, and a stale feed push on the host cannot revert it before the
  server echo. A whole-row overlay of a follower's copy would put the host's
  fresher fields back a step (the follower's copy is a replication hop
  behind), which is why edits ship as fields.
- `ack` (gesture bridge, origin → siblings): the sync-log positions the
  origin's dispatch landed at, with the dispatched patches. Sibling windows
  stamp the same acknowledgement onto their mirrored locks, and the mirrored
  lock retires at the same position the origin's does — a later remote write
  (a restore right after a kill) must not wait for a value echo that never
  comes.
- `sessionsProjection` rides `update` as a whole value (REPLICATED_EPHEMERAL_KEYS):
  only the host subscribes to the liveness overlay, and a follower without the
  slot buckets rows by the client-only sweep and disagrees with its host. The
  follower re-stamps the slot's receipt clock on arrival (`performance.now()`
  is per window).

Follower boot: hydrate from IDB read-only, subscribe and buffer, `hello`,
apply snapshot, replay buffered updates past the snapshot seq.

## Election

`navigator.locks.request("codecast-sync-host")` — first holder is host,
release on window death promotes the next in line. Web Locks and
BroadcastChannel are both per-origin and shared across Electron windows of one
session partition, so desktop and multi-tab web use the same mechanism.
Windows that do not mount the full shell (palette, people) never request the
lock; they are followers only. Where the Locks API is missing (React Native,
SSR, old engines) the window is host with no transport — today's behavior.

Promotion (a follower wins the lock): flip `syncRole` to host in the store —
the feeder gate is reactive, so subscriptions mount; wire `_setIDBWrite` and
the storage-health callback; start serving snapshots. `syncMeta` (the change
feed cursors) replicates from the host, so a promoted follower resumes the
sync log from where the dead host stopped. Followers never stamp a CURSOR of
their own (it would run ahead of what they applied), but they do stamp their
own write acknowledgements onto their locks: the host tees in commit order and
stamps the cursor after a page's rows, so when the replicated cursor reaches a
position the rows through it have already landed, and the follower retires its
acked locks at that moment (`retireAckedPending` on the replicated `syncMeta`).

## Writes

Unchanged. Actions run locally (synchronous returns, optimistic drafts,
pending protection), dispatch goes straight from each window to
`api.dispatch.dispatch`, parked writes ride the shared Dexie outbox exactly as
today. The only new write behavior is the `mut` broadcast, which is how a
follower's optimistic write appears in other windows before the echo.

## Invariants

1. One host per origin at a time; every window is exactly one of host/follower.
2. A follower never runs a registered global feeder and never writes state
   tables to IDB (outbox excluded).
3. `pending` never crosses the wire.
4. Replicated updates enter a follower only through `syncTable`/row apply, so
   local pending protection always wins until the value echoes.
5. The classification snapshot test fails on any unclassified registry key.
