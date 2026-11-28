# Web perf benches

Benchmarks of the web app's hot paths, each with two halves:

- **Counts that must be exact** (`scripts/perf-budgets.sh`, run in CI). What an action may cost, independent of machine speed: requests asked, subscriptions opened, store writes, React commits, DOM changes, forced layouts.
- **A/B timing** (`scripts/perf-bench.sh`), with [strobe](https://github.com/Hona/strobe) 0.17 at a pinned version. It compares two builds in pairs of fresh processes (A B, B A, ...), decides one primary metric per case with a confidence interval, and compares every count exactly between base and head.

Both drive `harness.tsx`: the real components mounted in jsdom over a synthetic cache, with a Convex client that answers nothing and counts what it is asked. The harness runs under plain `bun` (strobe's script host), so it uses no `mock.module` and no test preload. The diff case therefore draws with the real `@pierre/diffs` viewer.

| Case | Workload | Exact counts (budgets.ts) |
| --- | --- | --- |
| switch conversation (warm) | Two conversations of 200 cached messages, both visited, over 2,000 sessions; switch until the last answer is on screen | 0 one-shot fetches, 15 subscriptions opened, 2 store writes, 21 DOM mutation records |
| a message arrives in an open conversation | One conversation of 200 cached messages on screen, over 2,000 sessions; one more row appended through `mergeMessages` (the path a streamed answer takes) until its text is drawn | 1 store write, 0 fetches, 0 subscriptions opened |
| load an inbox of 5000 sessions | `SessionListPanel` mounting over 5,000 sessions | 51 cards drawn, 2 subscriptions, 0 fetches |
| heartbeat in an inbox of 5000 sessions | A liveness overlay payload (`applyMineLivenessPayload`) shaped like the server's: the viewer's 600 newest sessions, each with its facts and placement stamps, plus the projection envelope, all freshly decoded; only one drawn session's heartbeat moved | 0 commits, 0 DOM mutations, 0 layout reads |
| the same two, Modern style (`inbox-load-modern`, `inbox-heartbeat-modern`; budgets only) | The panel under the Modern theme context, drawing `ModernSessionCardView` and its section header | the same counts: 51 cards, 2 subscriptions; 0 commits, 0 DOM mutations, 0 layout reads |
| under the owners model (`inbox-load-owners`, `inbox-heartbeat-owners`, `inbox-owners-push`; budgets only) | Every session under the session_owners model with its owner fields and an owners read in the store, the coarse clocks (15 s and up) frozen so a run never crosses a relative-time tick, the window's owners feeder mounted and every card reporting itself on screen (the harness never settles auth, so the feeder's chunked `listOwnersFor` reads hold at skip, as the trigger feed's do; `lib/ownerChunks` and its test measure their reads); the last pushes the drawn cards' unchanged reads (`applySessionOwnersReads`) | 100 cards (the whole `GLOBAL_CARD_BUDGET`), 1 subscription; 0 commits, 0 DOM mutations, 0 layout reads; the push 0 store writes, 0 commits |
| open a long diff | A 1,560-line TypeScript file with 52 changed lines, shown whole and highlighted, in a warm app, mounted at the top of a scroller a viewport (800px) tall | 2 commits, 18 DOM mutation records, 32 layout reads, 0 store writes, 150 of 1,612 rows drawn |

| open the command palette | `PaletteHost` over a busy account's cache (2,700 sessions, 29,000 session-index rows, 52,000 tasks, 20,000 docs, 640 plans, 4,500 routines); twenty sessions beat and a task changes between opens | timed only |
| type into the command palette | "sync review" typed a key at a time into the open palette (`PALETTE_QUERY` overrides); `palette-idle` (budgets/scripts only) is the open palette while sessions beat | timed only |

The budgets also check that a rename arriving through the feed reaches its card.

`bun perf/palette.ts [open|type|idle] [runs]` times the palette workloads in one process (CPU, React render, the first commit, counts); run it under `bun --cpu-prof` to profile. `PALETTE_SAMPLE=<file>` clones real rows from a JSON of `{ sessions, sessionIndex, tasks, docs, plans, agentTasks: [...] }` up to the same counts; that file holds private data, so it lives outside the repo. `PERF_COMMITS=1` logs what each commit rendered, and `PERF_HOOKS=<Component>` which of its state hooks changed.

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

## Editor

The code editor's budgets (docs/architecture/code-editor.md) are tests, run in CI with the web tests. To run them together:

```bash
bun test --isolate --timeout 120000 components/code/__tests__/typingAllFeatures.mount.test.tsx components/code/__tests__/typingContract.mount.test.tsx lib/code/__tests__/idleNetwork.mount.test.ts lib/code/blame/__tests__/feature.mount.test.ts lib/code/__tests__/buffers.test.ts lib/code/workspace/quickOpen.test.ts lib/__tests__/codeEditorChunk.guard.test.ts plugins/contentOnlyHmr.test.ts plugins/tailwindWorker.test.ts
```
 Measured 2026-11-26 on this repo (14,155 tracked files) on a laptop at a load average of about 45.

| Budget | Test | Held |
| --- | --- | --- |
| Typing in a 5,000-line file with vim, a language server (publishing diagnostics and progress as you type), the git gutter, blame and a linked working session | `components/code/__tests__/typingAllFeatures.mount.test.tsx` | 0 React commits and 0 writes to the vault, code, git status, agent and inbox stores over 220 keystrokes and 8 vim motions; jsdom 0.7 ms median, 1.5 to 3 ms p95 per keystroke |
| A warm tab switch | the same file | the view holds the other file in the same task (no frame, no timer); the same view, never a remount |
| A burst of agent saves | `lib/code/__tests__/idleNetwork.mount.test.ts` | 500 watcher events: 1 file-table write, 1 git status |
| A hidden page | idleNetwork, `lib/code/blame/__tests__/feature.mount.test.ts` | 0 git status and 0 blame requests until shown, then 1 each |
| Agent writes to the open file | blame feature test | 1 blame request in flight per editor; writes while it runs cost 1 more |
| A file no editor holds | idleNetwork | a save drops its text; it is never read again until shown |
| Memory | `lib/code/__tests__/buffers.test.ts` | 70 files opened (seven of 12M characters): at most 40 buffers and 64M characters held (50M, 114 MB of heap); each eviction releases the vault store's copy |
| Quick open | `lib/code/workspace/quickOpen.test.ts` | under 16 ms a keystroke at 20,000 files |
| Bundle | `lib/__tests__/codeEditorChunk.guard.test.ts` | `src/main.tsx` and `src/boot.tsx` reach no CodeMirror, Lezer or vim module |
| Dev stylesheet | `plugins/contentOnlyHmr.test.ts`, `plugins/tailwindWorker.test.ts` | a save sends `globals.css` to open tabs only when it adds a class |

### Idle network, before and after

An open Files page in this repo, while agents save files:

| Cost | Before | After |
| --- | --- | --- |
| Dev stylesheet on each save of a `.ts`/`.tsx` file | `globals.css`, 900 KB, pushed to every open dev tab (hidden ones too): 181 of 182 HMR updates in one afternoon, bursts of 33 a minute, about 30 MB a minute a tab | nothing; one push when a save adds a class (checked on the live server: three saves, 0 updates; a new class, 1; its deletion, 0) |
| Each watcher event | one copy of the 20,000-row file table and a git status per burst | one write per 100 ms batch |
| A save to any code file opened earlier this session | its whole text read again (`store/inboxStore.ts` is 920 KB) | only files an editor buffer holds; a closed, evicted buffer's text is dropped |
| An agent writing the open file | a `git blame` per write (102 KB, 1.7 s of daemon time on a 1,400-line file), overlapping | one at a time, none while hidden |
| A hidden tab | git status after every burst, blame after every write | nothing until shown |

The vault socket itself is quiet: 11 events (1.4 KB) in ten minutes of this repo. A whole-vault rescan (`reset`, 1.4 MB) came only with each connection's hello.

### Measured once, not asserted

| What | Number |
| --- | --- |
| Main bundle (boot graph) | 2,383 KB gzipped; no CodeMirror module |
| Files route beyond boot | 483 KB gzipped, of which CodeMirror's view and state are 62 KB (`CodeWorkspace` -> `followFiles` -> `buffers`) |
| Editor beyond the Files route | 85 KB gzipped |
| Each feature beyond the editor | vim 37.5 KB, language server 45.1 KB, merge 10.1 KB, blame 4.0 KB gzipped |
| Each language beyond the editor | JavaScript/TypeScript 40.3 KB, Rust 37.3 KB, Python 26.6 KB, Go 20.4 KB, a legacy mode about 1 KB gzipped |
| Quick open, this repo's 14,155 paths | 7 to 12 ms for a 1 to 2 letter query, 1 to 3 ms for longer ones; the first call 26 ms (JIT) |
| First project search result (daemon, ripgrep) | 132 ms for a common identifier, 549 ms for a rare one, 328 ms to report none |
| Reading a file from the daemon | 920 KB in 2 ms |
| Daemon event loop | 190 `[LOOP-FREEZE]` lines in daemon.log, 169 in `checkoutReport.ts` (`attributeInSlices`); none in `/code`, `/vault` or `/lsp` |

Sizes come from `dist/.vite/manifest.json`, each chunk counted beyond the graph before it. Browser timings (input latency to the next frame, cold open, hover) are still to take: the dev app did not finish booting under that load.
