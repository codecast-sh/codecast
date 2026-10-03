# Sync sim: several people, several windows, one process

The multiplayer simulation harness runs several principals (people, their daemons, their agents, a team admin), each with one or more browser windows, against the real Convex handlers and the real client sync code, inside one bun process. After every settle it checks a catalog of convergence and access invariants, and when one fails it prints a report a person can read and replay.

This is the operating manual. The design and the reasons behind it are in [multiplayer-sim-harness.md](multiplayer-sim-harness.md) (Phase 2 of pl-810). The single-user convergence argument the sim extends is [sync-convergence.md](sync-convergence.md), and the host and follower protocol it models is [sync-host.md](sync-host.md).

Everything lives under `packages/web/store/__tests__/sim/`, plus the server router in `packages/convex/convex/simBackend.testing.ts`.

## Running it

From `packages/web`:

| Command | What it does |
|---|---|
| `bun run sim` | every scenario, every self-test, and the pure sim tests (net, report, the window-slot guard) |
| `bun run sim visibilityFlip` | only the scenario and self-test files whose name contains `visibilityFlip` (it runs `sim.test.ts` alone; a filter that names no file is refused with the closest names) |
| `bun run sim --list` | the scenario catalog (name, red markers, known invariants, modes, file), read statically |
| `bun run sim --invariants` | the invariant catalog (id, meaning), read statically |
| `bun run sim visibilityFlip --seed 174182` | pin the seeds (comma separated) |
| `bun run sim visibilityFlip --sweep 20` | run 20 interleave seeds instead of 2 |
| `bun run sim visibilityFlip --seed 174182 --trace bo-host` | stream every delivery whose channel, label or producer names `bo-host` |
| `bun run sim --red` | only the scenarios with a red marker or a known invariant |
| `bun run sim visibilityFlip --out /tmp/sim-out` | write the run artifacts on a pass too |
| `bun run sim visibilityFlip --seed 174182 --order "<channels>"` | replay one delivery order, pasted from a report |
| `bun run sim --help` | every flag |

The runner (`scripts/sim.ts`) only turns flags into environment variables and spawns `bun test store/__tests__/sim/ --isolate`, or with a filter `bun test store/__tests__/sim/sim.test.ts --isolate`. The variables are the source of truth, so `SIM_SCENARIO=visibilityFlip bun test store/__tests__/sim/sim.test.ts --isolate` does the same thing:

| Variable | Flag | Meaning |
|---|---|---|
| `SIM_SCENARIO` | the filter | import only files whose name contains it |
| `SIM_SEEDS` | `--seed` | pin the seeds |
| `SIM_SWEEP` | `--sweep` | interleave seeds per scenario |
| `SIM_TRACE` | `--trace [label]` | stream deliveries whose channel, label or producer names the label, or all of them for `1`; it also turns on the strict store facade, which throws on a store read outside a window |
| `SIM_RED` | `--red` | register only scenarios with a red marker or a known invariant |
| `SIM_OUT` | `--out` | artifact root, written on a pass too |
| `SIM_ORDER` | `--order` | replay one channel order |
| `SIM_SELFTEST` | none | `0` skips the self-tests |

Put the filter before `--trace`: a bare word after `--trace` is read as its label. `--trace=label` also works. Deliveries name windows, channels, functions and actor verbs, not rows, so a window name (`bo-host`) streams everything that window did, while a row label (`ada/s`) matches only the verbs that name it.

A filtered run takes about 15 seconds on a loaded laptop, most of it importing the store and convex once; the whole sim (every scenario and self-test) about 80 seconds.

Typecheck the harness with `cast check sim` (its tsconfig adds bun types and covers the legacy sims and `scripts/sim.ts`). The convex half is in `cast check convex`.

## Layers

```
scenario files (DSL verbs, point checks)      sim/scenarios/*.scenario.ts
  -> actors: human, daemon, agent, admin,     sim/actors.ts
     clock
  -> world: genesis, labels, devices          sim/world.ts + shared teamWorldGen
  -> devices and windows: one store instance  sim/device.ts, sim/window.ts
     per window, feeders, catch-up, floor,
     dispatch, replication, gesture bridge
  -> net: channels, scheduler, budgets        sim/net.ts
  -> realm: clock, timers, randomness, the    sim/realm.ts, sim/windowSlots.ts
     store facade, per-window module state
  -> server router: auth, single flight,      convex/simBackend.testing.ts
     journal, scheduler, memo, validation     convex/simValidate.testing.ts
  -> the real Convex handlers over a fake db  convex/*.ts, convex/testDb.ts
invariants, reports, labels                   sim/invariants.ts, report.ts, labels.ts
```

**Server.** `makeSimBackend` resolves a function reference to its module through a literal lazy map (`MODULES` in `simBackend.testing.ts`) and calls its real `_handler`. A module a real handler reaches must be listed there; an unknown name throws with the nearest real name. Arguments are validated against the function's own validator and cross the `convexToJson` boundary, so no client object aliases a server row. Top-level calls run one at a time, each mutation inside a journal that rolls back on a throw (sync log rows included). `ctx` provides what production gives that kind of call and throws on anything else (`sim ctx: ... Add it in makeCtx.`). Scheduled jobs reach the world only when their mutation commits, and run as `sched` deliveries under the system principal. The four inbox reads are memoized on (principal, args, write count, epoch minute).

**Realm.** One virtual clock behind `Date.now` and `performance.now`. `Math.random` and `crypto.randomUUID` draw from the stream of the store being built, else the running server call's, else the active window's, else the world's, so interleaving one window never shifts another's draws and a store that draws as it is built moves only its own stream. `setTimeout` and `setInterval` become net deliveries owned by the window that armed them, and run inside that window's turn. The `useInboxStore` facade points at the active window's store instance while that window runs.

**Windows.** Each window is its own `createInboxStore` instance with its own engine closure (dispatch binding, outbox, tees). Module state that production keeps per page (held overlay facts, change-feed tallies, crawl state and so on) is saved and restored per window through `sim/windowSlots.ts`. Its guard test fails on any top-level `let`, `var`, `Map` or `Set` reachable from the sim that the table does not classify, and prints the line to add. A host window mounts the production feeders (inbox base list, liveness overlay, decisions, team list and team liveness in team scope, sync log heads), runs the real `catchUp`, and runs the inbox floor step. A follower mounts no feeders and joins through the engine's replication runtime, exactly as `sync-host.md` describes.

## Protocol rules

Every event in a run is a delivery on a named channel:

| Channel | Carries |
|---|---|
| `conn:<win>` | a window's request and its response, as two deliveries |
| `live:<win>:<feed>` | a live query push to a window |
| `repl:<from>><to>` | a replication post between two windows of one device |
| `bridge:<dev>:<from>` | a gesture bridge post to the device's other windows |
| `timer:<owner>` | a timer a window (or `global`) armed |
| `sched` | a scheduled job or a cron |
| `actor:<name>` | one actor verb |

The rules the net enforces:

- A channel is FIFO. A delivery due later never blocks one due earlier.
- A delivery is ready when its due time has come and its channel is neither lagged nor held by an offline window.
- `scripted` mode runs the lexicographically first ready channel. `interleave` mode picks a seeded ready channel, so it permutes only across channels. `order` mode follows a recorded channel list and fails with `net.order-mismatch` when the listed channel is not ready; once the list runs out it continues as scripted.
- A request runs the handler and commits. Its response runs inside the window's turn and, for a mutation, first refreshes every live feed of that window (read-your-writes).
- After any delivery that writes, every mounted live channel is marked dirty, at most one pending push each. A push recomputes the query when it is delivered, so intermediate versions may be skipped, as production allows.
- `drain` runs until nothing is ready, then moves the clock to the next armed timer or job within the horizon (twice `HIDDEN_OVERRIDE_SETTLE_MS`), and stops when nothing more is due inside it.
- An offline window's `conn:` and `live:` channels hold their events and never pull the clock forward. Coming back online re-drives the window's parked dispatches.

## Writing a scenario

A scenario is one file in `sim/scenarios/`, picked up by glob; nothing else needs editing. A minimal one:

```ts
import { scenario } from "../dsl";

scenario({ name: "visibilityFlip" }, async (w) => {
  w.team("acme");
  w.user("ada", ["acme"]).user("bo", ["acme"]);
  const s = w.session("ada", "s", { private: true });
  const t = w.task("t", { owner: "ada", session: s });
  const ada = await w.device("ada");
  const bo = await w.device("bo", { scope: { team: "acme" } });

  await w.human(ada.host).setPrivacy(s, "team");
  await w.settle();
  await w.expect(bo.host).shows(s);

  await w.human(ada.host).setPrivacy(s, "private");
  await w.settle();
  await w.expect("bo").cannotRead(t);
});
```

`name`, `red`, `known` and `modes` must be literals, because `--list` reads them without importing anything.

**Declarations** come before the first async verb, which runs genesis once:

| Declaration | Label it creates |
|---|---|
| `w.team(name, { features })` | `<team>`; chat scenarios need `features: { chat: true }`, role scenarios `org: true` |
| `w.user(name, teams)` | `<user>`; the first team listed is the user's team, and a team's first declared user is its admin |
| `w.session(user, name, { private, agentStatus, row })` | `<user>/<name>` |
| `w.task`, `w.doc`, `w.plan(name, { owner, session })` | `task:<name>`, `doc:<name>`, `plan:<name>` |
| `w.trigger(name, { owner, session, runInMs })` | `trigger:<name>` |
| `w.role(team, handle)` | `role:<team>/<handle>` |

Genesis builds the rows through the real create mutations and the real visibility chokepoint, and refuses to start unless `teamScopeSweep` finds every work item's stored workspace key correct. Rows real mutations insert later are labelled `<table>#<n>`.

**Devices and windows.** `await w.device(user, { followers, scope, name })` boots a host window (`<device>-host`) and N followers (`<device>-w<n>`). `scope` is `"mine"` (the default) or `{ team: "<team>" }`. On a device: `addWindow`, `closeHost()` (promotes the first follower, as a released Web Lock does), `closeWindow(w)`. On a window: `feed(key, query, args)` and `bootstrap(key, query, args)` opt into a registered feed or a bootstrap floor, `chatPage(channelId)`, `tail(conversationId)` (returns its `live:` channel), `coverage()` (one pass of the pending-send coverage poll), `recoveryPoll()` (one pass of the inbox recovery polls, which the world also runs on every host after `advance` of 15s or more), `dropResponse(n)` (the next n mutation responses fail after the commit).

**Verbs** return a `Step`. Awaiting it drains the net in scripted mode and returns at once in interleave mode, so the same file races its verbs under interleave.

| Actor | Verbs |
|---|---|
| `w.human(window)` | `kill`, `stash`, `restore`, `pin`, `revive(s, text?)`, `send(s, text)`, `setPrivacy(s, "private" \| "team")`, `chat(channel, text)`, `tellRole(role, text)` |
| `w.daemon(user)` | `settles(s, status?)`, `heartbeat(s, status?)`, `restart(sessions)`, `claimPending(s?)`, `ack(s)`, `resume(s)`, `claimTask(trigger?)` |
| `w.agent(session)` | `says(channel, text, mentions?, { thread? })` |
| `w.admin(user)` | `remove(team, user)` |
| clock | `w.advance(ms)` |

Each verb takes the path production takes: a human verb is the store action a component calls, which reaches `dispatch:dispatch`; a daemon verb is the mutation `packages/cli/src/syncService.ts` sends, under the user's API token. A server refusal is an outcome (it lands in `w.actors.log` and `w.backend.calls`); an error the sim itself raises (`sim client:`, `sim server:`, `sim ctx:`, `sim world:`) is a harness gap and fails the test.

**World controls.** `w.settle()` drains and runs the whole catalog. `w.interleave(n)` runs n deliveries by the interleave rule. `w.cron(name, args)` fires an internal function as the scheduler would. `w.net.lag(channel)` and `w.net.release(channel)` hold and free one channel; `w.net.offline(name)` and `w.net.online(name)` take a window (by name, `bo-host`) off and on the network.

**Point checks.** Each settles first, then reports under the id `expect.<check>`:

- `w.expect(window).shows(label, { bucket? })` and `.hides(label)`: among the window's active rows in its own scope.
- `w.expect.server.row(label).has({ ... })`, `.gone()`, and `w.expect.server.gone(label)`.
- `w.expect(user).cannotRead(label)`: the server refuses it and no window of the user holds the id anywhere.
- `w.expect("role:<team>/<handle>").wokenTimes(n)`: chat mention wakes enqueued for the role.
- `w.inspect(label)`: prints and returns the server row and every window collection holding it.

**Options.** `scenario({ name, red?, known?, seeds?, modes?, budget? })`. `red` is one marker or a list, `{ task, invariant, modes?, seeds? }`: the bug a run ends in, the invariant or point check id it fails with, and (optionally) the runs that reach it. `known` maps an invariant id to the task (or tasks) whose bug trips it in every run; the runs leave it out. Both are explained under Red list. `budget` raises the delivery or write limit for one scenario.

## Invariant catalog

Every `settle()`, every point check, and the end of every run check the whole catalog; every delivery that touches a window also checks the cheap `always` rules over that window. Each oracle is real code. `bun run sim --invariants` prints the live list.

| id | Holds when | Oracle |
|---|---|---|
| `INV-sessions-mine` | the window's mine digest, tally and placements equal the principal's canonical projection | `conversations:sessionsLiveness` as the principal |
| `INV-followers` | every follower holds the host's replicated slice byte for byte | engine `snapshotEntries` over `REPLICATED_STORE_KEYS` |
| `INV-team-inbox` | the team slot holds exactly the server's team list for the viewer, minus the viewer's own hides | `conversations:listTeamInboxSessions` |
| `INV-workspace-rows` (always) | the window holds no task, doc, plan or project its principal cannot read, and each fed collection matches the server in the active workspace | `accessStampFor`, `authorizedFor`, `heldKeysFor` |
| `INV-sweep` | no work item's stored workspace key disagrees with its computed one, and the sweep writes nothing | `teamScopeSweep:sweepPage` with `apply: false` |
| `INV-cursors` | each held sync-log scope's cursor stands at its head, and no unheld scope has a cursor | `syncLog:getHeads` |
| `INV-pending-locks` | no acknowledged lock survives its cursor, and no field lock outlives the settle window | the window's `pending` slot |
| `INV-outbox` | every window's engine outbox is empty once the world settles | the engine outbox |
| `INV-triggers` | the trigger replica equals `agentTasks:webList`, and each conversation's armed kind matches its live triggers | `armedTriggerKindFor` |
| `INV-pending-sends` (always: uniqueness) | every send bubble is echoed, settled or failed, and each `client_id` is on at most one `pending_messages` row | server rows |
| `INV-chat` (always: dedupe and caps) | the chat replica equals `chat:listMessages`, each mention wakes its target once, and the hourly wake caps hold | `MENTION_WAKES_PER_*_HOUR`, `hourBucket` |
| `INV-roles` | each role's mention wake counter equals the wakes enqueued for it, and `listAnchors` equals `visibleAnchorsForUser` | `anchors.ts`, chat quota rows |
| `INV-ping-pong` | agent to agent wakes per virtual hour stay under the mention caps, per sender (the person for a mention, the replying session for a relayed reply), per person (one sender cap plus one per session they own) and per target | `pending_messages` rows |
| `INV-row-shape` | every sessions row holds only the inbox row's fields (`INBOX_ROW_FIELDS` plus the facts), or a field a pending local write holds | `INBOX_ROW_FIELDS`, pinned by a convex test to what the feeders write |
| `INV-fixpoint` | re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing | the feeders themselves |

A coverage guard (run by the invariants self-test) fails for any `REPLICATION_CLASSIFICATION` key that no rule compares and that `NOT_COMPARED` in `invariants.ts` does not excuse with a reason. A new synced collection therefore needs either a rule or a reason.

## Reading and replaying a failure

A failure prints one block:

```
sim failure: visibilityFlip [scripted seed 174182] at step "expect window bo-host hides ada/s", delivery 22
  INV-fixpoint: re-running every mounted feeder, one catch-up and a byIds pass over every held id changes nothing
  sessions[ada/g1] was written on a refeed: remove owned_by_me
  window ada-host (principal ada, scope mine)
  row ada/g1 (conversations)
    owned_by_me  server (absent)  replica false
  last 12 deliveries:
    #17  +0ms  conn:bo-host               req query syncLog:getHeads                          by bo-host syncLog:getHeads
    #18  +0ms  conn:bo-host               res syncLog:getHeads                                by bo-host syncLog:getHeads
    #19  +0ms  conn:bo-host               req query conversations:listInboxSessionsPaginated  by bo-host conversations:listInboxSessionsPaginated
    ...
  replay:
    bun run sim visibilityFlip --seed 174182 --trace ada/g1
    bun run sim visibilityFlip --seed 174182 --order "scripted conn:ada-host conn:ada-host ..."
  artifacts: $TMPDIR/codecast-sim/visibilityFlip-scripted-174182
```

- Ids print as labels everywhere (`ada/s`, `task:t`, `pending_messages#3`); an unknown id prints as its first 8 characters.
- The row diff shows fields only, key order blind, and never prints a field in `PAYLOAD_DENYLIST`.
- The first replay line reruns the seed and streams the deliveries that name the row, which is often only the actor verbs; trace the window the report names (`--trace ada-host`) to see everything it did. The second line replays the exact channel order and fails at the same step and delivery. A scripted run's order starts with the word `scripted`, which tells the replay to drain after each verb as the recorded run did.
- Artifacts go to `$SIM_OUT/<scenario>-<mode>-<seed>/`, or under `<tmpdir>/codecast-sim/` when `SIM_OUT` is unset: `result.json` (the facts and the rendered diff, never raw rows), `events.jsonl` (every delivery of the run, one line each), `world.json` (labels and devices) and `final.json` (delivery and write totals, producers, server calls, actor outcomes, window errors). They are always written on a failure, and on a pass only when `SIM_OUT` is set.
- A net error is reported the same way under `net.no-quiescence`, `net.write-budget` or `net.order-mismatch`.

Runs are deterministic: the DSL self-test runs one scenario twice and requires identical `events.jsonl`. Scenario seeds are `fnv1a32(name) % 1_000_000 + i`, so adding a scenario never moves another's seeds. By default a scenario runs scripted at its first seed and interleave at two seeds, three runs in all.

## Budget

| Item | Limit | Kind |
|---|---|---|
| Deliveries per scenario run | 5000 (`DEFAULT_MAX_DELIVERIES`) | hard failure, `net.no-quiescence`, names the top producers |
| Server writes inside deliveries per run | 2000 (`DEFAULT_MAX_WRITES`) | hard failure, `net.write-budget`, names the top writers |
| A specific scenario | `budget: { deliveries, writes }` | hard failure |
| Wall time | reported only | the machine's load makes it flaky |

Genesis writes are not budgeted. If CI time grows, cut seeds first and never scenarios.

## Red list

A red scenario reproduces a bug we have today. Each test holds its run to the scenario's markers:

- **`red` markers** name the failures a run ends in. A run a marker covers must stop on a `SimFailure` whose invariant (or point check) the marker names; its report header then reads `sim failure (expected, red: <task>)`. A harness error, a timeout, or a failure on an invariant no marker names fails the test as it is. A run that passes fails with `red scenario "<name>" now passes; it was marked to fail on <invariant> (<task>). Remove those red: markers and close <task>`. A marker with `modes` or `seeds` covers only those runs (an order replay matches any mode); every other run must pass.
- **`known` invariants** are left out of every run, so a run reaches the scenario's own checks past a bug that trips first. Each scenario with `known` registers one more test, its first run with nothing left out (`..., nothing left out (known: <task>)`), which must fail on a known invariant. Once the bug is fixed that test fails with `scenario "<name>" no longer fails on <invariant> (<task>) with nothing left out; remove them from known: and close <task>`. So a scenario cannot quietly weaken itself, and fixing a known bug flips every scenario that names it.

Every marker below is what the default runs actually hit (measured 2026-10-02, after ct-56011, ct-56044, ct-56045, ct-56047, ct-56048, ct-56050, ct-56051 and ct-56053 landed):

| Scenario | What it drives | Red | Known |
|---|---|---|---|
| `visibilityFlip` | ada shares a private session with acme and takes it back; bo's team slot and the linked task follow | none | none |
| `viewerHideVsOwner` | bo hides ada's team-visible session while ada's daemon settles it | none | none |
| `reapVsFollowerLock` | a follower kills an empty session, the daemon heartbeats, the gc reaps the row | none | none |
| `queuedSendVsLaggingTail` | ada sends while her transcript tail lags; the daemon delivers twice | none | none |
| `roleTriggerScope` | a session filed under a role settles `permission_blocked` twice with a working turn between | none | none |
| `agentPingPong` | two agent sessions mention each other in a thread for an hour | none | none |
| `agentPingPongOwnSessions` | one session names six of its owner's sessions in a thread and each answers | none | none |
| `personalAnchorOwnedByTeammate` | bo, a second owner of ada's personal standing session, pins and kills it | none | none |
| `twoHumansOneRole` | ada and bo tell one role something 200ms apart, in both orders | none | none |
| `memberRemovedMidTurn` | bo is removed from acme while offline, then kills a session he can no longer read | none | none |
| `resumeVsSend` | a send and a resume race on two parked sessions | none | none |
| `daemonRestartParked` | a daemon heartbeat gap and a restart over parked sessions with a due trigger | none | none |

Sweeps also found ct-56054 on seeds of `queuedSendVsLaggingTail` (157409) and `resumeVsSend` (671520): the overlay shipped its coerced agent_status as the fact a replica re-derives over, and a coerced status does not replay at a later instant. Rows now carry the daemon's raw status as `agent_status_raw`, and both scenarios pass `--sweep 20`. A sweep widens the seeds past the markers, which is how it found a bug no default seed reached.

Red list item 8 (a teammate's paste over 2KB into a live pane under load) needs a real terminal client, so it is not a sim scenario. It lives in `packages/cli/src/daemon.inject-cross-user-paste.e2e.test.ts`: the server's own send, claim and echo-ack code (on the fake db) around a real Claude Code pane (the matrix harness's `spawnClientPane`, with this machine's cached remote flags so the paste is wrapped in `<pasted_content>`, against a fake model endpoint), idle and mid-turn, in the classic and fullscreen renderers, with every core loaded by `yes` (`test-helpers/cpuLoad.ts`). It asserts one transcript turn, one ack, a verified receipt, exactly one paste chip, one `<pasted_content>` wrapper when this machine's cached flags turn the wrapper on, and that a retry of the same delivery writes nothing. It loads every core for minutes, so a plain `bun test` skips it; it runs only with `CODECAST_PASTE_E2E=1 bun test src/daemon.inject-cross-user-paste.e2e.test.ts` from `packages/cli` (it also skips without `tmux` or `claude`, so CI never runs it). The weekly trigger tr-1282 runs it early Sunday morning on this machine, reruns a timed-out case alone, and on a real failure files a task under pl-810 and posts a blocker on ct-55711.

Red list item 11 (mirror version skew: a laptop on N+1 with a narrower discovery rule and a host receiver on N must never delete tracked files) touches no Convex state, so it is not a sim scenario either. It lives in `packages/cli/src/cloud/mirror/versionSkew.test.ts`: a laptop git repo and a host clone of it in temp dirs, pushed through the real `mirrorHomeToHost` and `applyMirrorBundle`. Laptop N forces the wide rule; laptop N+1 narrows when the host's `--verify` read, made just before the push, reports `keeps-tracked`, as `push.ts` does. Receiver N is the real receiver with the `keeps-tracked` capability stripped from both its apply result and its `--verify` read, and the old prune put back (a released file whose bytes are still the mirror's is deleted). Each case asserts no tracked file deleted (`git ls-files --deleted` is empty) and a verify tick that finds the two sides in step. Laptop N+1 with host N, laptop N with host N+1, a host upgraded mid run (then the laptop rolled back), and a host back on receiver N after the laptop learned `keeps-tracked` (ct-56327, after either a narrow or a wide push) all pass. It runs in about 10s with the rest of the cli tests: `bun test src/cloud/mirror/versionSkew.test.ts` from `packages/cli`.

`bun run sim --list` prints the current markers. To add a red scenario: run it, file a task under pl-810 with the report block and the `--order` line, add `red: { task: "<ct-id>", invariant: "<id the report names>" }` (with `modes` and `seeds` when only some runs reach it), rerun to confirm the report header reads `(expected, red: <ct-id>)`, and finish with `bun run sim <name> --sweep 20` to show no harness errors across seeds.

`runScenario(opts, run, fn, { skipInvariants })` and `judgeRun(opts, run, fn, { expected })` are the pieces a registered test uses: the first runs one world, the second holds it to its markers. Self-tests call them directly.

## The legacy suites

`store/__tests__/inboxConvergenceSim.test.ts` (seeds 21 to 32) and `inboxMultiWindowSim.test.ts` (seeds 81 to 92) are the single-user convergence sims that predate the harness. They keep the vocabulary they were written in (a `SimServer`, `Replica`s, `Device`s, `SERVER_EVENTS`) through `inboxSimHarness.ts`, a thin adapter over this substrate: a replica is a `SimWindow`, a device a `SimDevice`, the server the sim backend, and a failure prints through `report.ts`. Their seeds are pinned, and `SIM_SEEDS` replays one:

```bash
SIM_SEEDS=23 bun test store/__tests__/inboxConvergenceSim.test.ts
```

## CI

The `test-web` job runs `bun test --isolate` in `packages/web`, which includes `sim/sim.test.ts`, the pure sim tests and the legacy suites; there is no separate sim job. That step sets `SIM_OUT` to `${{ runner.temp }}/sim`, and when the job fails an `actions/upload-artifact` step uploads that directory as `sim-artifacts`, so the report's `result.json` and `events.jsonl` can be read without rerunning. Red scenarios write their (expected) failure artifacts there on every run, so the upload holds those too.

## Disposable Convex deployment

The in-process server cannot show real optimistic concurrency conflicts, real scheduler timing, HTTP routes, the exact production error shape, or exactly-once delivery across a real reconnect. For those, run the backend locally as an anonymous deployment in a scratch copy of the tree. No script ships for this; follow the recipe by hand.

1. **Make a scratch copy** of the tracked and untracked but not ignored files, so no `.env.local` travels, and link the dependencies. Never use the main checkout or a `cast ws` worktree: both carry the production admin key.

   ```bash
   SCRATCH=$(mktemp -d /tmp/codecast-sim-deploy.XXXXXX)
   cd ~/src/codecast
   git ls-files -co --exclude-standard -z | perl -0ne 'chomp; print "$_\0" if -f' | tar -c --null -T - -f - | tar -x -C "$SCRATCH"
   for d in node_modules packages/*/node_modules; do ln -s "$PWD/$d" "$SCRATCH/$d"; done
   ```

2. **Refuse to continue** if anything could point the CLI at a real deployment:

   ```bash
   env | grep -E '^CONVEX_(SELF_HOSTED_|DEPLOY_KEY)' && echo "REFUSE: unset these first"
   find "$SCRATCH" -name '.env.local' -not -path '*/node_modules/*' | grep . && echo "REFUSE: an .env.local travelled"
   ```

   Both must print nothing. A `CONVEX_DEPLOYMENT` in the shell is fine: the next step unsets it for the CLI.

3. **Start the backend** in a tmux pane, from the scratch copy's `packages/convex`. A `CONVEX_DEPLOYMENT` value whose name starts with `anonymous-` is how the CLI tells an anonymous local deployment from a cloud one, and `CONVEX_AGENT_MODE=anonymous` makes it create one without a prompt. Leave it running: `convex dev` stops the local backend when it exits, so `--once` would leave nothing to talk to.

   ```bash
   printf 'CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n' > "$SCRATCH/sim.env"
   tmux new -d -s sim-deploy -c "$SCRATCH/packages/convex"
   tmux send-keys -t sim-deploy "env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY CONVEX_AGENT_MODE=anonymous npx convex dev --env-file ../../sim.env --codegen disable --typecheck disable --tail-logs disable" Enter
   ```

   Wait for `Convex functions ready!` in the pane (`tmux capture-pane -p -t sim-deploy`); the first push takes about two minutes. On a heavily loaded machine the first push can fail with `Function execution timed out (maximum duration: 4s)` while the backend loads the modules; save any file under `convex/` (`touch "$SCRATCH/packages/convex/convex/schema.ts"`) and the watcher pushes again.

   The CLI (1.36) names a new anonymous deployment `anonymous-agent` whatever name was asked for, keeps its database and admin key in `~/.convex/anonymous-convex-backend-state/anonymous-agent/`, and writes `CONVEX_DEPLOYMENT` and `CONVEX_URL` into the scratch copy's `packages/convex/.env.local`. Every agent on the machine that uses `CONVEX_AGENT_MODE=anonymous` shares that name, so run one disposable deployment at a time.

4. **Check the URL** before the first request, from the scratch copy's `packages/convex`:

   ```bash
   bun -e 'const env = await Bun.file(".env.local").text(); const url = new URL(env.match(/^CONVEX_URL=(.*)$/m)[1]); const dep = env.match(/^CONVEX_DEPLOYMENT=(.*)$/m)[1]; if (url.hostname !== "127.0.0.1" || !dep.startsWith("anonymous:")) throw new Error(`not a local anonymous deployment: ${url} ${dep}`); console.log("ok", url.href, dep)'
   ```

5. **Seed rows and act as users.** The CLI commands in the scratch copy read its `.env.local`, so they reach the local deployment; still unset the production variables:

   ```bash
   printf '{"name":"ada","email":"ada@sim.invalid"}\n' > /tmp/users.jsonl
   env -u CONVEX_DEPLOYMENT npx convex import --table users /tmp/users.jsonl --append -y
   env -u CONVEX_DEPLOYMENT npx convex data users --format jsonl
   ```

   Then an admin client impersonates an identity. The subject is `<user id>|session`, as Convex Auth issues it. Saved as `actas.ts` in the scratch copy's `packages/convex` and run with `bun actas.ts <user id>`, this prints the user it acted as:

   ```ts
   import { ConvexHttpClient } from "convex/browser";
   import { homedir } from "node:os";
   const env = await Bun.file(".env.local").text();
   const url = env.match(/^CONVEX_URL=(.*)$/m)![1];
   const name = env.match(/^CONVEX_DEPLOYMENT=anonymous:(.*)$/m)![1];
   const { adminKey } = await Bun.file(`${homedir()}/.convex/anonymous-convex-backend-state/${name}/config.json`).json();
   if (new URL(url).hostname !== "127.0.0.1") throw new Error(`refusing ${url}`);
   const client = new ConvexHttpClient(url);
   (client as any).setAdminAuth(adminKey, { subject: `${process.argv[2]}|session`, issuer: "sim" });
   console.log(await client.query("users:getCurrentUser" as any, {}));
   ```

6. **Never** use `deploy.sh`, `gated-push.ts`, `bun run dev`, or the package's `deploy` script here. When done, stop the backend and delete both the scratch copy and the deployment's state:

   ```bash
   tmux kill-session -t sim-deploy
   rm -rf "$SCRATCH" ~/.convex/anonymous-convex-backend-state/anonymous-agent
   ```
