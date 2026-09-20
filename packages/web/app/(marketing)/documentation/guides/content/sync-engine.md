The codecast web and desktop client shows a busy workspace: hundreds of agent sessions that send a heartbeat about once a second, plus tasks, docs and plans that many people and agents edit at once. The backend is Convex, a hosted database whose clients subscribe to queries. Convex has one way to keep a subscription fresh: it runs the query again and pushes the complete result. That is pleasant to program against, and it becomes expensive when the result is a long list and one field of one row changes every second.

Three ideas shipped in August and September 2026 to fix that cost. First, every surface paints from a local store, and a live query only feeds that store. Second, an append only log on the server tells each client exactly what changed, in order, so long lists do not travel again after every write. Third, when a person has several windows open, one window does the syncing and the others copy it.

This article explains each idea, with the real identifiers from the code, for engineers who build similar apps.

## Rule one: every surface paints from the local store

A component never renders the result of a live query. A hook subscribes to the query and hands each push to one store function, `syncTable`. The component reads the store. The store is persisted to IndexedDB, the database built into the browser, so a populated cache is the normal first paint. A skeleton is honest only when the cache is cold (`!ready && rows.length === 0`).

```ts
// Feeder: mounted once, renders nothing.
useSyncCollection("agentTasks", api.agentTasks.webList, args);

// Reader: subscribes to a signature of the fields it draws.
const rows = useCollectionRows("agentTasks", { where, sig, sort });
```

One entry in `store/clientSyncRegistry.ts` registers a synced collection. The entry names how the rows persist, when they hydrate at boot, whether a payload is a delta or a complete set, the disk indexes, and `feeds`, the list of queries that feed the key. The IndexedDB schema, the sync defaults and the typed store slot all derive from that entry.

Registering a feed is a promise that a test enforces. `registeredFeeds.guard.test.ts` reads the source of every file under `app/` and `components/` and fails any file that subscribes to a registered feed query directly. The fix is always to read the store, never to widen the allowlist. The registry and this guard shipped on 2026-08-17 (`f122d00e5`).

### Writes are drafts, and locks hold them

A user write never waits for the server. An `action()` edits a draft of the store, the screen shows the result in the same tick, and the patches ride a dispatch call to the real Convex mutation. The write is also recorded in an outbox table in IndexedDB, so a reload or a lost connection does not lose it.

The risk is a stale push. A query result computed before the mutation landed can arrive after the local write and put the old value back. The store prevents this with a pending lock for each written field. The middleware derives the locks from the draft's patch list, so no action writes them by hand:

```ts
pending["tasks:<id>:status"] = { type: "field", value: "done", ts }
pending["tasks:<id>"]        = { type: "exclude", ts }   // a local delete
```

While a lock exists, `syncTable` keeps the local value for that field and accepts every other field from the server. The lock retires when the server sends back the same value. A second rule, described below, retires it when the sync log passes the position of the write.

Derived fields are the known trap. A server row can carry `assignee_info`, an object joined from `assignee`. If the store locked that object, the lock would never retire, because the comparison is `===` and the server builds a new object each time. So the client derives such fields at render from the raw field and the team list it already holds (`lib/liveEntities`).

## Keep the fast fields off the big rows

Heartbeats were the first cost. The inbox list query, `listInboxSessions`, returns a fully enriched row for each session. Any field change on any row changes the result, and Convex then pushes the whole list again.

The fix is a second, small query. `sessionsLiveness` returns a map from conversation id to only the fields that heartbeats move, and the client merges that map onto the rows in the store. The base query is called with `include_liveness: false`, which sets those fields to null on the server, so a heartbeat no longer changes the large result.

On 2026-08-28 (`836605f0c`) two more fields moved to the overlay: `message_count` and `updated_at`. Both changed on every streamed token, so one streaming session caused a new push of a list that measured about 1.7 MB for each token. A client opts in with `fast_fields_in_overlay: true`. The argument is optional, so older clients keep working.

The same idea applies inside the browser. The store uses immutable drafts, so a change to one field of one row produces a new object for the row and for the whole collection. A sidebar subscribed to `s => s.sessions` rendered again on every heartbeat, and it was measured at about 70 percent of the main thread while idle. The fix is a wake signature (`store/wakeSig.ts`): a short string built from only the fields the component branches on.

```ts
export const sessionsWakeSig = makeCollectionSig<InboxSession>(sessionStructuralSig);
```

`makeCollectionSig` memoizes by collection reference, so unrelated store writes cost nothing. `rowSigExcluding(row, deny)` does the same for one row with a list of fields to ignore. A signature tracks field changes only. Anything driven by time, such as a relative clock, pairs the signature with a coarse ticker (`useCoarseNow`).

## The sync log

The overlay handles heartbeats. Real edits had the same problem on every list: one task edit sent the whole task window to every open client. The sync log replaces that. The server half shipped on 2026-08-21 (`3bea3d68a`) and the client applier the same day (`bb8668612`).

### Scopes and positions

A scope is one reader group: `user:<userId>` or `team:<teamId>`. Two tables hold the log.

```
sync_heads:   { scope_key, position, floor }
sync_actions: { scope_key, position, entity_type, entity_id, op, ts,
                patch, unset, full, partial, omitted,
                access_owner, access_key, access_grants }
```

Every tracked write to conversations, tasks, docs, plans or projects reads the head row of the scope, takes `position = head + 1`, and writes the action in the same Convex mutation transaction as the data. Convex mutations are serializable. So positions in a scope rise strictly in commit order, and a reader that has seen head H has seen every action at or below H. That is the whole ordering proof. `ts` exists for retention and is never an ordering key.

Two rules keep the table small. An entity has at most one active row in a scope: a new write moves that row to the new head. And a patch that touches only fields in `CHURN_ONLY_FIELDS` (`last_heartbeat`, `message_count`, `updated_at` and similar) emits no action. Without that rule every streaming session of a user would contend on one head row.

### Reading, cursors and acks

The client holds one live subscription, `getHeads`, which returns `{ position, floor }` for each scope the caller holds. The payload is a few integers, and it changes only on a tracked write. When a head moves, the applier waits 1500 ms to collect a burst, then reads `getRange { scope_key, from, limit, cargo }` as one shot queries, up to 500 actions or 1 MB for each page. It applies the page through the store's sync actions and then advances the cursor, which is stored in `syncMeta` under `synclog:v1:<scope_key>`.

Positions also acknowledge writes. `dispatch` takes an optional `ack_positions` flag and then returns `{ __syncAckV1, result }` with the positions its transaction created. The store stamps those positions on the pending locks that still protect the dispatched value. When the scope cursor reaches a stamped position, the lock retires. The value comparison stays as a permanent second rule, because writes that the server defers to a scheduled function produce no ack.

### Cargo and the access stamp

Since 2026-09-01 (`4c96cd3ff`) each action carries the change as cargo: a merge patch of top level fields, a list of removed fields in `unset`, and `full: true` when the patch is the whole document. Applying a patch is field assignment, so applying it twice is harmless. That matters because a moved row merges the cargo of every write since it last moved (`mergeCargo`), and a reader can see the same row twice. Cargo is capped at 16 KB. A larger one becomes `partial`, the client fetches the row by id, and the next write rebuilds a full cargo from the document.

Carrying row contents in a shared log raises a question: who may read each row? The answer is one stamp, built in `lib/access.ts` from the document after the write.

```ts
type AccessStamp = { access_owner?: string; access_key?: string; access_grants?: string[] };
// owner = user_id, key = the row's workspace ("team:<id>" or "user:<id>"), grants = a task's assignee
```

The stamp decides two things. Fan out: an action lands in the owner's user scope, in the team scope when the key names a team, and in the user scope of each grant. A task that is private inside a team has the key `user:<owner>`, so it never enters the team scope at all. Projection: `getRange` evaluates `authorizedFor(stamp, viewer, heldKeys)` for each row and each caller.

| The caller | What `getRange` returns |
|------------|-------------------------|
| Is the owner, holds a grant, or holds the key | The action with its cargo |
| Reads a row that has no stamp | The action without cargo; the client fetches by id |
| Is not authorized | A bare `delete` |

The direct queries use the same rule. `canAccessTask`, `canAccessDoc`, `canAccessPlan` and `canAccessProject` are defined as evaluating that stamp, and a property test pins the pure evaluator to the one that reads memberships. The log and the fetch by id therefore cannot disagree. A log `delete` alone never removes a row on the client: the client asks the authorized query, and removes only ids that the query omits.

### Retention, and the client that is far behind

A cron job deletes, for each scope, the prefix of actions older than 30 days and moves `floor` to the last deleted position. If a client returns with a cursor below the floor, the log can no longer prove the gap, and `getRange` answers `resync: true`.

The client then drops the cursor and every crawl watermark that belongs to the scope, stamps a new cursor at the current head, and bumps `syncLogFloorEpoch`. Two things follow. The list queries run once more as snapshot floors (`useBootstrapCollection`). And for tasks and docs, the next crawl pages through every row of the workspace with one shot queries. Both paths only add rows, so a crawl that stops early cannot empty the cache. In normal operation that crawl runs once in 24 hours as a safety net. It reports the number of rows it healed, zeros included, and two weeks of zeros in production is the stated condition for removing it.

Since 2026-08-30 (`0b8dd169e`) the header sync indicator reads the log's real distance. Before each replay, the applier stores `head.position - cursor` for each scope in `syncLogLag`, and the indicator shows a catch up while some scope has a lag above zero. Its only other busy state is a first load into a collection with no cached rows. A cold scope stamps at the head and is never behind. A catch up that lasts past 20 seconds turns amber.

On 2026-09-01 (`c9bbee4b9`) the live list subscriptions for tasks, docs, plans and projects became one shot floors. A measurement on 2026-09-02, over 60 seconds with several agent sessions writing, found that those four list queries no longer appeared on the socket at all, while `getRange` carried 29 KB in 24 calls. The sessions surface remained: `listInboxSessions` sent 29.8 MB in 17 pushes and `sessionsLiveness` 10.5 MB in 50 pushes, 97 percent of all bytes. The inbox window is deliberately not retired yet, and that number is why it is the next target.

## One window syncs, the rest replicate

The desktop app opens many windows of one origin: the main window, detached tabs, the command palette, a people window and a spare window that is warmed in advance. Each one ran the full sync layer, so N windows held the same 25 or so workspace subscriptions and each wrote the same rows to the same IndexedDB cache. A change made in one window reached the others only after a server round trip. Since 2026-09-01 (`7b05b7e54`) exactly one window per origin is the sync host, and the others are followers.

Election uses Web Locks, the browser API that grants a named lock to one holder per origin. Each window that mounts the full shell requests `codecast-sync-host`, and the holder is the host. The host mounts the global feeders and owns the IndexedDB writes. The store middleware already computes a patch list for every write and hands it to the persistence binding. The host wraps that binding: it persists first, then converts the patches into row updates and posts them on a BroadcastChannel, the browser API that delivers messages between windows of one origin.

A follower skips every global feeder (they mount inside `HostFeeders`, or gate on `useIsSyncHost()`). It asks the host for a snapshot, which arrives in batches of at most 256 rows, and then applies the stream. Every message carries `{ hostId, seq }`, and a gap or a new host id triggers a fresh snapshot. Replicated rows enter through `syncTable`, the same path a Convex push takes, so the follower's own pending locks still win.

Writes do not change. Each window dispatches its own mutations to the server. A follower also offers each optimistic write to the host as a `mut` message, and that is how the write appears in sibling windows before the server echo. An edited row ships as only the fields the action wrote. The follower's copy of the other fields is one hop behind the host's, so a whole row would move the host's fresher values back a step. The host applies the fields under the same locks the follower holds.

Every registry key is classified in `REPLICATION_CLASSIFICATION`, a `Record` over all keys, so a new key without a class is a compile error.

| Class | Examples | Why |
|-------|----------|-----|
| `shared` | `sessions`, `tasks`, `docs`, `chatMessages`, `syncMeta` | Server data, the same in every window |
| `local` | `pending`, `drafts`, `feedCursors`, `tabs`, `activeTabId`, `sidePanelSessionId` | One window's unacknowledged writes, paging and arrangement |

`pending` must never cross the channel, because it is the record of this window's own writes. View state, such as the messages of the open conversation, was never shared and stays in its window. Queries for one view still run in every window.

When the host window closes or crashes, the browser releases the lock and the next window in line becomes host. Its feeder gate is reactive, so the subscriptions mount, and it takes over persistence. The log cursors in `syncMeta` replicate, so the new host resumes the sync log where the old one stopped. Roles favor safety. Every window boots as a host and becomes a follower only when a snapshot from a living host arrives. A follower that has no synced stream for 8 seconds acts as its own host until a host answers. Where Web Locks or BroadcastChannel do not exist, as in the mobile app and in tests, the window is a host with no transport.

## What to take from this

Keep the subscribed value small and move data through one shot reads. Give the log an order that the database proves, not a clock. Derive who receives a change and who may read it from one function. And make every path into the store the same path, so that a push, a log page and a message from a sibling window all meet the same locks.
