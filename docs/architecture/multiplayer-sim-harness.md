# Phase 2 spec: multiplayer simulation harness (ct-55688, plan pl-810)

This spec can be followed cold. It builds on Design 2 (operator view), which scored highest. It takes per-window store isolation, the oracles and the server-helper placement from Design 1, and the minimal extraction set and deferred deployment tier from Design 0. It avoids every fatal flaw the judges named. Line numbers refer to the working tree on 2026-09-30.

## 1. Goal and definition of done

The simulator runs several people (principals), each with several browser windows, against the **real Convex handlers** and the **real client sync code** in one bun process. It checks convergence and access invariants after every scenario and prints failures a person can read.

Phase 2 is done when all of the following hold:

1. **One command runs everything.** `bun run sim` (in `packages/web`) runs 11 red-list scenarios plus the harness self-tests.
   - A scenario either passes, or carries a red marker (`{ task, invariant }`) and fails on that named invariant. A run held to a marker that fails any other way (a harness error, a timeout, another invariant) fails the test.
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
| Red scenarios | Each failing scenario gets its own task under pl-810, referenced in a `red:` marker that also names the invariant the run fails on. A bug that trips before the scenario's own checks is a `known:` invariant, left out of the runs and held by one extra run with nothing left out. | Fixing the bug flips the test red, which forces the marker's removal. |

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
export interface CallRecord { seq: number; principal: Principal; name: string; kind: "query"|"mutation"|"action"; ok: boolean; error?: string; writes: number; memo?: "hit"|"miss"; }
export interface SimBackendOptions {
  tables: Record<string, any[]>;
  now: () => number;
  rngFor: (callSeq: number) => () => number;             // per-call seeded stream
  mintId: (table: string, n: number) => string;          // 32-char [a-z0-9]
  onSchedule?: (job: ScheduledJob) => void;               // world turns jobs into `sched` deliveries
  onInsert?: (table: string, id: string) => void;         // labels
  memoFunctions?: string[];                               // default: the four inbox reads
  modules?: Record<string, () => Promise<any>>;           // extra modules by reference name (test fixtures)
  debug?: boolean;                                        // overlapping top-level calls throw instead of queueing
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
  activeCall(): { seq: number; name: string; rng: () => number } | null;   // for the realm's Math.random routing
};
```

**Routing**
- `getFunctionName(ref)` returns `"module:export"`. The module is resolved through a literal lazy map, `const MODULES = { syncLog: () => import("./syncLog"), ... }`.
- The map starts with: syncLog, conversations, dispatch, tasks, docs, plans, projects, chat, pendingMessages, agentTasks, teams, anchors, managedSessions, orgRoles, teamScopeSweep, syncLogPrune and cleanup. U10 added `users` (the resume mutation) and `notificationRouter` (reached by `tasks:create` through `runMutation`); a module a real handler reaches is added the same way. U9 adds sessionDecisions, whose `listForUser` a host window feeds. U13e adds `notifications`, whose `checkNeedsInput` a status settle schedules. U13g adds `sessionOwnership`, whose `addSessionOwner` makes a teammate a second owner (the world has no owner declaration, so a scenario calls it after `start()`). U13j adds `messages`, whose `addMessages` is the daemon's transcript echo of a delivered send (and whose `getMessageCoverageV2` the window's coverage poll asks).
- Lazy imports avoid import-cycle TDZ and load only the modules a run uses. The file is never bundled, so the Convex dynamic-import restriction does not apply.
- An unknown name throws: `sim client: no handler for "chat:sendMesage"; did you mean chat:sendMessage? Add the module to MODULES in convex/simBackend.testing.ts`. The suggestion is the closest name by edit distance (`levenshtein` from the `@codecast/shared/contracts/levenshtein` subpath, kept out of the contracts barrel so the daemon boot graph does not load it, shared with the CLI's command suggestions), searched in the named module or, for an unknown module, the nearest module name.
- Kind and visibility are enforced from `isQuery/isMutation/isAction/isPublic/isInternal`. `clientFor` reaches public functions only. `runInternal` reaches internal and public ones, as server code can.
- `calls` records top-level calls only. Nested `runQuery`/`runMutation` calls are part of their caller's record.

**Validation and the wire boundary**
- `simValidate.testing.ts` walks the JSON validator from `fn.exportArgs()` (registration_impl.js:102/127). It covers object, optional, string, float64, int64, boolean, null, id, literal, union, array, record, any and bytes.
- It rejects arguments with the same message shape prod uses: `ArgumentValidationError: ...`.
- Arguments and results cross `convexToJson`/`jsonToConvex`, so no client object aliases a server row. The router computes that pair in one pass (a fresh copy, keys sorted, undefined fields dropped, field names checked) and hands any value the pass cannot judge to the library pair itself, so every error is the library's own.

**ctx is a Proxy** over the fields prod gives that kind of call: a query gets `{ db, auth, storage, runQuery }`, a mutation also `{ scheduler, runMutation }`.
- A prod field the kind lacks (`runAction`, or `scheduler` in a query) reads as `undefined`, as in prod. Touching any other field throws `sim ctx: <fn> read ctx.<field>, which the sim does not provide. Add it in makeCtx.`
- `functions.ts` wraps every tracked mutation by spreading ctx into a plain object, so inside those mutations the unknown-field guard is gone (such reads give `undefined`). The storage stub travels by reference and still throws.
- A query's `db` refuses `insert`/`patch`/`replace`/`delete`.
- `auth.getUserIdentity` returns `{ subject: userId + "|session" }` for a user principal, and null for token and system principals. Token principals pass `api_token` in args, as the CLI does.
- `runQuery`/`runMutation` re-enter the router inline under the same principal. They are not queued. Each nested mutation gets its own `withChangeLog` wrap via its own `_handler`. The journal is shared with the top-level call.
- `storage` is a stub: reading `ctx.storage` works, and touching anything on it throws `sim ctx: <fn> read ctx.storage.<method>, ...`.
- `global fetch` is replaced with a throwing stub for the duration of each top-level call, and restored after it, so test code that runs between calls keeps the real one.

**Single flight and journal**
- Top-level calls go through a promise chain, one at a time, from name resolution to commit.
- A second top-level call entering while one runs throws `sim server: X started while Y was running` in debug mode. Otherwise it simply waits its turn in the chain.
- Each top-level mutation runs `db.__beginJournal()`. A throw leads to `db.__rollback()`, which undoes inserts, patches, replaces and deletes in reverse, including `sync_actions` rows. The error then propagates to the client.

**Scheduler**
- `runAfter(ms)` and `runAt(ts)` create a `ScheduledJob` with `due = now() + ms`. The job is also a row in a `_scheduled_functions` system table (`state.kind` pending, inProgress, success, failed or canceled), which handlers read through `ctx.db.system`.
- Scheduling is transactional: the call's jobs go to `onSchedule` when it commits, and a rolled-back mutation schedules nothing. The world turns each job into a `sched` delivery that runs `runScheduled` under the system principal.
- `runScheduled` takes its own slot on the chain and runs a job only while it is pending, so a job runs at most once. A failed job fails alone, as in prod: it is marked failed and kept in `calls`, and `runScheduled` does not throw.
- `cancel` (and `cancelScheduled`) mark it canceled. Scheduled actions are recorded only.

**Memo**
- Only `conversations:listInboxSessions`, `conversations:sessionsLiveness`, `conversations:listTeamInboxSessions` and `conversations:teamSessionsLiveness` are memoized.
- The key is (principal, name, JSON args, `writes()`, `inboxEpoch(now())`).
- Every miss calls `_resetChildAuqProbeCacheForTests()` first.
- The memo keeps the result as the handler returned it, which nothing else holds, and every caller (the first included) gets its own wired copy, so a miss costs one copy and a hit one copy.

**Random and time**
- `Date.now` is frozen for the duration of a call, which is already true under the virtual clock.
- `Math.random` inside a call draws from `rngFor(callSeq)`. This works through the realm's routing (section 3.3), which reads the running call from `activeCall()`.

**`testDb.ts` changes** are all opt-in, through a second argument `makeFakeDb(tables, opts?)`:
- `mintId(table, n)`;
- `creationTime: () => number`, a monotonic `_creationTime` stamp on insert when absent;
- `strictPatch: true`, so a patch value of `undefined` deletes the field;
- `__writeCount`, incremented on insert, patch, replace and delete;
- `__beginJournal/__commit/__rollback`. A rollback also restores `__writeCount` and the `_inserted/_patched/_replaced/_deleted` logs, and removes a table the journal created. Minted ids are not reused after a rollback, as in convex;
- an id-to-row map so `get` and `patch` are O(1) when `mintId` is set. Rows must then enter and leave through the db or the seed.

With no options, behaviour is byte-identical for the existing tests.

### 3.3 Realm and windows

**`sim/realm.ts`** owns the process-wide spies, installed by `installRealm(seed, opts?)` and removed by `uninstallRealm()`. The world builds its net and backend after the realm, so it wires them in later with `attachRealm({ timers: net, serverCall: () => backend.activeCall() })`; `timers` is typed `Pick<Net, "enqueue" | "cancel">`, the realm's only use of `Net`. `stream(name)` hands out ``makeRng(fnv1a32(`${seed}:${name}`))`` for any other named stream.

- **Clock.** The existing virtual clock moves here (`now`, `mono`, `advance`, `resetClock`, `T0`; the legacy harness imports and re-exports them). It covers `Date.now` and `performance.now`.
- **Random.** `Math.random` and `crypto.randomUUID` are spied. UUIDs are formatted as v4 from rng bytes. Routing uses the running server call, then the active window, then the world stream. The server call goes first so a handler always draws from `rngFor(callSeq)`, even if one ever runs inside a window's turn.
- **Timer shim.** `setTimeout/clearTimeout/setInterval/clearInterval` are shimmed.
  - A timer records its owner: the active window, or `global`.
  - Delay 0 enqueues a `timer:<owner>` delivery. A window's timer runs inside that window's `runInWindow`; `setInterval` re-enqueues itself after each run.
  - A positive delay is enqueued with `due = now + delay`; the net holds it until the clock reaches it, and `drain` advances the clock to it. `clearTimeout` calls `net.cancel(seq)`.
  - `setImmediate` and `queueMicrotask` stay real.
- **Store facade.** While the realm is installed, `useInboxStore.getState/setState/subscribe/getInitialState` are getters that read one target, and `bindStoreFacade(inst | null)` points that target at `inst`'s api, or back at the saved base api. Binding is one assignment and the facade's shape never changes under the code that reads it. With `strictFacade` (default on when `SIM_TRACE` is set), unbinding points it at a facade that throws `sim: store read outside a window` instead.
- **Active window.** `activeWindow()` returns it, and `runInWindow(w, fn)` does this:
  1. `assertTransientIdle()`;
  2. when the previous turn was another window's: save that window's slots, restore `w`'s (`freshSlots()` the first time `w` runs) and reset the memo slots. A window that runs twice in a row keeps its bindings and caches in place, as one browser window does, and pays no copy; its bindings stay live after the turn until another window's turn saves them;
  3. `bindStoreFacade(w.store)`;
  4. `await fn()`;
  5. drain the microtask queue in place (`drainMicrotasks` from `bun:jsc`, which runs `process.nextTick` callbacks too). Inside a realm every timer is a net delivery and every server call a conn delivery, so a turn's own work waits only on microtasks, and one drain settles every promise chain it started. A `setImmediate` yield would do the same through an event loop turn, whose opportunistic GC work grows with the heap: on the legacy suites that was about a fifth of all instructions;
  6. `settleTransients()`: publish the notification fold `syncTransaction` holds for one 33 ms frame, while `w` is still bound, since the sim models no frames;
  7. unbind.

  Steps 5 to 7 run in a `finally`. A call for the window already running joins its turn; a call for another window while one runs throws. `runInWindowSync(w, fn)` is the same turn for a synchronous `fn` that starts no async work (a placement read, a compare tick), without the drain; the legacy suites read their windows through it. `uninstallRealm` restores the spies, the facade, and the module bindings it found at install.

**`sim/windowSlots.ts`** is the registry:

```ts
export type SlotClass = "window" | "memo" | "transient" | { shared: string };
export const WINDOW_SLOTS: Record<string /* "store/inboxStore.ts:_heldOverlayFacts" */, SlotClass> = { ... };
export function saveSlots(): SlotSnapshot; export function restoreSlots(s: SlotSnapshot): void;
export function freshSlots(): SlotSnapshot; export function resetMemos(): void;
export function settleTransients(): void; export function assertTransientIdle(): void;
```

The guard imports `WINDOW_SLOTS` and must not load the store, so the file reaches each module's seam through a lazy `require` on first use. Every seam has the shape `{ get, set, fresh }`; `syncActivity.ts` has none of its own, so its entry wraps `lastSyncApplyMono`, `syncApplySeq` and `__setSyncActivityForTests`. On first use the file checks that each seam carries exactly the bindings the table calls `window` for its file, and that every file with `memo` bindings has a reset.

The classification below is the core. The full table, as the guard enforces it, also covers about 80 bindings that are constant lookup sets, desktop shell state, IndexedDB persistence (sim windows persist through their own `_setIDBWrite` tee), counters, and component-only state, each with its reason.

| Class | Bindings |
|---|---|
| `window` | `_heldOverlayFacts`, `recentlyRequestedPendingMessages`, `resolvedSessionPreparations`, `recentThawTimer`, `_userMsgsProbed`, `_idbHydrating`, `hydrationEpoch`, `_lastParityCheckAt` (inboxStore.ts; the last is the dev parity check's throttle, one per window as in production), and the placement caches `_membershipKey/_membershipVal`, `_visibleKey/_visibleVal`, `_pendingSendSig*`, `_placementDeadlineMemo`, `_placedMemo` (inboxStore.ts: each browser window keeps its own, and every key checks that window's state refs, so they travel with the window and its next turn may reuse them); `sourceToken` (gestureBridge.ts); `states` (reconcileCrawl.ts); `done` (useBootstrapCollection.ts); `cargoSupported`, `applyTally`, `flushTimer`, `shadowApplied` (useSyncChangeFeed.ts); `_lastApplyMono`/`_applySeq` (syncActivity.ts, through the existing `__setSyncActivityForTests`); `pendingSource`, `appliedNavCount` (viewNav.ts) |
| `memo` | `railCacheKey/railCacheValue` (chatSlice.ts, reset by the existing `_resetChatRailMemo`) |
| `transient` | `depth`, `deferred`, `deferredFanOut`, `timer` (syncTransaction.ts) |
| `shared` | every `WeakMap` (keyed by per-instance objects, so it cannot cross windows); `channelFactory` (set once by the sim); `running` (syncReplication.ts; the sim never calls `startSyncReplication`); `_depChanges` (dev census); `navLog` (viewNav.ts audit ring, persisted to the one origin-wide localStorage in production too); `navListeners` (viewNav.ts follow-mode subscribers; the sim mounts no React) |

**`sim/windowSlots.guard.test.ts`** is static and imports no store.
- It uses `buildBootGraph` (packages/cli/src/bench/bootGraph.ts) from every `.ts` file under `sim/` with an `@/` alias resolver and `calls: true` (so `import()` and lazy `require` edges count), restricted to `packages/web/{store,hooks,lib}`.
- It extracts top-level `let`/`var` bindings, and `const` bindings whose line assigns `new Map|Set` (which also catches `= (globalThis.x ??= new Set())`).
- It fails on any binding missing from `WINDOW_SLOTS`, and prints the classification line to add. It also fails on a `WINDOW_SLOTS` entry whose binding no longer exists. This follows the frozen-baseline style of `nativeDeps.guard.test.ts`.

**`sim/window.ts`** defines `class SimWindow`:

```ts
constructor(world, principal: { userId: string }, device: SimDevice, role: "host"|"follower", name: string)
store = __createInboxStoreForTests()      // own engine closure
client: SimClient                         // world.backend.clientFor({kind:"user", userId}) wrapped by net (conn channel)
run<T>(fn): Promise<T>                    // realm.runInWindow(this, fn)
boot(opts: { scope?: "mine" | { team: string } }): Promise<void>
```

`boot` sets `currentUser` (the world's user row) and `clientState.ui` (`inbox_scope`, `active_team_id`) through `syncTable`, and sets `clientStateInitialized` and `syncRole` by hand as the app does after hydration. It then wires:

- **Dispatch.** `_setDispatch(makeDispatchBinding(args => client.mutation(api.dispatch.dispatch, args), state?))`, using the U3 extraction, plus `_setDispatchError(applyDispatchFailure)`. `state` is a `DispatchAckState` from `newDispatchAckState()`; one per window keeps the ack latch per window.
- **Outbox.** `_setOutbox` backed by an in-memory Map per window (`w.outbox`).
- **Write tee.** `_setIDBWrite` feeds `w.onWrite` listeners on every window and, on the host, the replication host runtime's `tee`.
- **Follower tee.** Installed when the follower runtime reports synced, as production does: `_setActionTee(followerActionTee(channel, selfId))`, extracted from `startSyncReplication` into `store/syncReplication.ts`.
- **Gesture bridge receiver.** `subscribeGestures(userId, currentUserId, applyBridgedGesture)`; `applyBridgedGesture` is extracted from `src/providers.tsx` into `store/syncReplication.ts`, so both call one copy.
- **Digest comparer.** The real `startInboxDigestCompare(client, subscribeTick, io?)` with a no-op ticker; `w.tick()` runs one compare inside the window's turn. `io` overrides part of the comparer's IO surface (the legacy suites collect its telemetry and run its heals by hand).

Host windows then mount the feeders, each a `live:<win>:<feed>` channel whose delivery recomputes the query and applies it inside the window's turn:

- `LIST_INBOX_SESSIONS_ARGS` base list, applied with `applyInboxListPayload` (the rows, then `applyLiveInboxIds`), which the hook and its recovery probe call too;
- the liveness overlay, applied with `applyMineLivenessPayload` (`applyInboxLivenessPayload("mine", ...)` behind the payload guard), shared with the hook, its recovery probe and the digest comparer's heal;
- the decision queue (`sessionDecisions.listForUser`, the questions bucket's input, which `useSyncCore` mounts), applied with `applyCollectionFeed`;
- in team scope, `listTeamInboxSessions` with `applyTeamListPayload` and `teamSessionsLiveness` with `applyTeamLivenessPayload`, both extracted from `useSyncTeamInboxSessions` and called by its subscription and recovery probe;
- `syncLog.getHeads`, whose change wakes catch-up (production debounces the wake by 1.5s; the sim runs it at once);
- any registered feed a scenario opts into (`w.feed(key, query, args)`), through the extracted `applyCollectionFeed`;
- the chat page (`w.chatPage(channelId)`) through `ingestChatPage`;
- a conversation's transcript tail (`w.tail(conversationId)`, any window, as `useConversationMessages` subscribes it): `conversations:listMessagesTail` applied through `applyTailMessages`. It returns its channel, `live:<win>:messages-<conversation id>`, so a scenario can lag it. An unchanged result is not applied again, since Convex pushes only a changed one.

Log catch-up is the real `catchUp(client)`, run through `createCatchUpRunner` (extracted from `useSyncChangeFeed`: one run at a time, one queued rerun, the `range` in-flight gate). After each pass the window runs the floor step, the extracted `runInboxFloorStep(client, inboxFloorFlags(state, userId))`, and cuts any bootstrap floor a scenario opted into (`w.bootstrap(key, query, args)`) through `bootstrapFloorFor` and `startBootstrapFloor`, extracted from `useBootstrapCollection`'s effect (they use `loadFloorOnce` and `floorScopeKeys`). The floor step is fire-and-forget (it starts `runReconcileCrawl`, which returns `void`), so the sim observes its completion through its timer and conn deliveries, not by awaiting it.

Errors cross the wire in the shape the Convex client gives a caller (`Uncaught Error: ...`, or the validator's `ArgumentValidationError` as is, with a `ConvexError`'s `data` kept), because the engine's permanent/transient split reads that text. `boot` drains the net before it resolves, or calls the world's `settleBoot(w)` when it has one.

Two optional hooks on `SimWindowWorld` serve a world that delivers feeds by hand (the legacy suites' `SimServer`): `settleBoot(w)` replaces the boot's full drain, so a window opened mid-run moves neither the clock nor another device's queue, and `holdCatchUp` makes a host's boot start no catch-up; that world wakes it with `w.catchUp()`, the same runner a heads change runs.

Followers mount no global feeders, matching production. The pending-send coverage poll runs only when a scenario calls `w.coverage()`: one pass of `reconcileStorePendingCoverage` (extracted from `usePendingMessageCoverage`), started from a `conn:<win>` delivery. The sim leaves out the other recovery polls (a sim subscription stalls only when lagged), message warming, the 60s catch-up safety tick, and the hooks' 300ms push coalescing (each push applies on its own delivery). It also mounts no `users.getCurrentUser` or `client_state.get` feeder: boot seeds `currentUser` and `clientState` once from the world, so a server-side change to either (another device's workspace switch, the CLI's `resolveWorkspace`) never reaches a sim window, and that mirror-desync class is not covered. Mounting them adds two live channels per host, which reorders every interleave seed, and needs the window's boot scope written to the server's `client_state` row; both are left for a later unit. `refeed()` skips a held feed (lagged, or its window offline), so read-your-writes and INV-fixpoint never apply data the window cannot hear yet.

### 3.4 Network and scheduler: `sim/net.ts`

This module is pure and never imports the store.

```ts
export type Channel = string;  // "conn:<win>", "live:<win>:<feed>", "repl:<from>><to>", "bridge:<dev>:<from>",
                               // "timer:<owner>", "sched", "actor:<name>"
export interface Delivery { seq: number; channel: Channel; due: number; label: string; run: () => Promise<void> | void; producer: string; }
export type DeliveryInit = Omit<Delivery, "seq" | "channel" | "due"> & { channel?: Channel; due?: number };  // due defaults to now()
export interface LiveMount { run: () => Promise<void> | void; label?: string; producer?: string; }
export type ChannelFilter = (channel: Channel) => boolean;
export const DEFAULT_MAX_DELIVERIES = 5000, DEFAULT_MAX_WRITES = 2000, DEFAULT_DRAIN_HORIZON_MS = 2 * HIDDEN_OVERRIDE_SETTLE_MS;
export class SimNetError extends Error { code: "no-quiescence" | "write-budget" | "order-mismatch"; }
export function formatOrder(channels: Channel[]): string;   // space separated, the --order line
export function parseOrder(s: string): Channel[];           // spaces or commas
export class Net {
  constructor(opts: { rng: () => number; maxDeliveries?: number; maxWrites?: number; writes: () => number; now: () => number;
                      advance: (ms: number) => void; onOnline?: (win: string) => void; onDeliver?: (d: Delivery) => void });
  mode: "scripted" | "interleave" | { order: Channel[] };   // setting it restarts an order replay
  enqueue(channel, d: DeliveryInit): number;  // returns seq
  cancel(seq): boolean;              // clearTimeout, a canceled job
  mountLive(channel, m: LiveMount): void; unmountLive(channel): void;
  markDirty(channel): void;          // live refresh: at most one pending per mounted live channel
  step(only?: ChannelFilter): Promise<Delivery | null>;  // one delivery per mode rules, among the channels `only` accepts
  drain(opts?: { horizonMs?: number; only?: ChannelFilter }): Promise<void>;
  queued(only?: ChannelFilter): number;   // deliveries waiting on those channels (the legacy suites' device queue)
  ring: Delivery[];                  // last 64, for reports
  orderSoFar(): Channel[];           // for the --order replay line
  producers(): Map<string, number>;  // deliveries run per producer
  readonly deliveries: number; readonly writesSpent: number;
  offline(win): void; online(win): void; lag(channel): void; release(channel): void;
}
```

The net's `rng` is its own stream (`makeRng(hash(seed, "net"))`). An order replay draws nothing from it, so sharing it would shift other draws between the recorded run and its replay. `onDeliver` is the hook for `SIM_TRACE` streaming and `events.jsonl`.

**Ordering rules**
- Channels are FIFO internally: deliveries due at the same time run in enqueue order, and one due later never blocks one due earlier (timers on one owner fire by deadline).
- A delivery is ready when its due time has come and its channel is neither lagged nor held by an offline window.
- `scripted` picks the lexicographically first ready channel.
- `interleave` picks a seeded choice among ready channels.
- `order` consumes the given channel list and throws `SimNetError` (`order-mismatch`) when the next listed channel is not ready while another is. Once the list is used up it continues as `scripted`, so a partial order pins only the first deliveries.
- A lagged channel is not ready until it is released.
- An offline window's `conn:<win>` and `live:<win>:*` channels hold their events, and neither pulls the clock forward. `online()` calls `onOnline(win)`; the world passes `windowOnline(world, win)` from `sim/window.ts`, which enqueues a `_drainOutbox` turn on `conn:<win>` behind the requests the outage held (the net never touches the store).

**Requests and responses**
- A client call from window W becomes `req` then `res` on `conn:W`.
- `req` runs the handler on the server, which commits.
- `res` runs inside `W.run`. For a mutation it first applies a fresh recompute of every live feed of W at the current db version (read-your-writes), then resolves the promise.
- `W.dropResponse(n)` (on `SimWindow`) makes the next n committed mutation `res` events reject with a network error after the commit, so the engine outbox and the server receipts decide the outcome.

**Live pushes**
- A live query is mounted with `mountLive(channel, { run })`; its delivery runs `run`.
- After any delivery that raises `writes()`, the net marks every mounted live channel dirty. A write made outside a delivery (seeding) is noticed at the next `step`.
- A dirty channel's delivery recomputes the query at delivery time, so intermediate versions may be skipped, as production allows.

**drain**
- It loops until no channel is ready.
- It then advances the clock to the next armed timer or scheduled job, up to `horizonMs`. The default is `2 * HIDDEN_OVERRIDE_SETTLE_MS`.
- It stops when nothing is due inside the horizon.
- It fails at `maxDeliveries` with `did not quiesce after N deliveries; top producers: ...`, or at `maxWrites` with the top writers. Both are `SimNetError`s thrown by `step`. The write budget counts only writes made inside deliveries, so genesis is not budgeted.

### 3.5 Devices: `sim/device.ts`

`class SimDevice` holds one host window and N follower windows for one principal: `new SimDevice(world, { userId }, name)`, then `start({ followers, scope })`, or `addWindow("host" | "follower", { scope, name })` one at a time. Windows are named `<device>-host` and `<device>-w<n>`.

- It builds the engine's runtimes through `syncReplication`'s own `replicationHostFor`/`replicationFollowerFor` (the options `startSyncReplication` uses), over an in-memory hub, and `closeHost` promotes through `promoteToHost`, the elected path's own order. The engine's own test hub at `replicationRuntime.test.ts:19-47` is the reference. A post is structured-cloned and reaches every other window of the device.
- Each post becomes a `repl:<from>><to>` delivery that applies inside the receiver's `run` through `applyUpdatesToStore` (optimistic on the host, for a follower's mut).
- The host tee passes the shadow identity diff exactly as `replicationRuntime.ts:133-135` does, because the window's write tee calls the runtime's own `tee`.
- Followers join with `snapshotRequest`. Chunks arrive through the runtime's own `setTimeout(0)`, which now becomes `timer:` deliveries, so a live write can land between chunks. `device.synced(w)` reports the follower runtime's state.
- `helloRetryMs` keeps its production default.
- The gesture bridge uses `setGestureChannelFactory` once per realm, with a factory that routes by the window running now. Posts become `bridge:<dev>:<from>` deliveries to the sibling windows that subscribed.
- `closeHost()` stops the host runtime, closes the host window, and promotes the first follower the way a released Web Lock does: its follower runtime stops, it becomes the host runtime, and it mounts the host feeders. The other followers resync from the new host's first update. `closeWindow(w)` closes a follower.
- Not modelled: Web Locks election (the device names its host) and the follower's 8s solo fallback.

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

`class SimWorld` (`new SimWorld({ seed, rowsPerUser? })`, after `installRealm(seed)`) holds:
- `backend` (makeSimBackend with `mintId = (t, n) => convexIdFor(t + ":" + n)`), built by genesis, so it exists after `await w.start()`;
- `net`, `labels`, `realm`, `actors`, and the `windows` map that makes it the `SimWindowWorld` U9's windows need (the net's `onOnline` goes through `windowOnline`);
- declarations, made before `start()`: `team(name, { features })`, `user(name, teams)`, `session(user, name, { private, agentStatus, row })` (label `<user>/<name>`), `task`/`doc`/`plan(name, { owner, session })` (label `task:<name>` and so on), `trigger(name, { owner, session, runInMs })` and `role(team, handle)` (label `role:<team>/<handle>`);
- `start()` (genesis, once; every async verb calls it), `device(user, { followers, scope, name })` where `scope` is `"mine"` or `{ team: "<team name>" }`;
- `settle()` (one `net.drain()`), `interleave(n)` (n deliveries by the interleave rule; in interleave or order mode it steps under that mode so a replay keeps its place) and `cron(name, args)` (a `sched` delivery running `runInternal` under the system principal; a failure stays in `backend.calls`);
- `clientAs(user)`, `daemonClientAs(user)` (the token principal), `idOf(label)`, `row(label)` and `sweepFindings()`.

**Genesis**
1. Users, teams, api tokens, the generated and named conversations, managed sessions and decisions are seed rows. Every conversation and managed session gets a `session_id` (`sim-session-<conversation id>`), which heartbeats and the CLI's session refs key on. Memberships are inserted by an internal mutation of a fixture module (`simGenesis`, passed through the backend's `modules` option) whose ctx is the real `functions.ts` one, so the change-tracked db writes their `scope_added` rows. Their ids are minted, so they carry `team_memberships#n` labels.
2. Each conversation is then stamped through the real `patchConversationVisibility` in a second `simGenesis` mutation: `team_id` is the owner's first team, and `is_private` is a seeded draw for generated rows (stream `genesis`) and `private ?? false` for named ones. Conversations carry no `workspace` key by design; the stamps give real sync-log access scopes.
3. Work items come from the CLI's create mutations (`tasks:create`, `docs:create`, `plans:create`) under the owner's token, with `conversation_id` set to the session's `session_id` as the CLI sends it, so they take the key the session's visibility gives them. Triggers come from `agentTasks:createTask` (once, `originating_session_ref`). A chat-enabled team gets a default `general` channel from `chat:createChannel` as its admin (label `chan:<team>/general`).
4. Roles are hired by the team admin through `orgRoles:create` with `provision: true`, which runs `provisionStandingAgent` over the fake db cleanly (the hire also adds the role's bot to the team). `provisionStandingAgent` is a helper, not a registered function, so it cannot be reached through `runInternal`. The org and chat flags go on the team row through the spec's `features`.
5. `api_tokens` rows are seeded with `hashToken` (through `convex/apiTokens.ts`, which re-exports the `@platform/auth/convex` one); the token is `sim-token-<user>`.
6. The genesis gate: `teamScopeSweep:sweepPage({ table, apply: false })` over tasks, plans, docs and projects (one call per table and page; the function takes a `table`) returns no stale and no missing key, and `writes()` is unchanged by the sweep.

Rows a declaration creates through a mutation take their declared label: the world names the next insert into that table before the call, and `labels.onInsert` keeps a name a row already has.

**`sim/actors.ts`**: each verb returns after enqueueing on `actor:<name>` and never drains.

| Actor | Verbs | Real path |
|---|---|---|
| human (window) | `kill`, `stash`, `restore`, `pin`, `revive(s, text = "continue")`, `send(s, text)`, `setPrivacy(s, "private" \| "team")`, `chat(channel, text)`, `tellRole(role, text)` (chat `@handle` in `<team>/general`) | the store action a component calls (`killSession`, `stashSession`, `restoreSession`, `pinSession`, `setPrivacy`; a send is `addOptimisticMessage` then `sendMessage` under its client id; a revive adds `markBlockedReviveRequested`, as the context-park card does), then `_dispatch`, then `dispatch:dispatch` with `ack_positions`. Chat goes through the store's `sendChatMessage`, which dispatches to `chat:sendMessage` via `runMutation`, so `calls` shows `dispatch:dispatch` |
| daemon (per user) | `settles(s, status)`, `heartbeat(s)`, `restart(sessions)`, `claimPending(s?)`, `ack(s)`, `resume(s)`, `claimTask(trigger?)` | the names `packages/cli/src/syncService.ts` sends, under the user's token: `managedSessions:updateAgentStatus`, `managedSessions:heartbeat`, `managedSessions:registerManagedSession` (a restarted daemon re-registers what it recovers), `pendingMessages:getPendingMessagesForDaemon` then `claimPendingMessageForDelivery`, `pendingMessages:updateMessageStatus` (injected, paste verified), then the transcript echo `messages:addMessages` (the user line the paste produced, which the server matches to the pending row and stamps with its `client_id`, the only thing that settles the web's bubble), then `ackInjectedMessages`, and `agentTasks:getDueTasks` then `claimTask`. `resume` is `users:resumeSession`, the mutation that calls `resumeConversationSession`; it takes no token, so it runs as the user principal |
| agent | `agent(s).says(channel, text, mentions, { thread? })` | `chat:sendMessage` with `origin: "agent"` and `origin_session_id`, under the session owner's token; `thread` (a chat line's label) sends `thread_root_id`, as `cast chat send --thread` does |
| admin | `admin(user).remove(team, member)` | `teams:removeMember` |
| clock | `advance(ms)` | a delivery that moves the clock; what came due runs at the next step or `settle()` (a drain inside a delivery would re-enter the net) |

A server refusal is an outcome: it goes to `actors.log` (and `backend.calls`) and the delivery succeeds, as the CLI swallows it. An error the sim raises (`sim client:`, `sim server:`, `sim ctx:`, `sim world:`) propagates.

### 3.7 Invariants: `sim/invariants.ts`

The catalog `INVARIANTS` is a list of `{ id, meaning, keys, on, always?, when?, check(world, window, mode) }`. `on: "window"` rules run once per window (`when` skips the windows a rule does not apply to); `on: "world"` rules run once, with no window. `keys` names the store keys a rule compares against the server, which is what the coverage guard reads. `checkInvariants(world, { mode, ids, windows })` runs them in catalog order and returns `InvariantFailure[]` (invariant, window, message, row); it never throws on a violation. `failureContext(f, base)` turns one into report.ts's `FailureContext`, and the DSL reports the first. All rules run at every `settle()` and at the end of every scenario. In `mode: "always"` only the rules marked always run, their cheap half, over the windows given (the one a delivery touched).

The rules live in `sim/invariants.ts`; the structural view and the helpers they share (`canonicalMineProjection`, `scopeSweep`, `notifiedWrites`, the mention wake readers over `convex/lib/chatWakeIds`) in `sim/invariantReads.ts`; the coverage guard (`NOT_COMPARED`, `coverageGaps`) in `sim/invariantCoverage.ts`. A check reads the world through a structural view, `InvariantWorld { backend, labels, devices }` and `InvariantWindow { name, user, role, store, run, outbox?, refeed?, onWrite?, feeds? }`, which `SimWorld` and `SimWindow` satisfy as they are. Window state is read inside the window's turn. Registered queries are asked as the principal through `backend.clientFor`; plain server helpers (`heldKeysFor`, `accessStampFor`, `visibleAnchorsForUser`, `armedTriggerKindFor`, `isSessionOwner`) are called over the db.

| id | Rule | Oracle (real code) |
|---|---|---|
| `INV-sessions-mine` | The digest, tally and per-row placement (bucket, work state, fold) of the `mine` scope, from `placeInboxRows`, equal that principal's canonical projection. The window is placed at the projection's `epoch`: the server places at the epoch minute and a replica flips a stamp's `stale_bucket` on its own clock (C2), so inside a minute the two may straddle a deadline by design. | `conversations:sessionsLiveness` as u: its stamps are the final placements, its envelope the digest and tally (`canonicalMineProjection`). The `projectInbox` recompute stays in the legacy `canonicalProjection`. |
| `INV-followers` | `snapshotEntries` over `REPLICATED_STORE_KEYS` is byte-equal to the host's, for each follower, minus each `sessionsProjection` slot's `receivedAtMono` (the receiving window's own clock, stamped on apply). Host against follower, so it covers no key for the guard. | engine `snapshotEntries` |
| `INV-team-inbox` | In team scope, `teamInboxIds` equals the server team list for (viewer, team) minus that viewer's `inbox_hides` (the server already leaves them out). | `conversations:listTeamInboxSessions` with `teamInboxArgs` |
| `INV-workspace-rows` (always) | For tasks, docs, plans and projects: the window holds no row its principal cannot read (`authorizedFor(accessStampFor(row), u, heldKeysFor(u))`), in any workspace. For a collection the window feeds (`feeds`), the rows `inWorkspace(activeWorkspaceKeyOf(state))` also equal the readable server rows, compared on the fields both carry minus `PAYLOAD_DENYLIST` and `CHURN_ONLY_FIELDS`. Always mode checks only the first half, and only once the window has caught up: a revocation reaches a window through its sync log, in a scope the principal still holds (the item's new key, or `scope_removed` on the user's own scope), so while a held scope's cursor is behind its head the window has not been told and may hold the row, as production does. | `lib/accessKeys.ts` |
| `INV-sweep` | `teamScopeSweep:sweepPage({ table, apply: false })` over every work-item table finds no stale key and no missing key, and writes nothing. | `scopeSweep(backend)`, which the world's genesis gate also uses |
| `INV-cursors` | Each held scope's cursor equals its head. No cursor exists for an unheld scope. | `syncLog:getHeads` as u |
| `INV-pending-locks` | No lock whose `ack` the cursor has passed survives, and no field lock is older than `HIDDEN_OVERRIDE_SETTLE_MS`. Excludes are durable tombstones and are not aged. | the store `pending` slot |
| `INV-outbox` | Each window's outbox is empty after settle. | engine outbox Map |
| `INV-triggers` | Each conversation the principal runs has `armed_trigger_kind` equal to `armedTriggerKindFor` over its `agent_tasks`. Where the window feeds `agentTasks`, the replica equals `agentTasks:webList` as u. `genTeamWorld` emits the trigger behind every generated armed kind, and genesis inserts them. | `dormancy.armedTriggerKindFor` |
| `INV-pending-sends` (always: uniqueness) | Every bubble is echoed (a `messages` row with its client id), settled or failed. Each `client_id` appears at most once in `pending_messages` (mention wakes are INV-chat's). No queued text waits on a conversation the server no longer has. | server rows |
| `INV-chat` (always: dedupe and caps) | At most one wake (`pending_messages` with client id `chat-mention:<msg>:<target>`) exists per mention and target. Per `hourBucket(created_at)`, wakes per sender stay within `MENTION_WAKES_PER_SENDER_HOUR` and per target within `MENTION_WAKES_PER_TARGET_HOUR`. For each channel the replica holds lines of, those lines equal the newest `chat:listMessages` page. | chat.ts constants (now exported), `lib/chatQuota.hourBucket` |
| `INV-roles` | For each role, the `chat_agent_quota` counter `mention_to:<role>` of an hour equals the wakes enqueued for that role in that hour. `anchors:listAnchors` equals `visibleAnchorsForUser`, and the replica holds no anchor outside it. | anchors.ts, chat quota rows |
| `INV-ping-pong` | Wakes from an agent (a row with `from_conversation_id`, or a chat wake carrying an `origin: "agent"` line: its mention, `chat-mention:<line>:<target>`, or its thread reply relayed to the session that mentioned it, `chat-relay:<line>`) per virtual hour stay under the mention caps, per target session and per sender. | `pending_messages` rows |
| `INV-row-shape` | Every sessions row (Convex ids) holds only the inbox row's fields: `INBOX_ROW_FIELDS` plus `INBOX_FACT_FIELDS`, the fields the sync rail dispatches from the row (`DISPATCHABLE_CONVERSATION_FIELDS`), the three the sharing actions patch onto every cached copy (`team_visibility`, `share_token`, `profile_pinned_at`), and any field a pending local write holds. A raw conversation column on the row rode in on sync-log cargo, and the next list or byIds push removes it (ct-56050); INV-fixpoint cannot see that, because its pre-refeed lands the push first. | `INBOX_ROW_FIELDS`, which a convex test pins to what the feeders write |
| `INV-fixpoint` | Re-running every mounted feeder (`refeed`), one `catchUp`, and `applyEntityIds` over every held id yields no store write outside `FIXPOINT_BOOKKEEPING` (`syncMeta`, `syncProgress`). The feeds whose result moves with the clock alone (`EPOCH_FEEDS`: the liveness overlays and the base inbox and team lists, whose windows are time-bounded) are refed once first, unmeasured, as production's stale-payload probe and recovery poll would: a push from an earlier epoch minute differs from a fresh execution because time moved. Writes are counted through the window's `onWrite` tee (its `_setIDBWrite`), so a row two feeders write two ways shows even when it lands where it started. Held session ids are limited to the rows byIds serves (the principal runs or owns them). It runs last, so its writes cannot reach the other checks. | the feeders themselves |

Two further rules:
- `pendingMessages`, `pending` and `queuedMessages` are `local` keys, compared per window against the server, never host against follower. `blockedReviveRequestedAt` is a TTL overlay the store expires lazily, so it is listed in `NOT_COMPARED`.
- A **coverage guard** (`coverageGaps`, run by the self-test) fails for any `REPLICATION_CLASSIFICATION` key that is neither in some rule's `keys` (`INV-fixpoint`'s are `FIXPOINT_FED_KEYS`: the inbox base, the chat page and every registered feed) nor in `NOT_COMPARED` with a reason. It also fails on a `NOT_COMPARED` entry for a key that is gone or now compared.

Found while building the catalog: ct-56011 (the base list stamped `owned_by_me` on every row, byIds only on foreign rows, so the row flapped on every catch-up). Every feeder now stamps the viewer fields through `stampInboxViewerFields`, and the two self-tests that carried it are plain tests.

### 3.8 DSL and runner

**`sim/dsl.ts`**

```ts
export function scenario(
  opts: { name: string; red?: RedMarker | RedMarker[]; known?: Record<string, string | string[]>;
          seeds?: number; modes?: ("scripted"|"interleave")[];
          budget?: { deliveries?: number; writes?: number }; runOn?: "in-process" },
  fn: (w: SimWorld) => Promise<void>,
): void
// RedMarker = { task, invariant, modes?, seeds? }
```

- `fn` receives a `ScenarioWorld`, a `SimWorld` subclass that adds the verbs, the point checks and the run's report state.
- It registers one `describe(name)` with one test per (mode, seed). Each test runs `judgeRun(opts, run, fn, { skipInvariants: known, expected: redFor(opts, run) })`: the run must end in a `SimFailure` naming one of its markers (that resolves), a pass rejects with the flip message, and any other error rejects as is. So a harness error, a timeout, or a failure on an invariant no marker names fails the test. A marker with `modes` or `seeds` covers only those runs (an order replay matches any mode).
- `known` maps an invariant id to the task (or tasks) whose bug trips it in every run. The runs leave it out, so each reaches the scenario's own checks. A scenario with `known` registers one more test, its first run with nothing left out, judged against the known invariants: it must fail on one of them, and once none trips it fails with `scenario "<name>" no longer fails on <invariant> (<task>) with nothing left out; remove them from known: and close <task>`.
- `runScenario(opts, run, fn, extra)` is one run: `installRealm(seed)`, a fresh `ScenarioWorld`, `await fn(w)`, a final settle with the invariants (step `end`), then `uninstallRealm()`. A failing check throws a `SimFailure` carrying the report; a `SimNetError` (budget, quiescence, order replay) is reported the same way under the id `net.<code>`; any other error is a harness error and propagates. A failure a marker names prints its header as `sim failure (expected, red: <task>)`.
- Seeds are `fnv1a32(name) % 1_000_000 + i`. Scripted runs at the first seed and interleave at every seed: by default 2 seeds, so 3 runs. `SIM_SWEEP=N` widens to N seeds and `SIM_SEEDS=a,b` pins them.
- **Verbs** are `w.human(win)`, `w.daemon(user)`, `w.agent(session)`, `w.admin(user)` (the actors of section 3.6, with the same verbs) and `w.advance(ms)`. Each returns a `Step`: its delivery's seq and a lazy thenable. Awaiting it drains the net in scripted mode and returns at once in interleave mode; a verb that is not awaited waits for the next settle or point check. `w.actors` stays available for the raw enqueue-only verbs.
- **`SIM_ORDER`** runs one `order` replay per seed. A scripted run drains after each verb and an interleave run only at settle, so a replay must drain where the recorded run did: a scripted run's `--order` line starts with the word `scripted`, which the replay strips and reads as "drain after each verb".
- **Checks.** Every `settle()` runs the whole catalog (skipped when no delivery and no write happened since the last full check). Every delivery that touches a window (its `conn:`, `live:`, `repl:` target, `timer:`, human `actor:`, or a `bridge:` device's windows) runs the `always` rules over those windows, through the net's `afterDeliver` hook.
- Point checks available on `w`:
  - `w.expect(win).shows(label, { bucket? })` / `.hides(label)`: among the window's active rows (`placeInboxRows(...).sorted`) in its own scope;
  - `w.expect.server.row(label).has({...})` / `.gone()`, and `w.expect.server.gone(label)`;
  - `w.expect(user).cannotRead(label)`: the server refuses it (`canAccessConversation`, else `accessJudgeFor`) and no window of the user holds the id in any collection;
  - `w.expect(role).wokenTimes(n)`: chat mention wakes enqueued with the role as target;
  - `w.inspect(label)`: the server row and every window collection holding it, printed and returned.
- Every point check settles first. A failing one reports with the id `expect.<check>`.
- `SIM_TRACE` prints each delivery whose channel, label or producer names the label (all of them for `1`), one report-style row each. `SIM_OUT` writes the artifacts on a pass too.
- A red run that passes fails with `red scenario "<name>" now passes; it was marked to fail on <invariant> (<task>). Remove those red: markers and close <task>`.

**`sim/sim.test.ts`** is the only store-importing sim test file.
- It uses top-level `await` imports of `selftests/*.selftest.ts` and `scenarios/*.scenario.ts` via `Bun.Glob`, sorted.
- `SIM_SCENARIO=<substring>` filters which files it imports.
- `SIM_SELFTEST=0` skips the self-tests.
- A missing `scenarios/` or `selftests/` directory is skipped. The file always registers one `sim files loaded: ...` test naming what it imported. Unfiltered, it requires at least one file from each group it loads, so a renamed suffix or a moved directory cannot pass by loading nothing; a filter's names are checked by the runner.

**`packages/web/scripts/sim.ts`** turns flags into env vars and spawns `bun test store/__tests__/sim/ --isolate`, or with a filter only `sim.test.ts` (so the sim's other test files do not run with it), after refusing a filter that names no scenario or self-test file with the closest names:
- `bun run sim [filter]`
- `--seed a,b`
- `--sweep N`
- `--trace [label]` sets `SIM_TRACE`, which streams deliveries touching the label
- `--red` sets `SIM_RED=1`: the DSL runs only scenarios with a red marker or a known invariant
- `--list` prints the scenario catalog from a static scan: name, red markers, known invariants, modes
- `--invariants` prints the catalog
- `--out dir` sets `SIM_OUT` (resolved to an absolute path)
- `--order "<channels>"` sets `SIM_ORDER`

The env vars remain the source of truth. The filter sets `SIM_SCENARIO`, `--seed` sets `SIM_SEEDS` and `--sweep` sets `SIM_SWEEP`. A bare word after `--trace` is read as its label, so the filter goes first; `--trace=label` also works, and `--trace` alone sets `SIM_TRACE=1`.

`--list` and `--invariants` never import the store. `--list` reads every `scenario({ ... })` call in `scenarios/*.scenario.ts` and `selftests/*.selftest.ts`, and `--invariants` reads `invariants.ts`. So `name`, `id`, `meaning` and the strings inside `red` and `known` must be string literals, and `red`, `known` and `modes` object or array literals (absent `modes` means the DSL default, scripted plus interleave).

### 3.9 Labels, reports, replay

**`sim/labels.ts`**: `class SimLabels`, a map from 32-char id to label.
- The world registers `ada`, `acme`, `ada/s`, `task:acme/t1` and so on with `register(id, label)`. A label names one id and an id carries one label; a conflicting registration throws.
- `onInsert(table, id)` is the `backend.onInsert` hook. It registers `table#n` for rows created by real mutations, numbered per table in insert order. A row the world already named keeps its name but still takes its number.
- `label(id)` falls back to the first 8 characters of the id. `id(label)` is the reverse, for the DSL's label-based point checks, and throws naming the known labels. `relabel(text)` replaces every id-shaped token in a string with its label.

**`sim/report.ts`** formats a failure block.
- `formatFailure(ctx, artifactsDir)` takes a `FailureContext`: scenario, mode, seed, step, delivery number; invariant id and meaning, plus the check's own message; window (name, principal, scope); the row as `{ table, id, server, replica }`; the delivery ring; the channel order so far; the labels; and the clock origin `t0`.
- It covers all of those, and renders the row as a field-only server vs replica diff (`fieldDiff`, key-order blind through `canonical`) that omits `PAYLOAD_DENYLIST` (imported from `convex/syncLog.ts`). `fieldDiff` is the only place the denylist is applied, so the artifacts omit those fields too. The last 12 deliveries print as aligned rows with every id relabelled.
- It prints two replay lines, `bun run sim <name> --seed N --trace <label>` and `bun run sim <name> --seed N --order "<net.orderSoFar()>"`, serialized with net's own `formatOrder`. With no row, the first line is a bare `--trace`. A run `bun run sim` does not drive (the legacy suites) passes its own `replay` lines in the context instead.
- It prints the artifacts path.
- `reportFailure(ctx, { events, world, final })` writes the artifacts, prints the block, and throws a `SimFailure` with the same text. Artifacts go to `$SIM_OUT/<scenario>-<mode>-<seed>/{result.json,events.jsonl,world.json,final.json}`, or under `<tmpdir>/codecast-sim` when `SIM_OUT` is unset (`artifactDir`). They are always written on failure. On a pass the DSL calls `writeArtifacts` itself, and only when `SIM_OUT` is set.
- `events` is every delivery of the run, not the 64-entry ring, so the DSL collects it through the net's `onDeliver` option. `eventsJsonl` writes one canonical JSON line per delivery (seq, channel, due, label, producer). `result.json` holds the rendered diff, never the raw rows.
- **Determinism self-test:** the same scenario and seed run twice must produce identical `events.jsonl` hashes.

### 3.10 Typecheck, CI, budget

**Typecheck**
- `packages/web/store/__tests__/sim/tsconfig.json` extends `../../../tsconfig.json`.
- It sets `include: ["./**/*.ts", "../inboxSimHarness.ts", "../inboxConvergenceSim.test.ts", "../inboxMultiWindowSim.test.ts", "../../../scripts/sim.ts"]` and `exclude: []`. The runner script is listed because no other program covers `packages/web/scripts`.
- It sets `compilerOptions.types: ["bun"]` and `typeRoots: ["../../../../cli/node_modules/@types"]`, because `@types/bun` resolves only under packages/cli today. The base list's `vite/client` cannot be kept: with that `typeRoots` it no longer resolves (TS2688). `@types/bun` brings the node types itself.
- It sets `incremental: false`, so the watcher writes no `tsconfig.tsbuildinfo` beside it.
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
3. **Start the backend.** Run `env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY CONVEX_AGENT_MODE=anonymous npx convex dev --env-file <tmp: CONVEX_DEPLOYMENT=anonymous:anonymous-agent> --codegen disable --typecheck disable --tail-logs disable` in a tmux pane and leave it running. Verified with convex 1.36.1: `--once` stops the local backend when the command exits; the CLI recognizes an anonymous deployment only by a name starting with `anonymous-`; a new one is named `anonymous-agent` under `CONVEX_AGENT_MODE` whatever name was asked for, with its state in `~/.convex/anonymous-convex-backend-state/anonymous-agent/`; a first push on a loaded machine can fail with a 4s module-load timeout and is retried by saving a file under `convex/`.
4. **Check the URL.** Assert that the resolved URL host is `127.0.0.1` before the first request (the CLI writes `CONVEX_URL` to the scratch copy's `packages/convex/.env.local`).
5. **Act as users.** Use `ConvexHttpClient.setAdminAuth(adminKey, actingAsIdentity)`, with the admin key from the deployment's state `config.json`.
6. **Never** use `deploy.sh`, `gated-push.ts`, `bun run dev`, or the package `deploy` script.

## 4. Files

**Create**

| Path | Unit |
|---|---|
| packages/convex/convex/simBackend.testing.ts | U1 |
| packages/convex/convex/simValidate.testing.ts | U1 |
| packages/convex/convex/simBackend.test.ts | U1 |
| packages/shared/contracts/levenshtein.ts | U1 (edit distance moved out of cli/src/commandSuggestion.ts so the sim backend's suggestions reuse it) |
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
| packages/shared/package.json | U1 | `exports` entry for `contracts/levenshtein`. It stays out of the contracts barrel, which the daemon loads at boot |
| packages/cli/src/commandSuggestion.ts, commandSuggestion.test.ts | U1 | import `levenshtein` from `@codecast/shared/contracts/levenshtein` |
| packages/cli/src/bench/bootGraph.guard.test.ts | U1 | index.ts ceiling up by one for levenshtein.ts |
| packages/shared/package.json | U4 | `exports` entry for `contracts/__fixtures__/teamWorldGen`, so web's `sim/world.ts` can import it by package name |
| packages/web/store/inboxStore.ts | U2 | `export const __createInboxStoreForTests = createInboxStore`; a local `freshInboxData()` built from `INITIAL_INBOX_DATA` via `cloneInitialValue`, which `clearProtectedInboxMemory` uses; `export const __inboxStoreWindowBindings`, whose `get()` returns the live `window` bindings by name (collections by reference) and whose `set()` reassigns the ones a window swaps by value. The copying (detached snapshots, refilling the const collections, `fresh()`) lives in `sim/windowSlots.ts`, so the store carries only the accessor |
| packages/web/store/gestureBridge.ts | U2 | `__gestureBridgeSimSlots()` for `sourceToken` |
| packages/web/store/syncTransaction.ts | U2 | `__syncTransactionIdleForTests(): boolean` |
| packages/web/store/viewNav.ts | U2 | `__viewNavSimSlots()` for `pendingSource`, `appliedNavCount` |
| packages/web/hooks/useEnsureDispatch.ts | U3 | calls `makeDispatchBinding(call, state)` and `applyDispatchFailure` from lib/dispatchBinding.ts (the `ackFlagSupported` latch moves into a `DispatchAckState` object; the hook shares one module-level object across mounts, as before). `store/__tests__/orgSlice.intents.test.ts` reads the failure handler's source, so its path points at lib/dispatchBinding.ts |
| packages/web/hooks/useSyncInboxSessions.ts | U3 | extract the floor watch-effect body, including its `logStamped` gate, as `export function runInboxFloorStep(convex, flags): void`, with the gate inputs from `export function inboxFloorFlags(state, principalId)`; the hook subscribes to the same flags and calls it |
| packages/web/hooks/useSyncTeamInboxSessions.ts | U3 | `export function applyTeamLivenessPayload(teamId, data)` and `teamInboxArgs(teamId)`; the hook calls them |
| packages/web/hooks/useSyncCollection.ts | U3 | `export function applyCollectionFeed(key, data, select?, syncOpts?)`; the hook calls it |
| packages/web/hooks/useBootstrapCollection.ts | U3 | `__bootstrapSimSlots()` for `done`. Like the U2 seams, it returns `{ get(), set(snapshot), fresh() }` over a snapshot keyed by binding name; `get` copies collections so the snapshot is detached, and `fresh()` is the state of a window that never ran |
| packages/web/hooks/useSyncChangeFeed.ts | U3 | `__changeFeedSimSlots()` for `cargoSupported`, `applyTally`, `flushTimer`, `shadowApplied` |
| packages/web/hooks/reconcileCrawl.ts | U3 | `__reconcileCrawlSimSlots()` for `states` (same shape) |
| .codecast/check.toml | U5 | `sim` entry |
| packages/web/package.json | U5 | `"sim": "bun scripts/sim.ts"` |
| packages/web/store/gestureBridge.ts, viewNav.ts | U7 | `fresh()` on the U2 seams, so every seam has the `{ get, set, fresh }` shape `windowSlots.ts` loads |
| packages/web/store/inboxStore.ts | U7 | the U2 seam's `recentThawTimer` slot type spelled out (`typeof recentThawTimer` narrowed to `null` there, failing `cast check sim`) |
| packages/web/hooks/useSyncChangeFeed.ts | U9 | `createCatchUpRunner(convex, { onError, onSettled })`: the hook's one-at-a-time catch-up guard (one queued rerun, the `range` in-flight gate), so the hook and a sim window run one copy |
| packages/web/hooks/useBootstrapCollection.ts | U9 | the effect body becomes `startBootstrapFloor(run)`, plus `bootstrapFloorKey`, `floorScopesStamped` and `bootstrapFloorFor(state, ...)` (one read of a window's state); the hook calls the same function |
| packages/web/store/syncReplication.ts | U9 | `followerActionTee(channel, selfId)` (the synced follower's mut tee) and `applyBridgedGesture(msg)` (the gesture receiver), extracted so production and the sim share them |
| packages/web/src/providers.tsx | U9 | the gesture bridge receiver calls `applyBridgedGesture` |
| packages/convex/convex/simBackend.testing.ts | U9 | `sessionDecisions` in `MODULES` |
| packages/web/store/__tests__/sim/windowSlots.ts | U9 | classifications for the 13 bindings the window's imports reach (message warming, the coarse-tick subscribers, the image URL cache, guest share tokens), each `shared` with its reason |
| packages/web/store/__tests__/inboxSimHarness.ts | U7 | the virtual clock now comes from `sim/realm.ts` and is re-exported; two type errors it carried from before Phase 2 (the comparer's `platform` label, a nullable `set_digest`) fixed so `cast check sim` is green |
| packages/web/hooks/useWorkspaceCollection.ts | U11 | `export function activeWorkspaceKeyOf(state)`, the active workspace key off store state; the hook's four call sites use it and INV-workspace-rows reads it |
| packages/convex/convex/chat.ts | U11 | `MENTION_WAKES_PER_SENDER_HOUR` and `MENTION_WAKES_PER_TARGET_HOUR` exported, for INV-chat and INV-ping-pong |
| packages/shared/contracts/__fixtures__/teamWorldGen.ts, teamWorldGen.test.ts | U11 | `agent_tasks`: one armed trigger behind each generated `armed_trigger_kind` (`triggerIdFor`), so INV-triggers holds from genesis |
| packages/web/store/__tests__/sim/window.ts | U11 | `refeed()` (the read-your-writes loop now calls it) and a `feeds` getter (live feeds plus bootstrap floors) |
| packages/web/store/__tests__/sim/world.ts | U11 | genesis inserts `gen.agent_tasks`; `sweepFindings()` delegates to `scopeSweep` |
| packages/web/store/__tests__/sim/net.ts, world.ts | U12 | `afterDeliver` option (net) and its `WorldOptions` passthrough, awaited after each delivery: the DSL's always-mode checks |
| packages/web/store/__tests__/sim/report.ts | U12 | `renderDeliveries` exported, so `SIM_TRACE` streams the report's own row format |
| packages/web/store/__tests__/sim/invariants.ts | U12 | `MENTION_PREFIX`, `mentionTarget` and `windowContext(w)` exported (checkInvariants uses `windowContext` too), for `wokenTimes` and point-check reports |
| packages/web/store/__tests__/sim/actors.ts | U13f | `agent(s).says` takes `{ thread }`, so agents can answer in a thread as the wake text tells them to |
| packages/web/store/__tests__/sim/invariants.ts | U13f | `INV-ping-pong` also counts `chat-relay:` rows carrying an agent's line (the mention-reply relay), which it missed |
| packages/web/store/__tests__/sim/window.ts | U13d | `tail(conversationId)` (the transcript tail, returning its channel) and `coverage()` (one pass of the pending-send coverage poll); `refeed()` skips held feeds |
| packages/web/store/__tests__/sim/net.ts | U13d | `held(channel)`: lagged, or a channel of an offline window |
| packages/web/hooks/usePendingMessageCoverage.ts | U13d | `reconcileStorePendingCoverage(query, isCurrent)`, the store-applying pass the hook and the sim window share |
| packages/web/store/__tests__/sim/windowSlots.ts | U13d | `useConversationMessages.ts:LIVENESS_ONLY_CONV_FIELDS` classified (constant), reached through `mergeUnconfirmedMessages` |
| packages/web/store/__tests__/inboxSimHarness.ts | U14 | thin adapter over sim/ |
| packages/web/store/__tests__/inboxConvergenceSim.test.ts | U14 | imports; failures through report.ts |
| packages/web/store/__tests__/inboxMultiWindowSim.test.ts | U14 | same; one `it.failing` on ct-56048, and the heal pin names the seeds ct-56048 makes heal and keeps its old bound over the rest |
| packages/web/store/__tests__/sim/net.ts | U14 | `ChannelFilter`: `step(only)`, `drain({ only })`, `queued(only)`; a step scans only channels with queued deliveries, and scripted mode takes the first ready channel in one pass |
| packages/web/store/__tests__/sim/realm.ts | U14 | `runInWindowSync`; a window's slots are saved, and the memo slots reset, only when another window takes a turn; a turn settles by draining the microtask queue; the facade's methods are getters over one target |
| packages/web/store/__tests__/sim/window.ts | U14 | `catchUp()`; optional world hooks `settleBoot` and `holdCatchUp` |
| packages/web/store/__tests__/sim/actors.ts | U14 | `makeActors` takes `ActorWorld`, the structural surface its verbs use |
| packages/web/store/__tests__/sim/report.ts | U14 | optional `replay` lines in `FailureContext` |
| packages/web/store/__tests__/sim/windowSlots.ts, packages/web/store/inboxStore.ts | U14 | `_lastParityCheckAt` and the placement caches are `window` slots (the U2 seam carries them), so the dev parity check keeps its per-window throttle and a window's next turn reuses its own caches; the memo resets and `syncTransaction` are loaded once with the seams |
| packages/convex/convex/simBackend.testing.ts | U14 | the wire pair in one pass, one wired copy per memo miss or hit, resolved functions cached per backend (section 3.2) |
| packages/web/hooks/useInboxDigestCompare.ts | U14 | `startInboxDigestCompare(convex, subscribeTick, io?)` |
| docs/architecture/sync-convergence.md | U15 | Validation plan points at sync-sim.md |
| docs/architecture/sync-host.md | U15 | Invariants section names `INV-followers`, `INV-fixpoint` |
| .github/workflows/ci.yml | U15 | `SIM_OUT` plus failure artifact upload in `test-web` |
| packages/web/hooks/useLiveInboxSessions.ts, useSyncInboxSessions.ts, useSyncTeamInboxSessions.ts, useInboxDigestCompare.ts | review | `applyInboxListPayload`, `applyMineLivenessPayload` and `applyTeamListPayload`, called by every subscription, recovery probe and the digest comparer's heal, and by the sim host, so no feeder keeps its own copy of an apply |
| packages/web/store/syncReplication.ts | review | `replicationHostFor`, `replicationFollowerFor` and `promoteToHost` (the runtime options and the promotion order), shared by `startSyncReplication` and `sim/device.ts` |
| packages/web/store/inboxStore.ts | review | the U2 seam shrinks to `__inboxStoreWindowBindings` (live bindings plus a by-value setter); the copying moves to `sim/windowSlots.ts`, `resetMemos` goes, `freshInboxData` is local again |
| packages/shared/contracts/pendingStatus.ts, packages/cli/src/daemon.ts | review | `pairDeliveryAcks(pasted, transcript)`, the daemon's newest-suffix pairing, which the sim daemon's `ack` calls too |
| packages/convex/convex/lib/chatWakeIds.ts, chat.ts | review | the chat wake client ids (`chatMentionClientId`, `chatRelayClientId`) and their parsers, written by chat.ts and read by the sim's invariants |

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
- `cd packages/convex && bun test convex/` shows the same fail count as before the change, and a pass count larger only by `simBackend.test.ts`'s tests plus the two `moduleLoad.test.ts` entries it adds for the new `.testing.ts` files. Record both.
- `cast check convex` is green.
- `grep -c "bun:test" packages/convex/convex/*.testing.ts` gives 0.

**U2 Store seams.** `inboxStore.ts`, `gestureBridge.ts`, `syncTransaction.ts`, `viewNav.ts`.

What it builds: the exports in section 4. There is no behaviour change. `clearProtectedInboxMemory` now calls the local `freshInboxData()`.

Acceptance:
- `cast check web` is green.
- `bun test store/__tests__/inboxStore.test.ts store/__tests__/cacheOwnership.test.ts store/__tests__/gestureBridge.test.ts store/__tests__/hotReloadReset.test.ts` passes (from packages/web).
- A new assertion in an existing file is not allowed (to keep units disjoint). So U2 adds `store/__tests__/storeSeams.test.ts`. It asserts that two `__createInboxStoreForTests()` instances hold distinct `_setDispatch` closures: binding one does not make the other's `_isDispatchWired()` true. It also asserts that a new instance starts from the module store's data floor with its own copy, and that the inbox window bindings round-trip through the sim seam as detached snapshots.

**U3 Hook extractions.** `lib/dispatchBinding.ts` and its test, plus `useEnsureDispatch.ts`, `useSyncInboxSessions.ts`, `useSyncTeamInboxSessions.ts`, `useSyncCollection.ts`, `useBootstrapCollection.ts`, `useSyncChangeFeed.ts`, `reconcileCrawl.ts`.

What it builds: each extraction is called by its own hook with identical arguments, so exactly one copy exists. `dispatchBinding.test.ts` covers:
- unwrapping `__syncAckV1` calls `stampSyncAck` with patches and `sentAt`;
- an `ArgumentValidationError` naming `ack_positions` latches off and re-issues the call unflagged;
- `applyDispatchFailure` marks the optimistic send failed.

Acceptance:
- `cast check web` is green.
- `bun test hooks/ lib/__tests__/dispatchBinding.test.ts` passes, with the same count as before plus the new tests.
- `grep -n "__syncAckV1" packages/web/hooks packages/web/lib -r` hits only `lib/dispatchBinding.ts` and its test.

**U4 Team world generator.** `teamWorldGen.ts` and its test.

What it builds: section 3.6. The test pins `sha256(JSON.stringify(genWorld(s, n, inboxEpoch(1_800_000_000_000), me)))` for every seed the legacy suites use: the web sims' `seededWorld` seeds (11, 21-32, 41-43, 51, 52, 61, 71, 72, 81-92, 101, 102, 111) at 45 rows with `me = "u" x 32`, and the convex convergence seeds (500-513 at 90 rows, 77 at 10, 9 at 40) with `me = "users_me"`. Rows draw from one stream in order, so a smaller count is a prefix of the pinned one (`seededWorld(31, 30)` is the head of seed 31's 45 rows). Capture the hashes before writing the generator. It also asserts that no two users' conversation ids or tags collide across seeds 1-50.

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
- A follower `kill` replicates to the host, reaches `dispatch:dispatch`, and the ack retires the lock. The lock is the acting follower's: the response stamps its position on it and the host's replicated cursor retires it. The host's mirrored locks for the same gesture take no ack for fields the follower never dispatched (the stash fields, the `sessions` twins), and with values that already match the server they get no echo either; on a host only the digest comparer's heal releases a settled lock. That is production behaviour, judged by `INV-pending-locks`, so the self-test asserts only that the host holds no acked lock and no longer shows the row.
- Two windows of one device keep distinct outbox closures: one goes offline with a queued dispatch, the other stays wired.
- `dropResponse` plus `online()` delivers exactly once, through the server receipt.

Acceptance: `SIM_SCENARIO=nomatch bun test store/__tests__/sim/sim.test.ts` passes and `cast check sim` is green. `SIM_SCENARIO=nomatch` imports no self-test either, so also run `SIM_SCENARIO=window` and the unfiltered file.

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
- If it fails, file a task under pl-810 (`cast task create "<finding>" --plan pl-810`) with the report block and the `--order` line, and add `red: { task: "<ct-id>", invariant: "<the id the report names>" }`, scoped with `modes` and `seeds` when only some runs reach it. A bug that trips before the scenario's own checks goes in `known:` instead. Rerun and confirm the report header reads `sim failure (expected, red: <ct-id>)`.
- Finally, `bun run sim <name> --sweep 20` shows no harness errors.

**U14 Legacy port.** `inboxSimHarness.ts`, `inboxConvergenceSim.test.ts`, `inboxMultiWindowSim.test.ts`.

What changes:
- `Replica` wraps one `SimWindow`, and `Device` one `SimDevice`. `REPLICA_KEYS`, `freshReplicaState`, `dispatchPending` and `dispatchTouched` are deleted: a gesture is the store action, and the window's own dispatch binding reaches `dispatch:dispatch`.
- The suites choose when each payload arrives, so a replica's live feeds stay lagged on the net. `receiveBase`, `receiveOverlay` and `receiveDecisions` deliver one push of a feed, `catchUp` runs the window's catch-up runner (`w.catchUp()`), and `crawl` runs the floor step, catching up first while the log is unstamped (the floor waits for the stamp). The server world sets `holdCatchUp` and `settleBoot`, so a boot starts no catch-up and moves neither the clock nor another device's queue. After every step the server traffic (`conn:`, `timer:`, `sched`, `actor:`) is flushed without moving the clock (`net.drain({ horizonMs: 0, only })`); a device's window traffic (`repl:`, `bridge:`) waits for `Device.deliver(n)` or `drain()`. `state`, `cursor`, `tick()` and the placement reads are synchronous turns (`runInWindowSync`).
- `SimServer` is the `SimWindowWorld`: the backend seeded with the generated world (each conversation's `_creationTime` is its `started_at`), its net, and the world surface the actors need. `mutate/insert/delete` go through `makeChangeTrackedDb`, and an inserted row keeps the id the suite chose (through `mintId`). `range/head` read the real `sync_actions` and `sync_heads`. `retain(upTo)` runs `syncLogPrune:pruneSyncActions` with the clock moved so its cutoff passes the timestamp of the last action at or below `upTo`, then moves the clock back. Retention is by time, so actions that share that timestamp (the clock stands still between steps) go too.
- `SERVER_EVENTS` are async, so the call sites await them (and `mutate`, `insert`, `delete`, `retain`, `setAgent`):
  - `otherDevicePins/Dismisses/Stashes/Restores` are a second host window's store action (`pinSession`, `killSession`, `stashSession`, `restoreSession`). Before each one that window reads the row it acts on through the byIds path (`applyEntityIds`);
  - `agentSettles`, `agentDeclaresDone` and `agentStarts` are the daemon's `updateAgentStatus` under the user's api token, through the actors' daemon verb (`actors.ts` takes a structural `ActorWorld`, which `SimServer` satisfies). The churn exemption now applies; `agentStarts` keeps its churn-only turn patch;
  - `gcDeletesBlank` inserts a blank row created past the 24h grace (70% of draws) or just now, then runs `cleanup:gcEmptyConversations`;
  - `newSession`, `daemonDies`, `triggerArms`, `userParks`, `apiErrorBanner` and the two decision events stay direct writes, through the change-tracked db.
- The comparer is the window's own `startInboxDigestCompare`, with `io` overrides that collect its telemetry in `events` and queue its heals for `drainHeals`. `settleAndAssertConverged` reports a divergence or a placement mismatch through `report.ts` (`reportFailure`, with its own `SIM_SEEDS` replay line).
- Exports keep their names. Seeds are unchanged. Realm timers are net deliveries, so the zombie test waits on `a.flush()` instead of two `setTimeout(0)` awaits, and the suites' default timeout goes from 120s to 300s. That is for machine load, not the port: at load 314 the pre-port multi-window suite's own randomized test passed 120s (2026-10-01), and the port runs about 1.2x to 1.35x the pre-port wall time side by side.

Outcomes on the new substrate (recorded in ct-55688):
- Every convergence seed (21 to 32) and every fixed convergence test keeps its outcome; no seed needs the heal.
- `a restore elsewhere reaches every window through the log` (seed 72) passes. It was red on ct-56048 until the host kept the bridged acknowledgement on the kill's locks: the follower's replicated write re-planted them without it, so no ack and no echo retired them and B's restore could not land on A.
- The randomized multi-window seeds converge, and the pin (fewer than half the seeds heal) holds over all twelve. Seeds 83 and 86 still take one host heal.

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
| visibilityFlip | acme {ada, bo}; ada session s is private, with a linked task t | ada `setPrivacy(s, team)`, settle, then back to private | bo's team slot gains and then loses s; after the flip back, `bo cannotRead(t)`; `INV-sweep` is clean | passes in every mode and seed of a 20-seed sweep (sweep seed 174197 found ct-56051, now fixed) |
| viewerHideVsOwner | ada session s, team-visible and working; A = ada (1 follower), B = bo (scope acme) | B.host `kill(s)`; ada.daemon `settles(s)` | `inbox_hides` row for bo; `A shows s` with an unchanged status; B's team slot excludes s | **red** ct-56045 on `expect.shows`, interleave seed 239423 (bo's inbox floor probe prunes the team row it fed in before the floor, a durable exclude); known INV-fixpoint (ct-56011) |
| reapVsFollowerLock | ada's empty s (message_count 0, a live managed session); A has 1 follower | the follower kills s; ada.daemon heartbeats during the dispatch; the clock passes the 24h empty-row grace and `cleanup:gcEmptyConversations` fires (a kill of an empty row only queues the teardown; the gc reaps the row) | the row is gone on the server and in every window; no lock survives; cursors equal heads | passes in every mode and seed of a 20-seed sweep. It was red on ct-56048: the bridged hide planted fields the follower's kill never wrote, and the host's re-plants dropped the bridged acknowledgement. Getting to settle #2 also found that a follower kept a fact the host's overlay had cleared (replicated rows now carry facts verbatim) |
| queuedSendVsLaggingTail | ada's s is working; A mounts the tail of s (`A.tail(s)`) | lag the tail's channel; ada `send(s)`; daemon `claimPending` then `ack` (paste, the transcript echo wrapped in `<pasted_content>` as Claude Code writes it, and the ack with `delivery_acks` paired by `pairDeliveryAcks`), twice; `A.coverage()`; release | the send renders exactly once (`mergeUnconfirmedMessages`): the settled bubble while the tail lags, the echo after; each `client_id` unique | passes in every default run; sweep seed 157409 fails INV-sessions-mine on ct-56054 |
| roleTriggerScope | acme with the org flag, role anchor R; bo's s filed under R (`orgRoles:reparentSession`); ada and bo feed `agentTasks` from `webList` | daemon `updateAgentStatus(permission_blocked)` twice at one message count, with a `working` turn between (a `waiting` settle schedules no needs-input check, so it never reaches R) | one role event per `hand_wake_notified_key`; `INV-triggers`; ada and bo each see only the triggers `webList` returns | passes in every mode and seed of a 20-seed sweep. It was red on ct-56051 at interleave seed 114430 (bo's generated parent sat in Questions on the server only, lifted by a teammate the replica never held) |
| agentPingPong | two agent sessions in acme (ada's and bo's, chat on) mention each other by short id | the opening line, then `agent.says` replies in its thread in a loop; clock advances 1h | caps hold; settle quiesces within budget | **red** ct-56047 on `INV-ping-pong` (the mention-reply relay never takes the hourly caps, about 30 wakes per sender per hour) |
| personalAnchorOwnedByTeammate | ada's personal standing session (private, `persistent`); ada adds bo as a second owner through `sessionOwnership:addSessionOwner` before the devices boot | bo `pin`, then `kill`; the clock moves past `HIDDEN_OVERRIDE_SETTLE_MS` | bo's ack retires the lock (`INV-pending-locks`) | **red** ct-56044 on `INV-pending-locks` (second-party owner fan-out gap); known INV-fixpoint (ct-56011) |
| twoHumansOneRole | ada and bo in acme (chat and org on), role R | both `tellRole(R)` 200ms apart, in two rounds: ada first, then bo first (the DSL has no in-scenario order mode, so scripted pins both orders and the interleave seeds race them) | two wakes per round (`wokenTimes`); the hourly `mention_to` counter equals the wakes (`INV-roles`); R's standing session takes its wakes, oldest first, in channel order (and in scripted runs from ada, bo, bo, ada). The file notes OCC is not covered. | passes in every mode and seed of a 20-seed sweep, INV-fixpoint included (ct-56011, ct-56053 and ct-56050 fixed) |
| memberRemovedMidTurn | acme (org on, role R) {ada, bo}; ada's team-visible s with a task t; bo's s is working; device B (scope acme) feeds the acme task floor and the anchor list; B's team list lands after its first inbox floor (the other order is ct-56045, guarded by viewerHideVsOwner) | B goes offline; admin `remove(acme, bo)`; B kills ada's s while it still holds it; B comes back online | B purges acme rows, tasks and the acme anchor (no unreadable row); acme cursor gone; the server refuses the kill silently (dispatch's viewer hide checks `canAccessConversation`, so no `inbox_hides` row and no error), and B's outbox drains; anchor list check (`INV-roles`) holds | known INV-fixpoint (ct-56354: the task's first byIds adds the comments the task list never carries); every run of a 20-seed sweep passes with it left out (sweep seed 473531 found ct-56051, now fixed) |
| resumeVsSend | ada's two parked (hibernated) sessions s1 and s2, owned by her daemon's device; her window has both transcript tails open | ada `send(s1)` then daemon `resume(s1)`; daemon `resume(s2)` then ada `send(s2)`; the daemon polls, pastes, echoes and acks, then polls again | one delivery; one `client_id` on one pending row and one transcript line; bubble settles | passes in every default run; ct-56054 (overlay ships the derived agent_status as the fact) shows on some sweep seeds |
| daemonRestartParked | ada has 3 parked (hibernated) sessions, each keyed by its `session_id`, one live working session, and a due trigger on a parked one | daemon heartbeat gap past `HEARTBEAT_ALIVE_MS`; `restart` of the live pane only (parking kills a pane, so the warm restart in daemon.ts cannot recover it); `claimTask` | no duplicate sessions; parked rows stay dormant during and after the gap, the live row is working again; `armed_trigger_kind` is consistent | passes in every mode and seed of a 20-seed sweep |

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Facade rebinding misroutes.** Something captured the zustand api or `getState` at load. | Verified today: no production module captures `getState`. `realm.selftest` asserts that routing covers the `store` proxy. The slots guard also flags new top-level bindings that hold a function taken from `useInboxStore`. |
| **Async work escapes a window.** A continuation outlives `runInWindow` and lands after the facade is unbound. | Per-instance closures (dispatch, tees, outbox) use their own `get/set`, not the facade. `runInWindow` drains the microtask queue before its turn ends. Timers created in a window are tagged and re-enter it. In trace mode, any facade read with no active window throws `sim: store read outside a window`. |
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