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
- `mut` (follower → host): the follower's own action patches, same row shape.
  The host applies them bare (no pending entries) and its tee rebroadcasts.
  Only the ORIGIN window holds pending protection for a write; everyone else
  converges on the server echo. A stale feed push can briefly revert a peer's
  view of the write in the gap before the echo — the same window that exists
  today between windows, just shorter.

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
sync log from where the dead host stopped; followers therefore must not stamp
sync acks themselves (`stampSyncAck` no-ops as follower) or their own cursor
writes could run ahead of what they actually applied.

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
