# Phase 2 spec: multiplayer simulation harness (ct-55688, plan pl-810)

This spec can be followed cold. It builds on Design 2 (operator view), which scored highest. It takes per-window store isolation, the oracles and the server-helper placement from Design 1, and the minimal extraction set and deferred deployment tier from Design 0. It avoids every fatal flaw the judges named. Line numbers refer to the working tree on 2026-09-30.

## 1. Goal and definition of done

The simulator runs several people (principals), each with several browser windows, against the **real Convex handlers** and the **real client sync code** in one bun process. It checks convergence and access invariants after every scenario and prints failures a person can read.

Phase 2 is done when all of the following hold:

1. **One command runs everything.** `bun run sim` (in `packages/web`) runs 11 red-list scenarios plus the harness self-tests.
   - A scenario either passes, or is marked `test.failing` with a task id and fails on a named invariant.
   - No scenario fails on a harness error.
2. **The legacy suites run on the new substrate.** `inboxConvergenceSim.test.ts` and `inboxMultiWindowSim.test.ts` use their pinned seeds (21-32 and 81-92). Every seed whose outcome changed is written down with its reason.
3. **Nothing in the harness is invented.** No inline hide rule, no fake sync log, no hand-written `REPLICA_KEYS`. There is one store instance per window.
4. **The harness is typechecked.** `cast check sim`, `cast check web` and `cast check convex` are green.
5. **It fits CI.** It runs inside the existing `test-web` job within the budget in section 3.10.

## 2. Decisions taken

| Question | Decision | Why |
|---|---|---|
| Window isolation | **One store instance per window.** Export the existing `createInboxStore` (inboxStore.ts:12775) as a test seam. The harness points the `useInboxStore` facade's `getState/setState/subscribe/getInitialState` at the active window's instance while that window runs. No AsyncLocalStorage, and no production-wide `windowLocal` refactor. | The engine middleware keeps `dispatchBinding`, `dispatchEpoch`, `inFlightOutboxIds`, `retiredOutboxIds`, the tees and the outbox functions in a closure per instance (platform/packages/engine/src/middleware.ts:597-630). Swapping state into one instance cannot separate them. I checked that no production module captures `useInboxStore.getState` into a variable, so a facade swap routes every caller. |
| Other module singletons | Keep a harness-side **window slot registry** (`sim/windowSlots.ts`) that classifies each top-level mutable as `window` (saved and restored per window), `memo` (reset on every switch), `transient` (must be idle at a switch) or `shared` (with a reason). Production files gain only a small `__simSlots()` get/set export where no seam exists. A guard test fails on any unclassified top-level `let`/`Map`/`Set` reachable from the sim. | Fixes the `_heldOverlayFacts` leak (inboxStore.ts:2424) and every singleton like it. It does not rewrite hot paths, and the guard stops the list from drifting the way `REPLICA_KEYS` did. |
| Server substrate | The fake db (`testDb.ts`, with additive options) plus `fn._handler`, driven by a router in `packages/convex/convex/simBackend.testing.ts`. convex-test is not used as the substrate. | Real sync-log interceptor, pinned ids, chosen `_id`s. Names with two dots are skipped by the Convex bundler (bundler/index.js:367, verified), and the file stays in `cast check convex`. |
| Server fidelity added in Phase 2 | 32-char ids, `_creationTime`, `patch(undefined)` removes the field, a rollback journal, single-flight top-level calls, arg validation against `fn.exportArgs()`, and a `convexToJson` wire boundary. | Cheap, and each one closes a named gap. |
| Server fidelity deferred | Return validation, schema and document validation, index-prefix enforcement, and automatic cron firing. Crons run only as explicit calls. | Each is likely to produce a batch of triage findings. Phase 3. |
| Team slot | Feed `teamInboxIds` through the existing `applyTeamInboxIds` (useSyncTeamInboxSessions.ts:18) and an extracted liveness applier. The invariant is membership equality. | Matches production. The judges flagged a new `applyTeamInboxPayload` as a duplicate. |
| Legacy suites | Move them to the real dispatch and hide path in this phase, as the last unit. | They assert convergence, not snapshots. Reap-driven changes are findings. |
| Test layout | **One bun test file** (`sim/sim.test.ts`) loads `sim/selftests/*.selftest.ts` and `sim/scenarios/*.scenario.ts` with `Bun.Glob`. Cheap pure tests (net, report) are ordinary test files. | The store and convex import costs about 7s under `--isolate`. One scenario per test file would pay it 11 times. Globbing keeps the scenario units on disjoint files, since nobody edits an index. |
| DSL | Imperative async. Verbs enqueue deliveries on named channels. Scripted mode drains after each verb. Interleave and order modes drain at `settle()` or at the first `expect`. | The same file runs in every mode, with no recorded-script runtime to build. |
| Network model | Per-channel FIFO. Interleave permutes only across channels. A request and its response are two events. A mutation response refreshes that window's live feeds before its promise resolves (read-your-writes). Plus offline/online and `dropResponse`. | These are the orderings production can produce. |
| Randomness | `Math.random` and `crypto.randomUUID` are spied. They draw from the **active window's** stream, else the running server call's stream, else the world stream. Each stream is `makeRng(hash(seed, name))`. | Interleaving one window does not perturb another window's randomness. |
| Seeds | Scenario seeds are `hash(scenarioName) + i`. Legacy seeds are unchanged. | Adding a scenario never shifts another scenario's seeds. |
| Budgets | Hard failures come from delivery and write counts per scenario. Wall time is only reported. | This machine's load average (around 370) makes wall time flaky. |
| Disposable Convex deployment | **Documented recipe only**, in `sync-sim.md`. No script. | No red-list assertion needs it. The OCC half of two-humans-one-role is noted as uncovered. |
| CI | Stay inside `test-web`. No new job, and no reliance on bun `--shard`/`--parallel`. Add `SIM_OUT` plus an artifact upload on failure. | `test.failing` exists in bun 1.3.13 types (verified in `bun-types@1.3.13/test.d.ts:505`). `--shard` is verified only on 1.3.14. |
| Red scenarios | Each failing scenario gets its own task under pl-810, referenced in `red:`. | Fixing the bug flips the test red, which forces the marker's removal. |

## 3. Architecture

### 3.1 Layers

```
scenario files (dsl verbs)                    sim/scenarios/*.scenario.ts
  -> actors (humans, daemon, agents, admin)   sim/actors.ts
  -> world (genesis, principals, devices)     sim/world.ts + shared teamWorldGen
  -> windows (store instance, feeders,        sim/window.ts, sim/device.ts
     catchUp, floor, dispatch, replication)
  -> net (channels, scheduler, budgets)       sim/net.ts
  -> realm (clock, timers, rng, facade,       sim/realm.ts, sim/windowSlots.ts
     window slots)
  -> server router (auth, single flight,      convex/simBackend.testing.ts
     journal, scheduler, memo, validation)    convex/simValidate.testing.ts
  -> real Convex handlers over fake db        convex/*.ts, convex/testDb.ts
invariants + reports + labels                 sim/invariants.ts, report.ts, labels.ts
```

### 3.2 Server: `packages/convex/convex/simBackend.testing.ts`

This file must not import `bun:test`, because `cast check convex` has no bun types.

```ts
export type Principal =
  | { kind: "user"; userId: string }                     // identity subject `${userId}|session`
  | { kind: "token"; userId: string; token: string }      // api_tokens row seeded with hashToken
  | { kind: "system" };                                  // scheduled jobs, crons: null identity
export interface ScheduledJob { id: string; due: number; name: string; args: unknown; }
export interface CallRecord { seq: number; principal: Principal; name: string; kind: "query"|"mutation"|"action"; ok: boolean; error?: string; writes: number; }
export interface SimBackendOptions {
  tables: Record<string, any[]>;
  now: () => number;
  rngFor: (callSeq: number) => () => number;             // per-call seeded stream
  mintId: (table: string, n: number) => string;          // 32-char [a-z0-9]
  onSchedule?: (job: ScheduledJob) => void;               // world turns jobs into `sched` deliveries
  onInsert?: (table: string, id: string) => void;         // labels
  memoFunctions?: string[];                               // default: the four inbox reads
}
export interface SimClient {
  query(ref: any, args: any): Promise<any>;
  mutation(ref: any, args: any): Promise<any>;
  action(ref: any, args: any): Promise<any>;              // recorded, not executed
}
export function makeSimBackend(opts: SimBackendOptions): {
  db: any; clientFor(p: Principal): SimClient;
  runInternal(name: string, args: unknown, p?: Principal): Promise<any>;   // internal fns, crons, sweep
  runScheduled(job: ScheduledJob): Promise<void>;
  cancelScheduled(id: string): void;
  writes(): number; calls: CallRecord[]; actions: { name: string; args: unknown }[];
};
```

**Routing**
- `getFunctionName(ref)` returns `"module:export"`. The module is resolved through a literal lazy map, `const MODULES = { syncLog: () => import("./syncLog"), ... }`.
- The map starts with: syncLog, conversations, dispatch, tasks, docs, plans, projects, chat, pendingMessages, agentTasks, teams, anchors, managedSessions, orgRoles, teamScopeSweep, syncLogPrune and cleanup.
- Lazy imports avoid import-cycle TDZ and load only the modules a run uses. The file is never bundled, so the Convex dynamic-import restriction does not apply.
- An unknown name throws: `sim client: no handler for "chat:sendMesage"; did you mean chat:sendMessage? Add the module to MODULES in convex/simBackend.testing.ts`. The suggestion is the closest name by edit distance.
- Kind and visibility are enforced from `isQuery/isMutation/isAction/isPublic/isInternal`. `clientFor` reaches public functions only. `runInternal` reaches internal ones.

**Validation and the wire boundary**
- `simValidate.testing.ts` walks the JSON validator from `fn.exportArgs()` (registration_impl.js:102/127). It covers object, optional, string, float64, int64, boolean, null, id, literal, union, array, record, any and bytes.
- It rejects arguments with the same message shape prod uses: `ArgumentValidationError: ...`.
- Arguments and results cross `convexToJson`/`jsonToConvex`, so no client object aliases a server row.

**ctx is a Proxy** over `{ db, auth, scheduler, runQuery, runMutation, runAction, storage }`.
- Touching any other field throws `sim ctx: <fn> read ctx.<field>, which the sim does not provide. Add it in makeCtx.`
- `auth.getUserIdentity` returns `{ subject: userId + "|session" }` for a user principal, and null for token and system principals. Token principals pass `api_token` in args, as the CLI does.
- `runQuery`/`runMutation` re-enter the router inline under the same principal. They are not queued. Each nested mutation gets its own `withChangeLog` wrap via its own `_handler`. The journal is shared with the top-level call.
- `storage` is a stub whose methods throw with the named error.
- `global fetch` is replaced with a throwing stub for the life of the backend.

**Single flight and journal**
- Top-level calls go through a promise chain, one at a time.
- A second top-level call entering while one runs throws `sim server: X started while Y was running` in debug mode. Otherwise it simply waits its turn in the chain.
- Each top-level mutation runs `db.__beginJournal()`. A throw leads to `db.__rollback()`, which undoes inserts, patches, replaces and deletes in reverse, including `sync_actions` rows. The error then propagates to the client.

**Scheduler**
- `runAfter(ms)` and `runAt(ts)` create a `ScheduledJob` with `due = now() + ms`.
- The job goes to `onSchedule`. The world turns it into a `sched` delivery that runs `runScheduled` under the system principal.
- `cancel` removes it. Scheduled actions are recorded only.

**Memo**
- Only `conversations:listInboxSessions`, `conversations:sessionsLiveness`, `conversations:listTeamInboxSessions` and `conversations:teamSessionsLiveness` are memoized.
- The key is (principal, name, JSON args, `writes()`, `inboxEpoch(now())`).
- Every miss calls `_resetChildAuqProbeCacheForTests()` first.

**Random and time**
- `Date.now` is frozen for the duration of a call, which is already true under the virtual clock.
- `Math.random` inside a call draws from `rngFor(callSeq)`. This works through the realm's routing (section 3.3).

**`testDb.ts` changes** are all opt-in, through a second argument `makeFakeDb(tables, opts?)`:
- `mintId(table, n)`;
- `creationTime: () => number`, a monotonic `_creationTime` stamp on insert when absent;
- `strictPatch: true`, so a patch value of `undefined` deletes the field;
- `__writeCount`, incremented on insert, patch, replace and delete;
- `__beginJournal/__commit/__rollback`;
- an id-to-table map so `get` is O(1) when `mintId` is set.

With no options, behaviour is byte-identical for the existing tests.

### 3.3 Realm and windows

**`sim/realm.ts`** owns the process-wide spies, installed by `installRealm(seed)` and removed by `uninstallRealm()`:

- **Clock.** The existing virtual clock moves here (`now`, `mono`, `advance`, `T0` stay exported from the legacy harness for compatibility). It covers `Date.now` and `performance.now`.
- **Random.** `Math.random` and `crypto.randomUUID` are spied. UUIDs are formatted as v4 from rng hex. Routing uses the active window, then the active server call, then the world stream.
- **Timer shim.** `setTimeout/clearTimeout/setInterval/clearInterval` are shimmed.
  - A timer records its owner: the active window, or `global`.
  - Delay 0 enqueues a `timer:<owner>` delivery.
  - A positive delay is armed at `now + delay` and enqueued when the clock reaches it.
  - `setImmediate` and `queueMicrotask` stay real.
- **Store facade.** `bindStoreFacade(inst | null)` rebinds `useInboxStore.getState/setState/subscribe/getInitialState` to `inst`'s api, or back to the saved base api.
- **Active window.** `activeWindow()` returns it, and `runInWindow(w, fn)` does this:
  1. `assertTransientIdle()`;
  2. restore `w`'s slots;
  3. `bindStoreFacade(w.store)`;
  4. `await fn()`;
  5. yield with `setImmediate` until the microtask queue settles (bounded loop);
  6. save `w`'s slots;
  7. reset the memo slots;
  8. unbind.

**`sim/windowSlots.ts`** is the registry:

```ts
export type SlotClass = "window" | "memo" | "transient" | { shared: string };
export const WINDOW_SLOTS: Record<string /* "store/inboxStore.ts:_heldOverlayFacts" */, SlotClass> = { ... };
export function saveSlots(): SlotSnapshot; export function restoreSlots(s: SlotSnapshot): void;
export function resetMemos(): void; export function assertTransientIdle(): void;
```

Initial classification, from a grep of the reachable store and hook files:

| Class | Bindings |
|---|---|
| `window` | `_heldOverlayFacts`, `recentlyRequestedPendingMessages`, `resolvedSessionPreparations`, `recentThawTimer`, `_userMsgsProbed`, `hydrationEpoch` (inboxStore.ts); `sourceToken` (gestureBridge.ts); `states` (reconcileCrawl.ts); `done` (useBootstrapCollection.ts); `cargoSupported`, `applyTally`, `flushTimer`, `shadowApplied` (useSyncChangeFeed.ts); `_lastApplyMono`/`_applySeq` (syncActivity.ts, through the existing `__setSyncActivityForTests`); `pendingSource`, `appliedNavCount` (viewNav.ts) |
| `memo` | `_membershipKey/_membershipVal`, `_visibleKey/_visibleVal`, `_pendingSendSig*`, `_placementDeadlineMemo`, `_placedMemo`, `_lastParityCheckAt` (through `__resetInboxPlacementCacheForTests` plus the new slot seam) |
| `transient` | `depth`, `deferred`, `deferredFanOut`, `timer` (syncTransaction.ts) |
| `shared` | every `WeakMap` (keyed by per-instance objects, so it cannot cross windows); `channelFactory` (set once by the sim); `running` (syncReplication.ts; the sim never calls `startSyncReplication`); `_depChanges` (dev census) |

**`sim/windowSlots.guard.test.ts`** is static and imports no store.
- It uses `buildBootGraph` (packages/cli/src/bench/bootGraph.ts) from the sim roots with an `@/` alias resolver, restricted to `packages/web/{store,hooks,lib}`.
- It extracts top-level `let`/`var` and `const X = new Map|Set` bindings per file.
- It fails on any binding missing from `WINDOW_SLOTS`, and prints the classification line to add. This follows the frozen-baseline style of `nativeDeps.guard.test.ts`.

**`sim/window.ts`** defines `class SimWindow`:

```ts
constructor(world, principal: { userId: string }, device: SimDevice, role: "host"|"follower", name: string)
store = __createInboxStoreForTests()      // own engine closure
client: SimClient                         // world.backend.clientFor({kind:"user", userId}) wrapped by net (conn channel)
run<T>(fn): Promise<T>                    // realm.runInWindow(this, fn)
boot(opts: { scope?: "mine" | { team: string } }): Promise<void>
```

`boot` sets `currentUser` and `clientState.ui` (`inbox_scope`, `active_team_id`). It then wires:

- **Dispatch.** `_setDispatch(makeDispatchBinding(args => client.mutation(api.dispatch.dispatch, args), ...))`, using the U3 extraction, plus `_setDispatchError(applyDispatchFailure)`.
- **Outbox.** `_setOutbox` backed by an in-memory Map per window.
- **Host tee.** `_setIDBWrite` feeds the replication host tee.
- **Follower tee.** `_setActionTee` feeds the follower mut tee.

Host windows then mount the feeders:

- `LIST_INBOX_SESSIONS_ARGS` base list, applied with `applyLiveInboxIds`;
- the liveness overlay, applied with `applyInboxLivenessPayload("mine", ...)`;
- in team scope, `listTeamInboxSessions` with `applyTeamInboxIds` and `teamSessionsLiveness` with the extracted `applyTeamLivenessPayload`;
- any registered feed a scenario opts into, through the extracted `applyCollectionFeed`;
- the chat page through `ingestChatPage`.

Log catch-up is the real `catchUp(client)`. The floor is the extracted `runInboxFloorStep`, and `loadFloorOnce/floorScopeKeys`. The digest comparer is the real `createInboxDigestComparer`, with its IO bound to the client.

Followers mount no global feeders, matching production.

### 3.4 Network and scheduler: `sim/net.ts`

This module is pure and never imports the store.

```ts
export type Channel = string;  // "conn:<win>", "live:<win>:<feed>", "repl:<from>><to>", "bridge:<dev>:<from>",
                               // "timer:<owner>", "sched", "actor:<name>"
export interface Delivery { seq: number; channel: Channel; due: number; label: string; run: () => Promise<void>; producer: string; }
export class Net {
  constructor(opts: { rng: () => number; maxDeliveries: number; maxWrites: number; writes: () => number; now: () => number; advance: (ms: number) => void });
  mode: "scripted" | "interleave" | { order: Channel[] };
  enqueue(channel, d: Omit<Delivery,"seq">): void;
  markDirty(channel): void;          // live refresh: at most one pending per live channel
  step(): Promise<Delivery | null>;  // one delivery per mode rules
  drain(opts?: { horizonMs?: number }): Promise<void>;
  ring: Delivery[];                  // last 64, for reports
  orderSoFar(): Channel[];           // for the --order replay line
  producers(): Map<string, number>;
  offline(win): void; online(win): void; lag(channel): void; release(channel): void;
}
```

**Ordering rules**
- Channels are FIFO internally.
- `scripted` picks the lexicographically first ready channel.
- `interleave` picks a seeded choice among ready channels.
- `order` consumes the given channel list and throws a named error on a mismatch.
- A lagged channel is not ready until it is released.
- An offline window's `conn:` channel holds its events. `online()` fires `_drainOutbox` on that window.

**Requests and responses**
- A client call from window W becomes `req` then `res` on `conn:W`.
- `req` runs the handler on the server, which commits.
- `res` runs inside `W.run`. For a mutation it first applies a fresh recompute of every live feed of W at the current db version (read-your-writes), then resolves the promise.
- `dropResponse(W, n)` makes the next n mutation `res` events reject with a network error after the commit, so the engine outbox and the server receipts decide the outcome.

**Live pushes**
- After any delivery that raises `writes()`, the net marks every mounted live channel dirty.
- A dirty channel's delivery recomputes the query at delivery time, so intermediate versions may be skipped, as production allows.

**drain**
- It loops until no channel is ready.
- It then advances the clock to the next armed timer or scheduled job, up to `horizonMs`. The default is `2 * HIDDEN_OVERRIDE_SETTLE_MS`.
- It stops when nothing is due inside the horizon.
- It fails at `maxDeliveries` with `did not quiesce after N deliveries; top producers: ...`, or at `maxWrites`.

### 3.5 Devices: `sim/device.ts`

`class SimDevice` holds one host window and N follower windows for one principal.

- It uses the engine's `createReplicationHost`/`createReplicationFollower` over an in-memory hub. The engine's own test hub at `replicationRuntime.test.ts:19-47` is the reference.
- Each post becomes a `repl:<from>><to>` delivery that applies inside the receiver's `run` through `applyUpdatesToStore`.
- The host tee passes the shadow identity diff exactly as `replicationRuntime.ts:133-135` does.
- Followers join with `snapshotRequest`. Chunks arrive through the runtime's own `setTimeout(0)`, which now becomes `timer:` deliveries, so a live write can land between chunks.
- `helloRetryMs` keeps its production default.
- The gesture bridge uses `setGestureChannelFactory` once per realm. Posts become `bridge:<dev>:<from>` deliveries to sibling windows.
- `closeHost()` stops the host runtime and promotes the first follower through the runtime's own path.

### 3.6 World and actors

**`packages/shared/contracts/__fixtures__/teamWorldGen.ts`** is pure data with no convex imports.

```ts
export interface TeamWorldSpec { users: string[]; teams: { name: string; members: string[]; features?: TeamFeatures }[]; rowsPerUser: number; seed: number; epoch: number; }
export function genTeamWorld(spec): { users: WorldRow[]; teams: WorldRow[]; team_memberships: WorldRow[]; perUser: Record<string, GenWorld> }
export const userIdFor, teamIdFor, membershipIdFor;  // convexIdFor("user:<name>"), ("team:<name>"), ("member:<team>:<user>")
```

- It calls `genWorld(seed * 16 + userIndex, rowsPerUser, epoch, userIdFor(name))` per user, and `genWorld` itself is unchanged. `epoch` is the `inboxEpoch` minute the sessions are dated against. At most 16 users, so per-user seeds stay disjoint.
- User and team ids come from `convexIdFor("user:<name>")` and `convexIdFor("team:<name>")`. Two names that mint one id throw.
- A team's first listed member is its admin and the rest are members, as `teams.create` and `teams.join` write them. A user's first team becomes its `team_id` and `active_team_id`. Members join before the oldest generated session starts.
- `features` is the team row's flag object (`TeamFeatures` from `contracts/teamFeatures.ts`). Scenarios that use team chat need `chat: true`, and role scenarios need `org: true`.

**`sim/world.ts`** has three parts.

`class SimWorld` holds:
- `backend` (makeSimBackend with `mintId = (t, n) => convexIdFor(t + ":" + n)`);
- `net`, `labels` and `realm`;
- `team(name, opts)`, `user(name, teams)` and `device(user, { followers, scope })`;
- `settle()`, `interleave(n)` and `cron(name)`.

**Genesis**
1. Insert users, teams and memberships as rows. Team membership inserts go through `makeChangeTrackedDb`, so `scope_added` rows exist.
2. Insert the per-user conversations and messages as rows. Then patch each through the real `patchConversationVisibility`, which gives real `workspace` keys and access stamps.
3. Create tasks, docs and plans through their real create mutations.
4. Provision anchors and org roles through `provisionStandingAgent` via `runInternal` when that runs cleanly over the fake db. Otherwise use seeded rows with a comment naming the blocker. The org and chat flags go on the team row through the spec's `features`.
5. Seed `api_tokens` with `hashToken` from `@platform/auth/convex`.
6. The genesis gate: `runInternal("teamScopeSweep:sweepPage", { apply: false })` must return zero findings, and `writes()` must be unchanged by the sweep.

**`sim/actors.ts`**: each verb returns after enqueueing on `actor:<name>` and never drains.

| Actor | Verbs | Real path |
|---|---|---|
| human (window) | `kill`, `stash`, `restore`, `pin`, `revive`, `send`, `setPrivacy`, `chat(channel, text)`, `tellRole(role, text)` (chat `@role`) | store action, then `_dispatch`, then `dispatch:dispatch` with `ack_positions`. Chat goes through the store's chat send, which dispatches to `chat:sendMessage`. |
| daemon (per user) | `settles(s)`, `heartbeat`, `restart`, `claimPending`, `ack`, `resume(s)`, `claimTask` | the string names the CLI uses. The implementer copies them from `packages/cli/src/syncService.ts` and the daemon: `managedSessions:updateAgentStatus`, `managedSessions:heartbeat`, `pendingMessages:claimPendingMessageForDelivery`, `pendingMessages:updateMessageStatus`, `pendingMessages:ackInjectedMessages`, the resume mutation that calls `resumeConversationSession`, and `agentTasks:claimTask`/`getDueTasks` with a token principal |
| agent | `says(s, channel, text, mentions)` | `chat:sendMessage` with `origin: "agent"` |
| admin | `remove(team, user)` | `teams:removeMember` |
| clock | `advance(ms)` | `realm.advance` plus `net.drain` of what came due |

### 3.7 Invariants: `sim/invariants.ts`

The catalog is a list of `{ id, meaning, keys, when: (w) => boolean, check(world, principal, window) }`. They all run at every `settle()` and at the end of every scenario. The `always` ones also run after each delivery, for the window it touched.

| id | Rule | Oracle (real code) |
|---|---|---|
| `INV-fixpoint` | Re-running every mounted feeder, one `catchUp`, and `applyEntityIds` over every held id yields zero store patches outside `FIXPOINT_BOOKKEEPING` (`syncMeta`, `syncProgress`). Patches are measured through the window's `_setIDBWrite` tee. | the feeders themselves |
| `INV-sessions-mine` | The digest, tally and placement of the `mine` scope equal that principal's canonical projection. | `computeSessionsLiveness`, `projectInbox` (existing `canonicalProjection`) |
| `INV-followers` | `snapshotEntries` over `REPLICATED_STORE_KEYS` is byte-equal to the host's, for each follower. | engine `snapshotEntries` |
| `INV-team-inbox` | `teamInboxIds` equals the server team list for (viewer, team) minus that viewer's `inbox_hides`. | `conversations:listTeamInboxSessions` |
| `INV-workspace-rows` (always) | For tasks, docs, plans and projects: the rows `inWorkspace(key)` equal the server rows passing `authorizedFor(accessStampFor(row), u, heldKeysFor(u))`, compared on fields not in `PAYLOAD_DENYLIST`. Always-mode checks only the "no unreadable row" half. | `lib/accessKeys.ts` |
| `INV-sweep` | `teamScopeSweep:sweepPage({apply:false})` returns zero findings. | teamScopeSweep |
| `INV-cursors` | Each held scope's cursor equals its head. No cursor exists for an unheld scope. | `syncLog:getHeads` as u |
| `INV-pending-locks` | No acked lock survives, and none is older than `HIDDEN_OVERRIDE_SETTLE_MS`. | the store `pending` slot |
| `INV-outbox` | Each window's outbox is empty after settle. | engine outbox Map |
| `INV-triggers` | Replica equals `agentTasks:webList` as u. Each conversation's `armed_trigger_kind` equals `armedTriggerKindFor(liveTasks)`. | `dormancy.armedTriggerKindFor` |
| `INV-pending-sends` (always: uniqueness) | Every bubble is echoed, settled or failed. Each `client_id` appears at most once in `pending_messages`. | server rows |
| `INV-chat` (always: caps) | The replica page equals `chat:listMessages`. At most one wake exists per `chat-mention:<msg>:<target>`. `MENTION_WAKES_PER_SENDER_HOUR`/`PER_TARGET_HOUR` hold. | chat.ts constants |
| `INV-roles` | The wake counter equals the enqueued rows. `listAnchors` equals `visibleAnchorsForUser`. | anchors.ts |
| `INV-ping-pong` | Agent-to-agent enqueues per virtual hour stay under the caps. | `pending_messages` rows |

Two further rules:
- `pendingMessages`, `pending`, `queuedMessages` and `blockedReviveRequestedAt` are `local` keys. They are compared per window against the server, never host against follower.
- A **coverage guard** (a self-test) fails for any `REPLICATION_CLASSIFICATION` key that is neither covered (by a listed invariant or by `INV-fixpoint` through a mounted feeder) nor in `NOT_COMPARED` with a reason.

### 3.8 DSL and runner

**`sim/dsl.ts`**

```ts
export function scenario(
  opts: { name: string; red?: string; seeds?: number; modes?: ("scripted"|"interleave")[];
          budget?: { deliveries?: number; writes?: number }; runOn?: "in-process" },
  fn: (w: SimWorld) => Promise<void>,
): void
```

- It registers one `describe(name)` with one test per (mode, seed). The test is `test.failing` when `red` is set.
- Each test runs `installRealm(seed)`, a fresh `SimWorld`, `await fn(w)`, `await w.settle()` and the invariants, then `uninstallRealm()`.
- Defaults are scripted plus 2 interleave seeds in CI. `SIM_SWEEP=N` widens to N seeds and `SIM_SEEDS=a,b` pins them.
- Point checks available on `w`:
  - `w.expect(win).shows(label)` / `.hides(label)`;
  - `w.expect.server.row(label).has({...})` / `.gone(label)`;
  - `w.expect(user).cannotRead(label)`;
  - `w.expect(role).wokenTimes(n)`;
  - `w.inspect(label)`.
- Every point check settles first.
- A red scenario that passes fails with `red scenario "<name>" now passes; remove red: and close <task>`. This comes from bun's own `test.failing`, plus the message printed from the report hook.

**`sim/sim.test.ts`** is the only store-importing sim test file.
- It uses top-level `await` imports of `selftests/*.selftest.ts` and `scenarios/*.scenario.ts` via `Bun.Glob`, sorted.
- `SIM_SCENARIO=<substring>` filters which files it imports.
- `SIM_SELFTEST=0` skips the self-tests.

**`packages/web/scripts/sim.ts`** turns flags into env vars and spawns `bun test store/__tests__/sim/ --isolate`:
- `bun run sim [filter]`
- `--seed a,b`
- `--sweep N`
- `--trace [label]` sets `SIM_TRACE`, which streams deliveries touching the label
- `--red`
- `--list` prints the scenario catalog from a static scan: name, red task, modes
- `--invariants` prints the catalog
- `--out dir`
- `--order "<channels>"` sets `SIM_ORDER`

The env vars remain the source of truth.

### 3.9 Labels, reports, replay

**`sim/labels.ts`**: a map from 32-char id to label.
- The world registers `ada`, `acme`, `ada/s`, `task:acme/t1` and so on.
- `backend.onInsert` registers `table#n` for rows created by real mutations.
- `label(id)` falls back to the first 8 characters of the id.

**`sim/report.ts`** formats a failure block.
- It covers: scenario, mode, seed, step, delivery number; invariant id and meaning; window (principal and scope); the row label; a field-only server vs replica diff that omits `PAYLOAD_DENYLIST`; and the last 12 deliveries from `net.ring`.
- It prints two replay lines, `bun run sim <name> --seed N --trace <label>` and `--order "<net.orderSoFar()>"`.
- It prints the artifacts path.
- It throws with the same text. Artifacts go to `$SIM_OUT/<scenario>-<mode>-<seed>/{result.json,events.jsonl,world.json,final.json}`. They are always written on failure, and on a pass only when `SIM_OUT` is set.
- **Determinism self-test:** the same scenario and seed run twice must produce identical `events.jsonl` hashes.

### 3.10 Typecheck, CI, budget

**Typecheck**
- `packages/web/store/__tests__/sim/tsconfig.json` extends `../../../tsconfig.json`.
- It sets `include: ["./**/*.ts", "../inboxSimHarness.ts", "../inboxConvergenceSim.test.ts", "../inboxMultiWindowSim.test.ts"]` and `exclude: []`.
- It sets `compilerOptions.types: ["bun"]` and `typeRoots: ["../../../../cli/node_modules/@types"]`, because `@types/bun` resolves only under packages/cli today.
- Fallback if the typeRoots path is not stable: add `@types/bun@1.3.13` as a web devDependency, with bun.lock in the same change.
- `.codecast/check.toml` gains `sim = "packages/web/store/__tests__/sim/tsconfig.json"`.

**CI**
- `test-web` already runs `bun test --isolate` in packages/web, so `sim/sim.test.ts` and the two legacy suites run there.
- The `ci.yml` change sets `SIM_OUT: ${{ runner.temp }}/sim` on the web unit step, and adds an `actions/upload-artifact` step with `if: failure()` for that directory.

**Budget**

| Item | Limit | Kind |
|---|---|---|
| Deliveries per scenario run | 5000 | hard failure |
| Server writes per scenario run | 2000 | hard failure |
| Deliveries or writes for a specific scenario | override through `budget:` | hard failure |
| `sim/sim.test.ts` on CI | 90s (about 7s import, self-tests, 11 scenarios x 3 runs) | target |
| Legacy suites | 1.5x today's 24s and 32s | target |

If a target is exceeded, cut the CI seeds first and never cut scenarios. A new `test-sim` job is a Phase 3 option only if 90s is not achievable.

### 3.11 Disposable deployment (recipe only, in `sync-sim.md`)

It is used only for real OCC, real scheduler timing, HTTP routes, the prod error shape, and reconnect exactly-once. The recipe:

1. **Scratch copy.** Make a copy with `git ls-files -co --exclude-standard`, so no `.env.local` travels. Never use the main checkout or a `cast ws` worktree, because they copy the prod admin key. Symlink node_modules.
2. **Refusals.** Refuse to run if `CONVEX_SELF_HOSTED_*`, `CONVEX_DEPLOY_KEY` or any `.env.local` is visible.
3. **Start the backend.** Run `env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY -u CONVEX_DEPLOYMENT npx convex dev --once --env-file <tmp: CONVEX_DEPLOYMENT=anonymous:sim-<name>> --codegen disable --typecheck disable --tail-logs disable` in a tmux pane.
4. **Check the URL.** Assert that the resolved URL host is `127.0.0.1` before the first request.
5. **Act as users.** Use `ConvexHttpClient.setAdminAuth(adminKey, actingAsIdentity)`.
6. **Never** use `deploy.sh`, `gated-push.ts`, `bun run dev`, or the package `deploy` script.

## 4. Files

**Create**

| Path | Unit |
|---|---|
| packages/convex/convex/simBackend.testing.ts | U1 |
| packages/convex/convex/simValidate.testing.ts | U1 |
| packages/convex/convex/simBackend.test.ts | U1 |
| packages/web/lib/dispatchBinding.ts | U3 |
| packages/web/lib/__tests__/dispatchBinding.test.ts | U3 |
| packages/shared/contracts/__fixtures__/teamWorldGen.ts | U4 |
| packages/shared/contracts/__fixtures__/teamWorldGen.test.ts | U4 |
| packages/web/store/__tests__/sim/tsconfig.json | U5 |
| packages/web/scripts/sim.ts | U5 |
| packages/web/store/__tests__/sim/net.ts | U6 |
| packages/web/store/__tests__/sim/net.test.ts | U6 |
| packages/web/store/__tests__/sim/realm.ts | U7 |
| packages/web/store/__tests__/sim/windowSlots.ts | U7 |
| packages/web/store/__tests__/sim/windowSlots.guard.test.ts | U7 |
| packages/web/store/__tests__/sim/sim.test.ts | U7 |
| packages/web/store/__tests__/sim/selftests/realm.selftest.ts | U7 |
| packages/web/store/__tests__/sim/labels.ts | U8 |
| packages/web/store/__tests__/sim/report.ts | U8 |
| packages/web/store/__tests__/sim/report.test.ts | U8 |
| packages/web/store/__tests__/sim/window.ts | U9 |
| packages/web/store/__tests__/sim/device.ts | U9 |
| packages/web/store/__tests__/sim/selftests/window.selftest.ts | U9 |
| packages/web/store/__tests__/sim/world.ts | U10 |
| packages/web/store/__tests__/sim/actors.ts | U10 |
| packages/web/store/__tests__/sim/selftests/world.selftest.ts | U10 |
| packages/web/store/__tests__/sim/invariants.ts | U11 |
| packages/web/store/__tests__/sim/selftests/invariants.selftest.ts | U11 |
| packages/web/store/__tests__/sim/dsl.ts | U12 |
| packages/web/store/__tests__/sim/selftests/dsl.selftest.ts | U12 |
| packages/web/store/__tests__/sim/scenarios/<11 files>.scenario.ts | U13a-k |
| docs/architecture/sync-sim.md | U15 |

**Change**

| Path | Unit | What |
|---|---|---|
| packages/convex/convex/testDb.ts | U1 | additive options (section 3.2) |
| packages/shared/package.json | U4 | `exports` entry for `contracts/__fixtures__/teamWorldGen`, so web's `sim/world.ts` can import it by package name |
| packages/web/store/inboxStore.ts | U2 | `export const __createInboxStoreForTests = createInboxStore`; `export function freshInboxData()` built from `INITIAL_INBOX_DATA` via `cloneInitialValue`, which `clearProtectedInboxMemory` uses; `export function __inboxStoreSimSlots()` returning get/set for the `window` bindings and a reset for the `memo` bindings listed in 3.3 |
| packages/web/store/gestureBridge.ts | U2 | `__gestureBridgeSimSlots()` for `sourceToken` |
| packages/web/store/syncTransaction.ts | U2 | `__syncTransactionIdleForTests(): boolean` |
| packages/web/store/viewNav.ts | U2 | `__viewNavSimSlots()` for `pendingSource`, `appliedNavCount` |
| packages/web/hooks/useEnsureDispatch.ts | U3 | calls `makeDispatchBinding` and `applyDispatchFailure` from lib/dispatchBinding.ts (the `ackFlagSupported` latch moves into the binding's state object) |
| packages/web/hooks/useSyncInboxSessions.ts | U3 | extract the floor watch-effect body, including its `logStamped` gate, as `export async function runInboxFloorStep(convex, opts)`; the hook calls it |
| packages/web/hooks/useSyncTeamInboxSessions.ts | U3 | `export function applyTeamLivenessPayload(teamId, data)` and `teamInboxArgs(teamId)`; the hook calls them |
| packages/web/hooks/useSyncCollection.ts | U3 | `export function applyCollectionFeed(key, data, select?, syncOpts?)`; the hook calls it |
| packages/web/hooks/useBootstrapCollection.ts | U3 | `__bootstrapSimSlots()` for `done` |
| packages/web/hooks/useSyncChangeFeed.ts | U3 | `__changeFeedSimSlots()` for `cargoSupported`, `applyTally`, `flushTimer`, `shadowApplied` |
| packages/web/hooks/reconcileCrawl.ts | U3 | `__reconcileCrawlSimSlots()` for `states` |
| .codecast/check.toml | U5 | `sim` entry |
| packages/web/package.json | U5 | `"sim": "bun scripts/sim.ts"` |
| packages/web/store/__tests__/inboxSimHarness.ts | U14 | thin adapter over sim/ |
| packages/web/store/__tests__/inboxConvergenceSim.test.ts | U14 | imports; failures through report.ts |
| packages/web/store/__tests__/inboxMultiWindowSim.test.ts | U14 | same |
| docs/architecture/sync-convergence.md | U15 | Validation plan points at sync-sim.md |
| docs/architecture/sync-host.md | U15 | Invariants section names `INV-followers`, `INV-fixpoint` |
| .github/workflows/ci.yml | U15 | `SIM_OUT` plus failure artifact upload in `test-web` |

## 5. Work units

Every unit touches only its own files. Within a wave, units run in parallel in the shared checkout.

**Before editing**, a unit runs `git status` and reads `git diff` on its files. `inboxStore.ts` is dirty from other sessions, so U2 edits only the lines it adds and reverts nothing.

**Interface contracts** are the signatures in section 3. A unit that needs a later unit's code stubs nothing. It waits for its wave.

### Wave 1 (parallel)

**U1 Convex substrate.** `testDb.ts`, `simBackend.testing.ts`, `simValidate.testing.ts`, `simBackend.test.ts`.

What it builds: section 3.2. `simBackend.test.ts` covers eight cases:
1. `dispatch:dispatch` killSession through `clientFor` gives the same resulting rows as the direct `_handler` call in `conversations.viewerHides.test.ts`.
2. A mutation that throws after writing leaves `writes()` rows and `sync_actions` unchanged.
3. `syncLog:getRange` for a non-member scope returns `authorized: false`.
4. Bad args throw an `ArgumentValidationError`.
5. An unknown function gives the suggestion message.
6. Reading `ctx.storage` gives the named ctx error.
7. A memo hit returns byte-identical JSON, and a write between calls misses.
8. `runAfter` produces an `onSchedule` job that `runScheduled` executes with a null identity.

Acceptance:
- `cd packages/convex && bun test convex/simBackend.test.ts` passes.
- `cd packages/convex && bun test convex/` shows the same pass and fail counts as before the change. Record both.
- `cast check convex` is green.
- `grep -c "bun:test" packages/convex/convex/*.testing.ts` gives 0.

**U2 Store seams.** `inboxStore.ts`, `gestureBridge.ts`, `syncTransaction.ts`, `viewNav.ts`.

What it builds: the exports in section 4. There is no behaviour change. `clearProtectedInboxMemory` now calls `freshInboxData()`.

Acceptance:
- `cast check web` is green.
- `bun test store/__tests__/inboxStore.test.ts store/__tests__/cacheOwnership.test.ts store/__tests__/gestureBridge.test.ts store/__tests__/hotReloadReset.test.ts` passes (from packages/web).
- A new assertion in an existing file is not allowed (to keep units disjoint). So U2 adds `store/__tests__/storeSeams.test.ts`. It asserts that two `__createInboxStoreForTests()` instances hold distinct `_setDispatch` closures: binding one does not make the other's `_isDispatchWired()` true. It also asserts that `freshInboxData()` equals the initial data of a new instance.

**U3 Hook extractions.** `lib/dispatchBinding.ts` and its test, plus `useEnsureDispatch.ts`, `useSyncInboxSessions.ts`, `useSyncTeamInboxSessions.ts`, `useSyncCollection.ts`, `useBootstrapCollection.ts`, `useSyncChangeFeed.ts`, `reconcileCrawl.ts`.

What it builds: each extraction is called by its own hook with identical arguments, so exactly one copy exists. `dispatchBinding.test.ts` covers:
- unwrapping `__syncAckV1` calls `stampSyncAck` with patches and `sentAt`;
- an `ArgumentValidationError` naming `ack_positions` latches off and re-issues the call unflagged;
- `applyDispatchFailure` marks the optimistic send failed.

Acceptance:
- `cast check web` is green.
- `bun test hooks/ lib/__tests__/dispatchBinding.test.ts` passes, with the same count as before plus the new tests.
- `grep -n "__syncAckV1" packages/web/hooks packages/web/lib -r` hits only `lib/dispatchBinding.ts`.

**U4 Team world generator.** `teamWorldGen.ts` and its test.

What it builds: section 3.6. The test pins `sha256(JSON.stringify(genWorld(s, n, inboxEpoch(1_800_000_000_000), me)))` for every seed the legacy suites use: the web sims' `seededWorld` seeds (11, 21-32, 71, 72, 81-92, 101, 102, 111) at 45 rows with `me = "u" x 32`, and the convex convergence seeds (500-513 at 90 rows, 77 at 10, 9 at 40) with `me = "users_me"`. Rows draw from one stream in order, so a smaller count is a prefix of the pinned one. Capture the hashes before writing the generator. It also asserts that no two users' conversation ids or tags collide across seeds 1-50.

Acceptance: `cd packages/shared && bun test contracts/__fixtures__/teamWorldGen.test.ts` passes, and `git diff --stat packages/shared/contracts/__fixtures__/inboxProjectionGen.ts` is empty.

**U5 Tooling.** `sim/tsconfig.json`, `.codecast/check.toml`, `scripts/sim.ts`, `packages/web/package.json`.

Acceptance:
- `cast check sim` runs. It may report zero files until later units land, but the config must resolve `bun:test` types. Prove it by adding nothing: the legacy harness files it includes must typecheck, or their pre-existing errors are listed in the unit's report.
- `bun run sim --list` prints an empty catalog without error.
- `bun run sim --help` lists every flag.

### Wave 2 (parallel; needs wave 1)

**U6 Net.** `sim/net.ts`, `sim/net.test.ts`. This is pure, with no store import.

Acceptance: `bun test store/__tests__/sim/net.test.ts` passes. The tests cover:
- FIFO within a channel;
- interleave permuting only across channels, with seeded reproducibility;
- an `order` replay reproducing an interleave run exactly;
- a lagged channel not delivering until released;
- offline holding `conn:` events;
- a dirty live channel coalescing to one pending delivery;
- `drain` advancing the clock to the next due event and stopping at the horizon;
- the no-quiescence error naming the top producers;
- the write budget error.

**U7 Realm, slots and runner.** `realm.ts`, `windowSlots.ts`, `windowSlots.guard.test.ts`, `sim.test.ts`, `selftests/realm.selftest.ts`.

What it builds:
- The realm imports `Net` only as a type for the timer shim's enqueue callback, passed in at `installRealm`.
- `realm.selftest.ts` covers:
  - two store instances bound in turn: a write in window A is invisible in B, and each `window` slot round-trips;
  - `Math.random` from window A's stream is unaffected by draws made in window B;
  - a `setTimeout(fn, 0)` armed inside A runs inside A;
  - `uninstallRealm` restores `Date.now`, `Math.random`, `setTimeout` and the facade.

Acceptance:
- `bun test store/__tests__/sim/windowSlots.guard.test.ts` passes, and fails when a scratch `let x = 0` is added to `store/syncActivity.ts`. Revert the scratch edit afterwards.
- `bun test store/__tests__/sim/sim.test.ts` runs the realm self-test via the glob.
- `SIM_SCENARIO=nomatch` runs zero scenarios.
- `cast check sim` is green.

**U8 Labels and report.** `labels.ts`, `report.ts`, `report.test.ts`. This is pure: it takes `Delivery[]`, a diff and labels.

Acceptance: `bun test store/__tests__/sim/report.test.ts` passes. It snapshots the full failure block for a forced diff, including that denylisted fields never print, and both replay lines.

### Wave 3 (needs wave 2)

**U9 Window and device.** `window.ts`, `device.ts`, `selftests/window.selftest.ts`.

The self-tests:
- A host window boots against a world of one user, and its `mine` digest equals the canonical projection.
- A follower completes a chunked snapshot while a live write lands between chunks.
- A follower `kill` replicates to the host, reaches `dispatch:dispatch`, and the ack retires the lock.
- Two windows of one device keep distinct outbox closures: one goes offline with a queued dispatch, the other stays wired.
- `dropResponse` plus `online()` delivers exactly once, through the server receipt.

Acceptance: `SIM_SCENARIO=nomatch bun test store/__tests__/sim/sim.test.ts` passes and `cast check sim` is green.

**U10 World and actors.** `world.ts`, `actors.ts`, `selftests/world.selftest.ts`.

The self-tests:
- genesis for 3 users and 2 teams passes the `teamScopeSweep` gate;
- a daemon token principal can `claimTask`;
- every actor verb in the table reaches its named function, shown in `backend.calls`.

Acceptance: same commands as U9.

**U11 Invariants.** `invariants.ts`, `selftests/invariants.selftest.ts`.

The self-tests plant a violation for each invariant (for example, an extra row in `teamInboxIds`, a stale cursor, a leaked task after revocation) and assert the invariant id and the row label in the report. They also run the coverage guard against the live `REPLICATION_CLASSIFICATION`, and against a fake extra key to check its message.

Acceptance: same commands as U9.

### Wave 4 (needs U9-U11)

**U12 DSL.** `dsl.ts`, `selftests/dsl.selftest.ts`.

The self-tests:
- one trivial scenario runs in scripted mode and in two interleave seeds;
- the determinism check (two runs, same `events.jsonl` hash);
- a `red:` scenario that passes produces the flip message;
- `SIM_SEEDS` and `SIM_ORDER` are honoured.

Acceptance:
- `bun run sim --seed 3 --trace ada/s` streams deliveries.
- `bun run sim --list` shows the self-test scenario.
- `cast check sim` is green.

### Wave 5 (parallel; needs U12)

**U13a-k: one scenario file each.** Each unit touches only its own `.scenario.ts` file, written at 15 to 30 lines against section 6.

Acceptance, per scenario:
- `bun run sim <name>` either passes, or fails on a named invariant or point check. It never fails on a harness error.
- If it fails, file a task under pl-810 (`cast task create "<finding>" --plan pl-810`) with the report block and the `--order` line, and set `red: "<ct-id>"`. Rerun and confirm that it now reports as expected-failing.
- Finally, `bun run sim <name> --sweep 20` shows no harness errors.

**U14 Legacy port.** `inboxSimHarness.ts`, `inboxConvergenceSim.test.ts`, `inboxMultiWindowSim.test.ts`.

What changes:
- `Replica` wraps `SimWindow`, and `Device` wraps `SimDevice`. `REPLICA_KEYS`, `freshReplicaState`, `dispatchPending` and `dispatchTouched` are deleted.
- `SimServer` wraps the backend. `mutate/insert/delete` go through `makeChangeTrackedDb`. `range/head` read the real log. `retain(upTo)` calls `runInternal("syncLogPrune:pruneSyncActions")` with a cutoff equal to the timestamp of position `upTo`.
- Each `SERVER_EVENTS` entry becomes an actor call:
  - `otherDevicePins/Dismisses/Stashes/Restores` become a second window's store action;
  - `agentSettles` becomes the daemon's `updateAgentStatus` (the churn exemption now applies);
  - `gcDeletesBlank` becomes `cleanup:gcEmptyConversations` over rows with an old `_creationTime`.
- Exports keep their names. Seeds are unchanged.

Acceptance:
- Record the old wall times first with `bun test store/__tests__/inboxConvergenceSim.test.ts` and the multi-window suite on the pre-port tree.
- After the port, both run. Every seed that changed outcome gets a line in the ct-55688 task, with the seed, the reason (for example "reap of an empty row"), and either a fixed expectation with the reason in a comment beside it or a red scenario plus a task.
- Wall time is at most 1.5x the old figure, and `cast check sim` is green.

**U15 Docs and CI.** `sync-sim.md`, `sync-convergence.md`, `sync-host.md`, `ci.yml`.

`sync-sim.md` covers the layers, the protocol rules, the DSL vocabulary, the invariant catalog, the replay knobs, the budget, the deployment recipe from section 3.11, and the red-list map from section 6.

Acceptance:
- Every command in the docs is run once and works.
- `ci.yml` is valid: `gh workflow view ci.yml`, or `actionlint` if present.
- The docs contain no em dashes.

### Final gate (orchestrator, after all units)

Run these from `packages/web`:
- `bun run sim` (full);
- `bun test --isolate store/__tests__/`;
- `cast check` (all programs).

Then run `cd packages/convex && bun test convex/`. Time `bun run sim` and the legacy suites, and post the table in ct-55688. Check that `git diff --stat` touches only the files listed in section 4.

## 6. Scenario catalog

| File | Setup | Steps | Must hold | Likely outcome |
|---|---|---|---|---|
| visibilityFlip | acme {ada, bo}; ada session s is private, with a linked task t | ada `setPrivacy(s, team)`, settle, then back to private | bo's team slot gains and then loses s; after the flip back, `bo cannotRead(t)`; `INV-sweep` is clean | green |
| viewerHideVsOwner | ada session s, team-visible and working; A = ada (1 follower), B = bo (scope acme) | B.host `kill(s)`; ada.daemon `settles(s)` | `inbox_hides` row for bo; `A shows s` with an unchanged status; B's team slot excludes s | green |
| reapVsFollowerLock | ada's empty s (message_count 0); A has 1 follower | the follower kills s; ada.daemon heartbeats during the dispatch | the row is gone on the server and in every window; no lock survives; cursors equal heads | may be red |
| queuedSendVsLaggingTail | ada's s is working | `A.lag("live:messages")`; ada `send(s)`; daemon claims and delivers; release | exactly one bubble, settled; each `client_id` unique | may be red |
| roleTriggerScope | acme with the org flag, role anchor R; bo's s goes waiting | daemon `updateAgentStatus(waiting)` twice | one role event per `hand_wake_notified_key`; `INV-triggers`; ada and bo each see only the triggers `webList` returns | may be red |
| agentPingPong | two agent sessions in acme mention each other | `agent.says` in a loop; clock advances 1h | caps hold; settle quiesces within budget | green or a named producer |
| personalAnchorOwnedByTeammate | ada's personal anchor; bo in `session_owners` | bo `pin`, then `kill` | bo's ack retires the lock | **red** (second-party owner fan-out gap) |
| twoHumansOneRole | ada and bo in acme, role R | both `tellRole(R)` 200ms apart; `order` mode runs both orders | two enqueued; wake counter equals 2; deterministic turn order. The doc notes OCC is not covered. | green |
| memberRemovedMidTurn | bo in acme, device B (scope acme), holding acme tasks; bo's s is working | admin `remove(acme, bo)`; bo then kills an acme row | B purges acme rows and tasks (no unreadable row); acme cursor gone; the kill is rejected and rolled back; anchor host check holds | may be red |
| resumeVsSend | ada's parked s | ada `send(s)` and daemon `resume(s)` in both orders | one delivery; one `client_id`; bubble settles | may be red |
| daemonRestartParked | ada has 3 parked sessions with `run_session_uuid` and a due trigger | daemon heartbeat gap past the stale threshold; `restart`; `claimTask` | no duplicate sessions; status is coherent; `armed_trigger_kind` is consistent | may be red |

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Facade rebinding misroutes.** Something captured the zustand api or `getState` at load. | Verified today: no production module captures `getState`. `realm.selftest` asserts that routing covers the `store` proxy. The slots guard also flags new top-level bindings that hold a function taken from `useInboxStore`. |
| **Async work escapes a window.** A continuation outlives `runInWindow` and lands after the facade is unbound. | Per-instance closures (dispatch, tees, outbox) use their own `get/set`, not the facade. `runInWindow` yields with `setImmediate` until microtasks settle. Timers created in a window are tagged and re-enter it. In trace mode, any facade read with no active window throws `sim: store read outside a window`. |
| **Reaping changes the legacy seeds** (about 6% of genWorld rows are empty). | Each changed seed is triaged in U14 and recorded in ct-55688. It is never silently re-pinned. |
| **Genesis rows skip the write interceptor.** | Conversations get stamps through `patchConversationVisibility`. Work items come from real create mutations. The genesis gate is a clean `teamScopeSweep`. |
| **Arg validation flags real client and server mismatches.** | Treat each one as a finding with a task. Do not loosen the validator. |
| **Whole-mutation serialization cannot show OCC.** | This is stated in the twoHumansOneRole doc. The deployment recipe covers it later. |
| **Module caches in convex code leak between seeds** in one process (quota buckets, the probe cache). | `SimWorld` construction calls every known `_reset*ForTests` in convex modules. `world.selftest` runs one scenario twice in a row and compares digests. |
| **Hook extractions change live behaviour.** | Each hook calls the extracted function with identical arguments. The hooks' existing tests and `cast check web` are the gate (U3). |
| **The sim tsconfig pulls convex sources under web compiler options** and reports errors nobody wrote. | Suspect the config first. Mirror the needed convex options in the sim tsconfig. If a real incompatibility remains, record it in the unit report instead of excluding files. |
| **The import cost exceeds the budget.** | One store-importing test file. `SIM_SCENARIO` narrows the imports. Cut CI seeds before cutting scenarios. |
| **Shared checkout.** `inboxStore.ts` has other sessions' edits. | U2 adds exports only, near the end of the file, and never reverts or reformats other lines. It reruns `git diff packages/web/store/inboxStore.ts` before and after, and confirms that only its own additions appear. |
| **Deployment safety** (documented only). | The recipe forbids the main checkout and `cast ws` worktrees, and requires the scratch copy and the 127.0.0.1 assertion. No script ships in Phase 2. |

## 8. Decisions for the founder

Nothing blocks Phase 2. One item is flagged for Phase 3, when the red scenario lands:

- **Co-owner sync-log fan-out.** A second-party owner (`session_owners`), or a teammate triaging someone else's session, gets no sync-log actions for that conversation, because fan-out goes to `user:<runner>` only (syncLog.ts:305-308). Their acks never retire their locks. Phase 2 lands `personalAnchorOwnedByTeammate` as `test.failing`. The fix, fanning conversations out to the owners' scopes as well, changes who receives which rows. That is an access and routing product decision, so it is queued for the founder when Phase 3 starts.