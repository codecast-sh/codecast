# Web perf benches

Benchmarks of the web app's hot paths, each with two halves:

- **Counts that must be exact** (`scripts/perf-budgets.sh`, run in CI). What an action may cost, independent of machine speed: requests asked, subscriptions opened, store writes, React commits, DOM changes, forced layouts.
- **A/B timing** (`scripts/perf-bench.sh`), with [strobe](https://github.com/Hona/strobe) 0.17 at a pinned version. It compares two builds in pairs of fresh processes (A B, B A, ...), decides one primary metric per case with a confidence interval, and compares every count exactly between base and head.

Both drive `harness.tsx`: the real components mounted in jsdom over a synthetic cache, with a Convex client that answers nothing and counts what it is asked. The harness runs under plain `bun` (strobe's script host), so it uses no `mock.module` and no test preload. The diff case therefore draws with the real `@pierre/diffs` viewer.

| Case | Workload | Exact counts (budgets.ts) |
| --- | --- | --- |
| switch conversation (warm) | Two conversations of 200 cached messages, both visited, over 2,000 sessions; switch until the last answer is on screen | 0 one-shot fetches, 15 subscriptions opened, 2 store writes, 23 DOM mutation records |
| load an inbox of 5000 sessions | `SessionListPanel` mounting over 5,000 sessions | 51 cards drawn, 2 subscriptions, 0 fetches |
| heartbeat in an inbox of 5000 sessions | A liveness overlay payload (`applyMineLivenessPayload`) shaped like the server's: the viewer's 600 newest sessions, each with its facts and placement stamps, plus the projection envelope, all freshly decoded; only one drawn session's heartbeat moved | 0 commits, 0 DOM mutations, 0 layout reads |
| the same two, Modern style (`inbox-load-modern`, `inbox-heartbeat-modern`; budgets only) | The panel under the Modern theme context, drawing `ModernSessionCardView` and its section header | the same counts: 51 cards, 2 subscriptions; 0 commits, 0 DOM mutations, 0 layout reads |
| open a long diff | A 1,560-line TypeScript file with 52 changed lines, shown whole and highlighted, in a warm app, mounted at the top of a scroller a viewport (800px) tall | 2 commits, 18 DOM mutation records, 32 layout reads, 0 store writes, 150 of 1,612 rows drawn |

The budgets also check that a rename arriving through the feed reaches its card.

DOM mutations are counted under the mounted tree and inside every shadow root from the moment it is attached (the harness wraps `attachShadow`). The diff viewer draws its lines in a shadow root outside React, so the diff's 18 records are its host going in plus the viewer's own draw; a redraw would add to them. A diff over 200 rows draws windowed (`components/diff/virtualizer.ts`): the harness gives that diff's scroller (`data-perf-viewport`) the viewport's height and reports each element the Virtualizer observes as on screen, as a browser's IntersectionObserver does on observe. The 32 layout reads are the windowing's own: finding the scroller and measuring it and the file's offset in it.

## What the timing measures

The primary is `cpu.work`: CPU time of the bench process during the action. That covers React, the store and the app's own code, plus jsdom's DOM work. It leaves out style, layout and paint, which jsdom does not do, so it is not the browser's main-thread time. Because jsdom's DOM operations are slower than a browser's, DOM-heavy cases are dominated by jsdom: opening the long diff costs about 6 s of CPU here and much less in Chrome. A/B differences still point the right way because both sides pay the same jsdom cost. React also runs its development build here (plain bun leaves `NODE_ENV` unset, and `act()` and `<Profiler onRender>` need the development build), so `cpu.work` includes development-only work such as owner stacks and warnings that production never pays. Page-level cases (strobe `web()` targets in a real Chromium, measuring `main.work`, layout shift and frames) would need the app to boot offline against a mocked backend, which it cannot do today.

Commits and layout reads in the switch case depend on wall time, because the transcript's interval timers (the 1 s size reconciler, the 350 ms scroll hold) tick while it settles. They are compared between base and head but not asserted.

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
