# Web perf benches

Benchmarks of the web app's hot paths, each with two halves:

- **Counts that must be exact** (`scripts/perf-budgets.sh`, run in CI). What an action may cost, independent of machine speed: requests asked, subscriptions opened, store writes, React commits, DOM changes, forced layouts.
- **A/B timing** (`scripts/perf-bench.sh`), with [strobe](https://github.com/Hona/strobe) 0.17 at a pinned version. It compares two builds in pairs of fresh processes (A B, B A, ...), decides one primary metric per case with a confidence interval, and compares every count exactly between base and head.

Both drive `harness.tsx`: the real components mounted in jsdom over a synthetic cache, with a Convex client that answers nothing and counts what it is asked. The harness runs under plain `bun` (strobe's script host), so it uses no `mock.module` and no test preload. The diff case therefore draws with the real `@pierre/diffs` viewer.

| Case | Workload | Exact counts (budgets.ts) |
| --- | --- | --- |
| switch conversation (warm) | Two conversations of 200 cached messages, both visited, over 2,000 sessions; switch until the last answer is on screen | 0 one-shot fetches, 15 subscriptions opened, 2 store writes, 19 DOM mutation records |
| a message arrives in an open conversation | One conversation of 200 cached messages on screen, over 2,000 sessions; one more row appended through `mergeMessages` (the path a streamed answer takes) until its text is drawn | 1 store write, 0 fetches, 0 subscriptions opened |
| load an inbox of 5000 sessions | `SessionListPanel` mounting over 5,000 sessions | 51 cards drawn, 2 subscriptions, 0 fetches |
| heartbeat in an inbox of 5000 sessions | A liveness overlay payload (`applyMineLivenessPayload`) shaped like the server's: the viewer's 600 newest sessions, each with its facts and placement stamps, plus the projection envelope, all freshly decoded; only one drawn session's heartbeat moved | 0 commits, 0 DOM mutations, 0 layout reads |
| the same two, Modern style (`inbox-load-modern`, `inbox-heartbeat-modern`; budgets only) | The panel under the Modern theme context, drawing `ModernSessionCardView` and its section header | the same counts: 51 cards, 2 subscriptions; 0 commits, 0 DOM mutations, 0 layout reads |
| open a long diff | A 1,560-line TypeScript file with 52 changed lines, shown whole and highlighted, in a warm app, mounted at the top of a scroller a viewport (800px) tall | 2 commits, 18 DOM mutation records, 32 layout reads, 0 store writes, 150 of 1,612 rows drawn |

The budgets also check that a rename arriving through the feed reaches its card, and that a warm switch, a diff panel toggle (`diff-toggle`) and a send from the composer (`send`) each force layout at most once (ct-101461). A forced layout is a layout read made after a DOM write since the page was last laid out (by the last forced read or the last animation frame): each one is a synchronous reflow of the whole page in Chrome. The harness answers `CSS.supports` as Chrome does, so the composer's Safari-only measuring fallback stays off.

DOM mutations are counted under the mounted tree and inside every shadow root from the moment it is attached (the harness wraps `attachShadow`). The diff viewer draws its lines in a shadow root outside React, so the diff's 18 records are its host going in plus the viewer's own draw; a redraw would add to them. A diff over 200 rows draws windowed (`components/diff/virtualizer.ts`): the harness gives that diff's scroller (`data-perf-viewport`) the viewport's height and reports each element the Virtualizer observes as on screen, as a browser's IntersectionObserver does on observe. The 32 layout reads are the windowing's own: finding the scroller and measuring it and the file's offset in it.

## What the timing measures

The primary is `cpu.work`: CPU time of the bench process during the action. That covers React, the store and the app's own code, plus jsdom's DOM work. It leaves out style, layout and paint, which jsdom does not do, so it is not the browser's main-thread time. Because jsdom's DOM operations are slower than a browser's, DOM-heavy cases are dominated by jsdom: opening the long diff costs about 6 s of CPU here and much less in Chrome. A/B differences still point the right way because both sides pay the same jsdom cost. React also runs its development build here (plain bun leaves `NODE_ENV` unset, and `act()` and `<Profiler onRender>` need the development build), so `cpu.work` includes development-only work such as owner stacks and warnings that production never pays. Page-level cases (strobe `web()` targets in a real Chromium, measuring `main.work`, layout shift and frames) would need the app to boot offline against a mocked backend, which it cannot do today.

Commits and layout reads in the switch case depend on wall time, because the transcript's interval timers (the 1 s size reconciler, the 350 ms scroll hold) tick while it settles. They are compared between base and head but not asserted.

The append case is the re-render memoization exists for: one row is new and nothing else on the page has anything new to show. Its commits (6 or 7), DOM mutation records and layout reads follow the transcript's timers like the switch's, so they are compared, not asserted.

## React Compiler

The Vite build compiles the files on the allowlist in `plugins/reactCompiler.ts`; plain bun compiles nothing. `REACT_COMPILER=1` makes the harness load those files compiled (`test-helpers/reactCompiler.ts`, the same list and options), so every command below can be run with the compiler on, and `perf/compilerAB.ts` compares the two directly:

```sh
REACT_COMPILER=1 scripts/perf-budgets.sh                  # the exact counts, compiled
bun perf/compilerAB.ts --workload append                  # on against off: CPU, React render time, every count
bun perf/compilerAB.ts --workload switch --pairs 8 --runs 6
REACT_COMPILER_SOURCES=components/inbox/ bun perf/compilerAB.ts --workload inbox-load   # a candidate, before it joins the list
```

`compilerAB.ts` runs fresh processes in pairs with the order alternating and reports the median difference with a 95% interval, for CPU (what strobe calls `cpu.work`) and for the time React spent rendering (`detail.renderMs`, the harness Profiler's `actualDuration`). Measured on 2026-11-18 with the list as it was first written, 8 pairs:

| Case | React render, off → on | CPU, off → on |
| --- | --- | --- |
| a message arrives in an open conversation | 37.9 → 32.9 ms, -13.8% (95% -8.6 to -3.7 ms) | 133.5 → 111.3 ms, -19.5% (95% -35.7 to -12.7 ms) |
| switch conversation (warm) | 42.3 → 40.8 ms, no difference (95% -5.4 to +5.7 ms) | 145.9 → 133.1 ms, no difference (95% -28.6 to +7.7 ms) |

Measured again the same day, 6 pairs, after `useRelativeTime` was changed to hand compiled rows a callback that moves with the clock: a message arriving renders in 39.6 → 34.5 ms, -12.3% (95% -5.7 to -3.4 ms); CPU 131.4 → 117.6 ms with an interval that reaches zero (-27.6 to +0.1 ms, taken at a load of 24).

The switch does not move, with this list or with every directory compiled (40.4 → 44.0 ms, no difference): a switch gives every row new content, so there is nothing for a cache to return, and the components that hold most of its render time (`ConversationView`, `MessageInput`, `MessageReviewImpl`, `UserPromptImpl`, `InboxConversation`) are ones the compiler leaves as written. `bun scripts/react-compiler-report.ts <files>` names the reason for each. Add a file to the list only after that report is clean for it and an A/B on a case that renders it shows a difference.

## Run

```sh
cd packages/web
scripts/perf-budgets.sh                                    # the exact counts, about 1.5 min
scripts/perf-bench.sh --check                              # each case once: does it still run?
scripts/perf-bench.sh                                      # origin/main vs this tree, every case
scripts/perf-bench.sh --base <ref> --filter "open a long diff"
scripts/perf-bench.sh --aa                                 # this tree on both sides: is the method sound here?
bunx @hona/strobe@0.17.0 report experiment <exp_…> --open  # the report of a run
```

`perf-bench.sh` refuses a timed run when the 1-minute load is above the CPU count, because the intervals would only widen until nothing decides. `PERF_ALLOW_BUSY=1` runs anyway, and strobe reports the load beside the verdict. A git ref base gets its own worktree with `bun install --frozen-lockfile`; strobe places this checkout's `harness.tsx` in it, so the harness stays one file that imports only app code that exists on both sides.

## Add a case

Add a workload to `harness.tsx` (a `setup` that builds the world once and returns `run` and `reset`), a case in `web.bench.ts`, and its exact counts in `budgets.ts`. Seed the store through the producers the app uses (`syncTable`, `setMessages`): a raw `setState` skips what the first sync does at boot (view adoption, the conversations mirror), and that work then lands in the first measured run. A count is exact only if it holds in a fresh process at any machine speed. Run the budget a few times under load before you assert it, and leave counts that follow timers to the A/B comparison.
