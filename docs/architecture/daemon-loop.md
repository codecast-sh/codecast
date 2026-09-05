# Daemon event loop and workers

Plan: pl-497. Implementation and acceptance are separate: probe isolation and
the repaired scan path have local acceptance. Transcript isolation is being
implemented; the final load test remains open. Do not enable workers by default
or call the 200-session target met on this evidence.

The worker and parking design below describes the shared development tree, not
the release candidate or a running daemon. The release boundary is recorded
separately below; source on disk does not prove what a process loaded at boot.

## Main-process budget

The daemon keeps the loopback server, Convex subscriptions and writes, delivery
scheduling, sync positions, heartbeat and watchdog tick in its main process.
Read-only children perform expensive observation. They do not publish status,
advance transcript positions, deliver messages or renew the main watchdog stamp.

The target is no main-loop hold above one second. Use asynchronous process and
filesystem APIs on control paths, and yield between bounded batches of CPU work.
An `async` function that parses a whole transcript before its first `await` still
blocks the loop. A worker crash must not turn a large job into an unbounded
main-process fallback.

`packages/cli/src/daemon.loopBudget.guard.test.ts` checks named hot-path source
regions. It checks direct calls, not the transitive call graph. New expensive
callees need their own region. Its two current exceptions cover the small daemon
state merge and a memoized project-directory stat. The test rejects stale
allowlist entries; do not widen it to accommodate a new blocker.

This is a target invariant, not a claim that the whole daemon satisfies it yet.
Legacy recovery helpers and the full transcript preparation path still need
remaining performance proof.
Small synchronous reads, log writes and session-launch operations also need
separate scrutiny when interpreting measured stalls.

## Worker boundary

`workers/bridge.ts` configures worker hosts only when
`config.daemon_workers === true`. An omitted setting leaves them off. Windows
does not enter this worker path, matching the daemon's existing platform limit.
The ingest implementation is still under development review. Its presence in
source does not establish correctness or fleet performance.

| Kind | Current production work | Supervisor responsibility |
| --- | --- | --- |
| `probe` | Validated read-only process, tmux, focus, launchd and keychain commands | Scheduling, identity decisions and mutations |
| `scan` | Paged filesystem walks, index refresh, watcher scans, inventory and Cursor workspace observations | Cache publication, generation checks and sync decisions |
| `ingest` | Development source reads/parses eight client formats through seven serialized entry points; not independently accepted | Positions, deduplication, retries and Convex writes stay here |

The host launches the same executable through `main` before ordinary CLI boot:

| Install | Child invocation shape |
| --- | --- |
| Source | `bun packages/cli/src/main.ts _worker <kind>` |
| Built JavaScript | `node packages/cli/dist/main.js _worker <kind>` or Bun |
| Compiled binary | `codecast _worker <kind>` |

These are supervised invocation shapes, not commands to start by hand. The
child checks its parent PID and worker context. JavaScript packaging uses Bun's
`--splitting` so the Node worker entry does not load Bun-only daemon imports.
The build-ID walker includes the worker entry and its source closure.

The launcher removes inherited session markers, `XPC_SERVICE_NAME`, preload
options and named daemon credentials. A separate process group lets the host
terminate its child and subprocesses. Parent death, pipe EOF, deadlines and
shutdown stop owned worker resources. A healthy child cannot conceal a wedged
main loop: only the main process writes the watchdog tick.

### Protocol and overload

`workers/protocol.ts` defines version 1 NDJSON over stdin/stdout. Frames include
kind, correlation ID and operation. Requests carry an absolute deadline; the
host validates results against the pending operation and current generation.
Invalid UTF-8, oversized frames and protocol mismatches reject the connection.

| Bound | Current value |
| --- | --- |
| Encoded frame | 16 MiB |
| Active requests per host | 4 |
| Waiting requests per host | 32 |
| Request deadline | At most 60 seconds |
| Scan page | At most 128 rows and 256 KiB |
| Idle scan cursor | 30 seconds |

The host uses monotonic time for crash/backoff and heartbeat age, with the shared
suspend classifier. Results still have to meet their wall-clock request deadline.
It backs off after crashes and disables that kind after three crashes within ten
monotonic minutes. Read callers can use their existing local asynchronous path
during unavailability, within the original remaining deadline. A closed host
does not grant fallback authority. Operation failure is distinct from worker
unavailability; it must not become successful empty data.

### Transcript ingestion development status

The F3 checkpoint at `/tmp/pl497/f3-implementation/checkpoint.md` reports a
256 KiB / 128-token pull page, strings split at 8,192 code units, four cursor
slots, 128 MiB source/result limits, one million nodes and depth 128. Oversized
inputs refuse without consuming the unread position. Small local fallback is
limited to 256 KiB non-database, non-backup reads; larger transport failures
remain for retry. These implementation details are not independent acceptance.

The main process retains unread positions until actual server acknowledgment.
Generic `RetryQueue.add` is memory insertion and is not a disk-durability receipt.
The current F3 work also validates pending snapshots and delayed receipts before
advancing custody. Its latest checkpoint reports the implementation ready for
bounded review, with rebuilt packaging checks still in progress. Independent F3
acceptance remains open; E1/E2 and F1/F2 local acceptance do not imply it.

Page assembly timing is not full-path latency. The parent's actual
`prepMessageForSync` plus `SyncService.addMessages` control, with only network
stubbed, recorded a 1,364 ms maximum tick for 64 MiB ordinary content. The 18 MiB
content and tool controls recorded 386 ms and 199 ms. Evidence:
`/tmp/pl497/parent-integration-audit/sync-preparation.log`,
`2026-09-05T21:10:05.041Z`. This open preparation repair belongs to ct-49252;
worker page timings do not close it.

E1 and E2 have narrow independent local acceptance in `e1-final-review.md` and
`e2-final-review.md`; F1 has `f1-final-review.md`. F2's development acceptance is
`f2-parent-acceptance.md`, all under `/tmp/pl497/`. Preserve their explicit
scope limits when reading this design.

### Observation is not kill permission

The session index and process metrics can tolerate stale observations. Cleanup
cannot infer exclusive ownership from a missing entry in a depth-limited,
mtime-limited or failed scan. Destructive acquisition requires a complete current
Codex traversal and readable positive session identity; incomplete directories,
ambiguous identities, changed HOME/generation, cancellation or unavailable proof
refuse destruction.

Session ownership still does not identify a live PID. The second scan review
reproduced a process changing sessions during that acquisition wait, after the
orphan reaper's sole live identity check. The repaired path checks exact session,
UID, start identity and orphan parent again after acquisition and after the
claim, child and pane observations. It signals only a childless root, within a
one-second evidence window, while its cancellation and reservation checks still
hold. No portable sequence of separate OS observations is an atomic kill lease.

Independent disposable-process controls passed real identity changes, all eleven
refusal cases, the stable positive, and owned-root signal/cleanup in both modes.
Late-result tests also preserved successor reservations. An earlier uninstrumented
run refused the stable positive for an unknown reason; subsequent traced success
does not explain that failure or establish timing reliability under load. It
remains a final integration concern. These checks accept the narrow repair for
continued development, not live-fleet safety or release acceptance.

### Terminal snapshots and watcher cost

Worker-enabled terminal listing uses a memory snapshot. Refreshes deduplicate and
run at most once per second; data expires after five seconds. Cold, expired or
invalidated snapshots return a temporary 503, not an empty fleet. The client
retries within its existing budget and does not create replacement terminals
from unknown state. Mutation and delivery identity checks do not use this cache.

Native recursive watchers schedule an accepted-tree scan two seconds after the
previous scan completes, even when idle, to recover coalesced filesystem events.
Rejected events do not accelerate that cadence. This adds disk work. Final load
testing must measure its idle cost as well as missed-event recovery, overlap and
stop/restart behavior; moving the walk to a child does not remove that cost.

## Restarts and parked sessions

The listener starts after config, before update checks and startup scans. Hook
status returns 503 until its bindings exist. The daemon reuses
`~/.codecast/loopback-identity.json` with mode 0600 for its port and terminal token,
falling back to an available port if necessary. Treat that token as a credential.
`cast daemon rotate-token` replaces it and restarts the daemon; coordinate that
operation because existing terminal connections must rediscover the token.

A known equal daemon build ID can veto an otherwise-required version/update
restart. A different ID does not itself trigger a restart, so working in another
checkout cannot bounce the daemon into that checkout. Unknown IDs retain the
existing restart behavior. Device-scoped command claims limit duplicate command
execution; the next boot releases claims persisted by the prior daemon.

Automatic parking ships off:

```json
{ "max_live_sessions": 0, "hibernate_idle_ms": 0 }
```

The proposed 60-session cap and two-hour idle threshold have no approval. Manual
parking still goes through the safety gate. Working or mid-turn sessions,
pending questions, pinned or attached sessions, pending delivery, live children
and uncertain identity are not eligible. A skipped kill reports skipped.
The daemon reports parked only after a positive guarded kill acknowledgment,
confirmed pane absence and unchanged reservation. Wake clears the parked state.
These checks reduce risk; they do not justify a zero-risk claim about concurrent
OS and backend observations.

### Release candidate parking fallback

Candidate commit `4c84473f9` deliberately does not include the full E1/E2 parking
safety closure or F worker migration. Its shared manual/automatic policy returns
`parking-safety-unavailable` unless an existing never-rule gives a more specific
reason. The direct `parkAs: "hibernated"` teardown also returns before any IO or
tracking changes. Thus even nonzero limits cannot park a session in this
candidate; defaults off are not its only protection. An absent pane reports
skipped unless this daemon already remembers a park.

Ordinary cleanup, resume, injection and account switching remain separate from
this refusal. Their unchanged code is not newly certified safe by parking tests.
The candidate does not repair historical or other-daemon late park stamps. That
requires the full E2 status watermark, heartbeat ordering and applied-ACK
contract, together with the E1 ownership/cancellation/commit boundary before
parking can be enabled again.

The owned fallback passed 112 socket-free tests and both account-patch orders.
Release integration passed 129 socket-free tests with 539 assertions. After the
test-only status typing fix in `95f644d49`, the repository CLI typecheck passed.
The updated real-pane suite was not part of this local fallback receipt; its CI
status belongs to the release owner. These checks are separate from the later
human-authorized orphan-reaper review above, which exercised the development
tree, not this candidate. F3 and final load acceptance remain open; this record
is not publication approval.

## Freeze SLO

The main probe runs every 500 ms and records lateness at or above five seconds.
The shared clock policy separates measured blocking from machine suspend using
wall/monotonic deltas. Darwin can add sampling attribution; Linux cannot use the
Bun sampling profiler safely in the tested versions. The ledger retains a minute
window, an hour summary and since-boot counters in memory; restart resets them.

The heartbeat carries minute/hour freeze values, maximum duration and attribution
to device health. Older clients that omit a field do not zero it. The backend
alerts at 120 seconds per hour by default: worsening incidents use a 30-minute
cooldown, changed but chronic breaches a six-hour interval. An unchanged stale
number does not repeatedly notify. The web shows current symptoms before the
historical hour tier; `cast health` also exposes the freeze summary.

Zero freeze log entries cannot prove the one-second budget: the logging threshold
is five seconds. `/health` request round-trip time includes the client, network
and daemon scheduling. Read that measurement alongside the main-loop clock data,
errors, skipped probes and tester scheduling, rather than calling it a direct
event-loop meter.

## Measurement and acceptance

A read-only observation of the running daemon:

```sh
cast bench daemon --duration 120 --log-since 1 --json
```

The command writes JSON and Markdown under `~/.codecast/bench/`. It does not boot
a second daemon. Do not run a second daemon as a load-test shortcut: ordinary
boot shares configuration and includes split-brain cleanup.

The existing load command shape is:

```sh
cast bench daemon --load 200 --sample 10 --duration 120 --churn-interval 2000 --json
```

The repaired source records one monotonic measurement window. Churn and all
route schedulers remain active through the sampled delivery legs until the same
deadline. Each leg records its start/end, outcome and poll count; requested legs
remain in the report even when never started. Mapping time begins at each
fixture's actual spawn attempt and requires a matching exported session, project
path and both sides of the boot exchange. A scratch directory inside a parent
Git repository is refused before spawning: backend deletion prefers Git root,
so that layout cannot prove isolated removal by scratch path. It is not daemon boot time.

Input validation precedes fixture construction, sample allocation and timers.
The source refuses more than 1,000 fixtures, more than 100,000 computed load
records (including per-target churn, routes, startup and delivery), or more than
100,000 slots for an individual probe. Derived totals must be finite safe
integers, and individual timers must fit the runtime's 2,147,483,647 ms limit.
These are explicit refusal bounds, not truncated samples or relaxed SLOs.

The doctor Node/Bun stub is the only agent fixture. Bounded asynchronous writes
are serialized per transcript and pause while the stub handles delivery. The
bench joins writes and requests before cleanup. Churn rounds and route slots
carry scheduled and actual times, including each churn target and delivery pause.
Hook ownership verification time is separate from dispatch-to-response RTT. Late slots are recorded as missing, capacity
limits as skipped, and outstanding requests as timed out or cancelled at the
window boundary. A tester stall cannot disappear behind fast successful RTTs.

Observe mode retains the explicitly named invalid-hook dispatch probe (HTTP
400). Load sends actual GET status events only after checking the run's exact
session, pane, PID, process identity and registry. The last unique hook message
also identifies the expected persisted status record for cleanup. Terminal
credentials are used only in request headers and are removed from reports.

JSON preserves all samples and failures, requested/spawned/mapped counts,
phase intervals, before/after runtime observations and source manifests.
Runtime worker settings, routing and loaded configuration remain unknown when
no authoritative observation exists; disk configuration and CLI version are
separate context. A PID/build/config change invalidates comparison. Historical
sleep windows do not excuse missing measurement slots.

Cleanup uses the exact acquired resource ledger, checkpointed in the private
scratch directory before spawn and after custody acquisition. Abrupt benchmark
process death can leave that ledger for recovery; it is not automatic cleanup
or a disk-durability receipt. It refuses changed ownership,
checks pane and process exit, validates complete transcript records, removes
only the fixture's registry/status/transcript files and drains backend deletion
under the unique scratch path with an explicit cap and exact count. Missing or
incomplete cleanup fails measurement; `--keep` is diagnostic. A partial spawn
whose identity cannot be proven is retained and reported as a cleanup failure.
Allocation alone never authorizes deleting an existing file. Acquired file
identities are checked again immediately before removal, including the private
ledger and stub, so replacements during cleanup waits are retained.
No prefix sweep or default-server kill is used. Separate OS observations are
not an atomic custody lease, so final live validation is still required.

Focused tests execute the actual benchmark orchestrator with finite clocks and
failure/cancellation controls. Real integration uses disposable private tmux
stubs and an independent local fake HTTP server. Those results establish the
measurement implementation only. Reports remain NOT ESTABLISHED for final
performance acceptance until the parent supplies independently accepted F3,
complete N=200 delivery, observed runtime routing/configuration and coordinated
boot blackout proof. A recorded failed leg, skipped/missing slot, cleanup
failure, health RTT at or above 1,000 ms or terminal p99 at or above 50 ms fails
the corresponding measurement.

Run the focused source checks from the repository root, with long commands in
a private tmux runner:

```sh
bun test ./packages/cli/src/bench/load.test.ts ./packages/cli/src/bench/probes.test.ts ./packages/cli/src/bench/stats.test.ts ./packages/cli/src/bench/daemonBench.test.ts
bun test ./packages/cli/src/bench/integration.test.ts
```

The CLI's existing exit expression checks only teardown warnings. The separate
unapplied correction is `/tmp/pl497/g-load-work/cli-exit.unapplied.patch`; read
JSON acceptance and its reasons until the CLI owner applies that correction.
The package-script correction from `bun test src/` to `bun test ./src/` is also
kept unapplied for that owner. No tests are dropped by that correction.

Recorded pre-worker observation, `2026-09-05T01:22:38.671Z`, 120 seconds:

| Context or measurement | Value |
| --- | --- |
| Daemon PID / build | 82084 / 6817851b45ac |
| Fleet / machine | 128 tmux sessions, 1,501 processes |
| Load average | 8.1 / 20.1 / 36.0 |
| Health RTT p99 / maximum | 73 / 116 ms |
| Health failures / skips / samples above 1 second | 0 / 0 / 0 |
| Terminal list RTT p99 / maximum | 158 / 227 ms |
| Invalid hook request RTT p99 | 65 ms, HTTP 400 only |

This quiet observation misses the terminal-list target and is not comparable to
the earlier 200-session stress runs. Later unrelated reloads also mean PID 82084
does not describe the current running daemon. No post-worker fleet numbers have
been accepted. Historical A recorded N=50 with health p99 about 2.1 seconds and
26 samples at or above one second. That loaded run is not a percentage baseline
for this smaller quiet observation.

Before closing pl-497, record the source/build identity, configuration, machine
load and sample denominators for worker-off/on tests and an integrated N=200 run.
Require no health RTT sample at or above one second, terminal-list p99 below 50 ms,
boot blackout below two seconds, and no hidden failed or skipped samples. Verify
worker crash recovery, cancellation, transcript correctness and owned-resource
cleanup, not just latency on successful requests. Keep the broad CLI, typecheck,
packaging and guard gates tied to the source actually being released.

Use rooted test paths, for example `bun test ./src/daemon.loopBudget.guard.test.ts`
from `packages/cli`. The Darwin Bun filter-path traversal issue can exhaust file
descriptors when an unrooted filter walks the monorepo. The full CLI gate belongs
in an isolated environment: legacy tests that inspect the default tmux server
must not run against a person's live fleet.
