# Evals UI: implementation spec (ct-56695, plan pl-810)

## 1. Goal and done bar

**Goal.** Build an Evals area inside the codecast app. From the laptop that ran the evals, it should answer four questions:

1. Is any prompt surface getting worse over time, across models and prompt versions?
2. What exactly happened in one run?
3. Which source change caused a regression? Answer this from recorded runs for free where possible, and with a bounded, visible replay bisect where not.
4. What did the multiplayer store simulator do: which interleaving broke which invariant, and what is the smallest delivery order that still breaks it?

**Done bar.** All of these must be verified in the founder's Chrome through `cast browser`, against the real `EVALS_HOME`, with screenshots in the thread:

- `/evals` lists all 13 surfaces with a 30-day trend, the latest verdict, staleness and spend. It loads in under 2 s once the index is warm.
- Any run opens to a page that shows the frozen moment, the rendered prompt, the reply, every gate, the judge's reasoning, cost and tokens, and every call the guard caught. Nobody needs to open the run folder.
- A red batch gives an attribution answer. It names one of:
  - model or judge changed
  - freeze changed
  - live reads
  - a source range with its commits
  - noise
  - uncommitted edits that cannot be replayed

  When the range is wider than one commit, a bisect can be planned, priced, started, watched, cancelled, and read to a culprit commit or an honest non-source answer.
- The multiplayer sim area shows run history per scenario and mode, and a failing run as swim lanes. It can shrink the failing order and copy the three replay lines.
- No private freeze, run, moment or reply reaches Convex, IndexedDB, a published page, or a signal body beyond what signals carry today: the surface, freeze id prefixes, sha and bisect id.
- `cast check` is green for `cli`, `web` and `convex`, and every new test file passes when run directly.

## 2. Hosting decision

**Decision.** The Evals area lives in the codecast web app, in the full-width dashboard shell, registered the way the Memory page is. Its data comes only from the machine the browser runs on:

1. The page calls the daemon's existing loopback server, with the existing discovery, per-boot token and origin allowlist.
2. The daemon gains one generic route, `/evals/*`. It forwards each request to a child process that starts on demand: `bun <checkout>/packages/evals/src/index.ts api --stdio`, speaking line-delimited JSON.
3. The child runs the checkout's own eval code, reads `EVALS_HOME` and runs git.
4. Nothing goes through Convex.

**Reasoning.**
- The founder's reuse rule is satisfied in full. The app already has DiffView, ChangeCardView's before/after pair, the ActivityCharts brush and axis helpers, HoverTip, useContainerWidth, MiniTrace, KeyCap, SegmentedToggle, LocalDaemonUnreachable, the sol tokens, the OrgHistory/OrgHistoryView split pattern, the command palette and `cast app goto`.
- The investigation ends in places only the app can link to: the session that wrote a commit (its Codecast-Session trailer), the eval signal's cause task, and the Line page's Sense station.
- The repo-root `evals` script promises that release binaries carry no eval code (`evals:2-3`), and `cli/package.json` has no eval dependency. A forwarding child keeps that promise. Every verdict, flip and separation is computed by the same `verdict.ts` and `stats.ts` the CLI uses, so the UI and `./evals check` cannot disagree, and arbitrary pair compares need no precomputation.
- It keeps one port and one token, so the `localStorage.CAST_TERM_ENDPOINT` dev override (`lib/terminal/endpoint.ts:35-38`) still covers it.
- Private data never enters Convex, IndexedDB or the sync host.

**Alternatives rejected.**
- **A separate `evals ui` server in `@platform/evals` (Preact, own skin).** It rebuilds in another stack every component listed above, cannot link into sessions, tasks or the Line page, couples a vendored package to `globals.css`, and routes core changes through the vendor mirror. That mirror is a known trap that breaks every `cast` command when an export is missing. It would help eaiden and union, but they did not ask for this, and codecast pays for it.
- **A daemon route that only streams precomputed files** (a generic reader plus `batches.json`). This leaves no home for comparing any two batches unless the verdict logic is copied into web, which forks `majority()` and the flip logic. It also makes the precomputed attribution go stale whenever the index lags.
- **Importing `@codecast/evals` into the daemon.** It breaks the release-binary promise.
- **Static pages from `publish.ts`.** They cannot start or watch a bisect, cannot show private freezes, and cannot link into the store. They stay as they are, for public fixtures only.
- **Convex-backed eval tables.** These break the privacy rule outright.

**FOUNDER SHOULD CONFIRM:**
1. The daemon will exec a bun child that runs code from the codecast checkout named in `EVALS_HOME/checkout.json`. The mitigations are in 3.6.
2. The Evals area appears only on a machine with a checkout that has run `./evals`. Opened elsewhere, it explains that the evals live on the laptop that ran them.

## 3. Architecture

```
Chrome (codecast.sh or localhost:3200)
  /evals/* pages ── lib/evals/client.ts ── loopbackFetch (token, PNA hint)
        │
  daemon loopback server (daemon.ts chain, after handleMemoryHttp at :2449)
        └─ handleEvalsHttp (cli/src/evals/evalsServer.ts): CORS, authorizeLocalRequest
              └─ evalsBridge.ts: starts on demand, 10 min idle kill, stderr ring buffer
                    └─ bun <checkout>/packages/evals/src/index.ts api --stdio
                          ├─ index (EVALS_HOME/index/runs.jsonl, refreshed as it goes)
                          ├─ verdict.ts batchVerdict, history/{epochs,flips,attribution}
                          ├─ run folders, freezes, labels, state.json, git
                          ├─ spawns: ./evals bisect …, bun run sim … (in tmux)
                          └─ sim history (~/.local/share/codecast/sim/sessions)
```

### 3.1 Recording fixes (from now on)

These make attribution true going forward. The legacy history is handled in 3.3 and section 5.

| Field (run.json) | What | Why |
|---|---|---|
| `sourceHashDisk` | The surface's declared sources plus `packages/evals/fixtures` and `packages/evals/freezes` (`diskPaths`), hashed by `sourceHashes`' own formula over the tree the disk holds. That tree is HEAD with those paths `git add -A`ed into a private index (`GIT_INDEX_FILE`, so the checkout's index is never touched) and written with `write-tree` (`diskTree` in `provenance.ts`). Equal disks hash equal at any HEAD; a clean disk hashes as HEAD does over the same paths. | `sourceHash` hashes HEAD through `git ls-tree` (`state.ts` `sourceHashes`), so for the 81% of dirty runs it names code they did not run. `sourceHash` keeps its meaning for staleness. |
| `treePatch` | sha256 of `git diff --binary HEAD <disk tree>` over the same paths (untracked files included, since the private index holds them), stored at `EVALS_HOME/trees/<sha>.patch` (`homePaths().trees`). The disk is read once per check; each surface gets the patch over its own paths, content addressed so equal patches are stored once. `null` when the disk matches HEAD there. | Makes a dirty rep replayable: worktree at gitHead plus `git apply`. |
| `freezeSha` | sha256 of the freeze JSON (keys sorted, criteria and tags included) and its snapshot's content: a fixture's or stored snapshot's bytes, or every file of a served dir (`freezeSha` in `provenance.ts`, fed `resolver.ts` `snapshotPath`) | A changed moment or criterion becomes its own cause class instead of reading as a prompt change. |

Other recording fixes:

- **Pin refs.** At batch start, `git update-ref refs/evals/heads/<sha> <sha>` (`pinHead` in `provenance.ts`, which never throws; `replay.ts` `treeFacts` calls it once per `check` or `freeze replay`). `./evals pin --backfill` pins every head the run folders record (18 so far). Of those, 7 were already on no branch (1,956 runs) and could have been lost to `git gc`. `EVALS_HOME/heads.json` holds an entry for every pinned head: `{on: main|branch|none|missing, mainSha, how: self|patch-id|null, reason?, near?, subject, authoredAt, pinned}`. A head on main maps to itself. A head off main maps to the main-line commit with the same `git patch-id --stable`, found first among main-line commits with its author, date and subject, then across every main-line patch since a day before it was authored; otherwise `mainSha` is `null` with a reason, and `near` names a main-line commit with the same author, date and subject but a different patch (amended when it landed). On 2026-10-03, 5 of the 7 orphans mapped by patch-id; `bdedf4b4f` (amended, near `2bbfa75bd`) and `67fa6e7c5` (a `line verify` scratch commit that never landed) map to `null`. The refs are local and outside the default push refspec. **This ships first and alone.**
- **Agent dry runs write their follow-up turns.** `runAgent` returns from its dry branch before it writes `thenN.md` (`adapters/dryRun.ts:106-112`). Move the `thenN.md` writes above the dry return, and make the agent's promptSha cover `prompt.md` plus every `thenN.md`. Without this, the dry-render probe (section 5) is wrong for agent surfaces.
- **Keep every rejudge.** Every rescore or rejudge also writes `score.<stamp>.json` beside `score.json`, where the stamp is its `scoredAt` with `:` and `.` as `-`, the run folder's own stamp form (`layout.ts` `scoreVersionName`). The existing `score.before-rejudge.json` and `score.before-rescore.json` stay for compatibility. Before this, `grade.ts` `rescoreRun` lost every middle rejudge.
- **Cancel.** `check` honours `--stop-file <path>`, checked between reps next to the `--max-minutes` logic (`replayRep`, `stoppedBy: 'stop-file'`), and exits like a budget stop: a stop folder with `endedBecause: budget`, exit 3. `check --cadence bisect` (`BISECT_CADENCE`, defined in `verdict.ts`, whose baselines skip it, and re-exported by `check.ts`) stamps a bisect's probe reps; such a check leaves the cadence state alone (no `lastRunHash`, no crash streak, no `perRep`), because a probe ran another commit than the checkout's. The previous-set and pooled baselines in `verdict.ts` must still pass over `bisect` reps, or a normal check would weigh itself against a probe of an old commit.
- **Checkout pointer.** Every `./evals` invocation that goes through `main.ts` rewrites `EVALS_HOME/checkout.json` as `{root, at}` (`writeCheckoutPointer` in `provenance.ts`; `root` is the realpath of the checkout the code runs from). Two exceptions: the `stale` precheck, which `index.ts` answers before `main.ts` loads, and a tool copy running from a scratch worktree under `EVALS_HOME` (a `line` or bisect base), which is not a checkout.

### 3.2 The index

`EVALS_HOME/index/runs.jsonl` holds one `RunRow` per run folder (`history/runIndex.ts`). It is a pure cache that can always be rebuilt from the run folders, so it is never the source of truth. Each line is the row plus its rebuild `key`, so one atomic rename writes a row and its key together and two processes refreshing at once cannot pair a stale row with a fresh key. A line that fails `runRowProblems` on load is dropped and its folder read again.

- **Rebuild key.** Folder name plus the index version and the mtimes of `run.json`, `result.json` and `score.json`. Rescores and rejudges are picked up. A rep still being written has no key and is read again on every refresh until it lands. `batchAt`, `mainSha` and `offBranch` depend on other rows and on `heads.json`, so they are recomputed over the whole set on every refresh, with no folder read.
- **When it refreshes.**
  - `./evals index` refreshes it in full or incrementally, with progress on stderr.
  - The api child refreshes it lazily: `readdir` plus `stat`, at most once every 2 s per request (`maxAgeMs: 2000`), and holds it in memory. The stats are issued in parallel: at a load of 200, serial stats over 5k folders took 25 to 45 s and parallel ones about 1 s.
  - A CLI command that asks about one surface (`surfaceRuns`) checks only that surface's folders against the index.
  - Each write rewrites the file atomically, which also compacts it.
- **First build.** About 25k reads, done once, off the daemon's loop. The UI shows progress from `GET /evals/health`.
- **Row fields.** `id, surface, freezeId, freezeName, visibility, seed, stamp` (parsed from the folder name), `batch, batchAt` (the earliest stamp in the batch, because 33 of 164 batch names do not sort by time), `cadence, status` (pass, fail, crash, dry or unscored), `score, passMark, gatesFailed[], checks{id: score}, missedFloors, model, judgeModel, ruler` (`rulerOf`), `gitHead, mainSha` (through heads.json), `dirty, offBranch, treePatch, sourceHash, sourceHashDisk, promptSha, freezeSha, liveReads, costUsd, judgeCostUsd, realMs, guard{served, unserved, live, refused, unknown, help}` (parsed from `cast_call` events), and `scoreVersions` (a count).
- `adapters/runs.ts` `surfaceRuns` reads through the index, drops its 2,000 cap, and carries `gitHead, dirty, sourceHash, sourceHashDisk, promptSha, freezeSha, judgeModel, visibility`. They are optional on `SurfaceRun`, because tests build `SurfaceRun` literals without them; code that needs them for certain reads `RunRow`s through `indexedRuns`. The index keeps no sends count or notes, so `surfaceRuns` reports `sends: 0`; read the run for those.

### 3.3 Analysis library (one code path for the CLI and the UI)

- **`verdict.ts`.** `batchVerdict(meta, batch, history, {against, baselineBatches, ruler, earlierOnly}): BatchVerdict` chooses the baseline (named, the cadence's own last batches, or each freeze's newest other batch) and weighs the batch against it. A cadence baseline (`kind: pooled`) is weighed night by night per freeze (`separateNights` in `stats.ts`, fed by `nightStrata`; evals-home.md 2.8), not as one flat pool of reps, so its `p` is not a Mann-Whitney's; the other two use the per-rep Mann-Whitney (`separate`). A bisect probe (`cadence: bisect`, `BISECT_CADENCE`) is never a baseline, and a probe batch is itself weighed against each freeze's newest real batch. `verdictLinesOf(v)` prints today's lines from that value alone. `setVerdict` is the two plus the surface's own summary lines.
  - The functions take a `VerdictRun`: a CLI `SurfaceRun` or an index `RunRow` both fit. A rep's ruler is the row's `ruler` when it has one, else `rulerOf` reads its folder.
  - `BatchVerdict` holds: footing `{model, ruler}`; `set: BatchStats` (reps, passed, median, mean, min, max, cost, crashes, liveReads, dirty reps, gitHeads); baseline `{kind: previous|pooled|against, batches, reps, cadence, skipped}`, null only for a dry set; the compared scores; separation `{kind, p}`; footing notes for `--against`; `flips: VerdictFlip[]`; `gatesFailed`; the models.
  - A `VerdictFlip` names the freeze, the direction and the run ids on each side. The existing `EvalFlip` (`contracts/evalResult.ts`) carries reply text, which the verdict cannot fill without reading every flipped rep's folder, so the text travels separately as `examples: EvalFlip[]` on `/batches` and on the attribution, ready for ExamplePair (`flipExamples` in `history/flips.ts`).
  - The split left CLI output byte-identical: `analysis.test.ts` holds a snapshot of every line branch captured from the code before the split, and a replay of 515 recorded batches across all 13 surfaces (every batch, plus `--against` pairs) matched byte for byte with colour on. Two later changes moved lines on purpose, and the snapshot carries them: the nightly line reads "night by night" with the night-by-night separation, and the ruler lines name the write guard. On 2026-10-04 a replay of 713 real cases (every batch of the 6,035-row index plus each `--against` pair) through the committed split and the current code found 583 identical and the other 130 differing only by those two changes (10 nightly, 120 ruler wording).
  - `previousRuns` and `pooledRuns` take the newest *other* batches, later ones included. `check` always weighs its newest batch, so that never shows there, but a history view weighing an older batch passes `earlierOnly` to weigh it only against batches that began before it.
  - The exact Mann-Whitney count can take about a second on 100 reps against 20, so `batchVerdict` keeps the last 512 separations (separate() is deterministic).
  - Exported for the history modules: `footingOf`, `footingChange`, `verdictFlips`, `batchStats`, `batchStarts`, `upTo`.
- **`history/epochs.ts`.** These are prompt epochs for the legacy history, which needs no backfill.
  - Per surface, sort batches by when each began (its earliest rep). A new epoch starts at the first batch where any freeze renders differently from that freeze's previous appearance. Dry reps count as evidence here; bisect-cadence probes do not, because they render old commits on purpose.
  - What a freeze rendered in a batch is its promptSha, except where its reps disagree within a batch. `ask`'s second call quotes excerpts the first call's reply chose, so its promptSha differs on almost every rep (24 of 105 freeze-batches), and the naive rule would start an epoch at 13 of its 15 batches. For such a freeze the key is the prompt files that held still: every file seen to vary within a batch of that freeze is left out everywhere. Files are compared by size first and hashed only when sizes agree, and one rep stands for each distinct promptSha. Where no file holds still, and always for org-review, the key is the batch's most common promptSha.
  - On the real home (2026-10-04) the epochs match a hand count of promptSha changes per freeze, batch to batch, on 12 of 13 surfaces exactly (settle 1 over 22 batches, insight 26, anchor-brief 21, role-wake 8, org-review 6, ...). ask has 1 epoch where the hand count gives 14; at the file level only `call2/prompt.md` ever varies, always within a batch, and every other prompt file has one version across all 18 batches, so 1 is right. org-review (6) was also checked by hand at the file level.
  - Each epoch carries its first and last batch, its gitHead and its changed freeze ids. `footingMarkers` walks the same timeline for model and ruler changes.
  - The diff between two epochs is the per-freeze diff of `callN/system.md` (written only when the request has a system prompt) and `prompt.md` (or `agentN/prompt.md` and `thenN.md`) between the last rep before the boundary and the first rep after it. That is exactly what the model saw, dirty or not.
  - org-review is labelled "analyzer prompt only", because its promptSha covers only that prompt.
- **`history/flips.ts`.** Holds `flipsBetween(rows, batchA, batchB)` over one surface's rows, built from per-freeze `majority()` and `onePerSeed` on the freezes both batches graded (crashes and dry reps left out). It refuses with a reason when the footing differs on any such freeze, or when either batch graded nothing. `flipExamples(surface, freezeIds, a, b)` builds the reply text the way `line` does (`repsSurface`, `flipOf`).
- **`history/attribution.ts`.** Free and computed only from records. The algorithm is in section 5, Tier 0.
- **Platform.** `diffRuns(a, b): RunDiffEntry[]` is extracted from what was the inline flip block in `renderRunDiff` (gate flips, then check moves of `CHECK_MOVE` = 0.2 or more, in b's order) and exported from `@platform/evals/render` with `CHECK_MOVE`, `RunDiffEntry` (the same shape as the contract's) and `DiffableRun`. It reads only `verdict.gates` and `verdict.checks`, so a `RunDetail` fits and so does a bare `{ verdict: <score.json> }`. `renderRunDiff` formats from it, byte-identical to before. The api child's two-run compare uses it.

### 3.4 Contract and API

`packages/shared/contracts/evalsApi.ts` defines `RunRow, BatchVerdict, Epoch, Attribution, BisectPlan, BisectState, BisectStep, SimSession, SimRunRow` and the sim artifact shapes (`SimResult`, `SimEvent`, `SimWorld`, `SimFinal`, `SimMinimal`), and one request/response type per endpoint (one sim run in full is `SimRunResponse`). It gets its own `exports` entry in `packages/shared/package.json`, because a contract file without one kills every `cast` command.

It also holds the few runtime pieces every party must share:
- `EvalsRoutes`, a table from `METHOD /path` to its params, query, body and response. `EVALS_ROUTE_KEYS` lists the keys, and `matchEvalsRoute(method, path)` resolves one. The api child dispatches on it and the fixture transport answers through it.
- `runRowProblems(value)`, which says why a value is not a `RunRow`. The index writer and its tests hold every row to it.
- `EVALS_SHA_RE`, the bridge line types (`EvalsBridgeRequest`, `EvalsBridgeResponse`), and the error body with its unavailable reasons.

All paths are relative to `/evals`.

| Method, path | Returns |
|---|---|
| `GET /health` | checkout root, EVALS_HOME, indexed runs, index progress, child pid, eval tool gitHead |
| `GET /overview?cadence=` | per surface: route, model, batch strip (median, pass rate, n, cost, footing), latest BatchVerdict, staleness, 7-day spend, epochs; "what moved" events; open bisects; latest sim session. `cadence` is `all` (the default, since the agent surfaces and most call batches carry none), `named` (batches with no cadence) or a cadence name |
| `GET /surface/:id?from&to&model&cadence&dry&bisect` | RunRows, per-batch stats, epochs, footing markers, the freeze-by-batch majority grid, commits touching sources, and `latest`: the newest graded batch's BatchVerdict, weighed as the wall weighs it (`earlierOnly`) |
| `GET /freeze/:id` | freeze meta, label (or inline fixture label), rendered moment, production reply, RunRows |
| `GET /run/:id` | run.json, result.json, score.json plus every score version, sends, captures (request and reply), calls, agent turns, judge, guard lines, file tree |
| `GET /run/:id/file?path=` | one file inside that run folder |
| `GET /compare?a=&b=` | two runs: `diffRuns`, both replies, both prompts |
| `GET /batches?surface&a&b` | `batchVerdict` of b against a, `flipsBetween`, gate deltas, the prompt diff for one flipped freeze |
| `GET /epoch?surface&n` | epoch n against n-1: per-freeze prompt diffs, plus commits in the window |
| `GET /attribution?surface&good&bad&allCommits` | Attribution; `allCommits=1` searches every commit in the range (`--all-commits`) |
| `GET /commit/:sha?surface&whole=0\|1` | subject, author, date, session trailer, mainSha, diff (declared sources, or the whole commit) |
| `GET /patch/:sha` | one kept tree patch (`EVALS_HOME/trees/<sha>.patch`, else a Multiplayer sim session's `<sim home>/trees/<sha>.patch.gz`): its files with line counts (`git apply --numstat`, which applies nothing) and its text, cut at 2 MiB. The name is a full sha256 (`EVALS_PATCH_SHA_RE`, 64 hex), not a commit sha |
| `GET /changes?since=<cursor>` | new RunRows and bisect and sim changes since a cursor. The cursor is the child's clock in ms; a row counts as changed when the child saw its status, score, gates, cost or score versions move after it, and rows present at the child's first look count as old, so a child restart never replays the index |
| `POST /bisect/plan` | spawns `./evals bisect plan … --no-render --json`; returns BisectPlan with the cost bound. The Tier 1 renders can take minutes under load, past the bridge's 120 s limit, so the plan counts every candidate as its own class and `start` renders before it spends |
| `POST /bisect` | spawns `./evals bisect start … --id` in tmux; returns the id |
| `GET /bisects`, `GET /bisect/:id?since=` | list (each summary carries `updatedAt`, so a list can flag a stall, and the list names `running`, the bisect holding the one-bisect lock, else null); state plus steps after the cursor |
| `POST /bisect/:id/stop` | writes the stop file |
| `GET /sim/catalog` | `bun run sim --list --json` and `--invariants --json` (cached per gitHead), plus invariantCoverage exclusions; each grid cell carries `newestFailure` (the newest failing run with artifacts and the invariant its result.json names, null when there is none), which the cell's link and the invariant filter read. The grid is folded by the sim's own leaf `store/__tests__/sim/grid.ts` (`simGridOf`), which the fixture world calls too |
| `GET /sim/sessions`, `GET /sim/run/:session/:run` | history (each session with its `failing` rows of runs.jsonl); one run in full, with four replay lines: trace, full order, minimal order, and `bisect` (`./evals bisect start --sim <artifact folder>`, from the sim's `replay.ts` `bisectCommand`) |
| `POST /sim/shrink`, `POST /sim/sweep` | spawned in tmux; returns a job id that `/changes` reports on. A job is kept at `<sim home>/jobs/<id>.json`; a shrink reads `minimal.json(.tmp)` beside its run, a sweep the session it opened |

**Input validation, all in the child.**
- A sha must match `^[0-9a-f]{7,40}$` and pass `git rev-parse --verify <sha>^{commit}`. A tree patch name must be 64 lowercase hex and name a file under `EVALS_HOME/trees`.
- Batch names, run ids, freeze ids and surface ids must exist in the index or registry. The client never supplies a filesystem path.
- `file?path=` is resolved with `realpath` and must stay inside that run folder.
- Spawned commands are built as argv arrays and never pass through a shell string.

### 3.5 Daemon bridge (`cli/src/evals/`)

- `evalsServer.ts` copies `memoryServer.ts` (prefix check, CORS, `authorizeLocalRequest`, async dispatch, typed errors). It forwards `{id, method, path, query, body}` to the bridge and answers `{status, body}`. A method and path that `matchEvalsRoute` does not know get a 404 here, so a stray request never starts the child. A POST body that is not JSON gets a 400 here too.
- `evalsBridge.ts` handles the child process:
  - **Startup.** It starts the child on the first request, with `cwd` at the checkout root and PATH from `agentSpawnPath()`, because launchd hands the daemon a bare PATH. If bun is missing, the spawn fails with ENOENT and the bridge returns 503 `{reason: "no-bun"}`.
  - **Protocol.** One `EvalsBridgeRequest` JSON line per request on the child's stdin, and one `EvalsBridgeResponse` line per answer on its stdout, matched by `id`. Answers may arrive out of order. Any other stdout line goes into the stderr ring. The child must exit when its stdin closes, which is how it dies with the daemon even after a hard exit.
  - **Lifecycle.** It kills the child after 10 idle minutes with no request in flight, and restarts it on the next request after a crash. It keeps the last 40 stderr lines and returns them in a 502 `{reason: "child-crashed", stderr}`, so a checkout that is mid-edit shows its real error. For 5 s after a crash, requests get that same 502 without a fresh exec, so 3 s polling against a broken checkout cannot spawn bun in a loop. A request with no answer in 120 s gets a 504. When `checkout.json` names a different root than the running child's, the bridge validates the new root, and only when it passes ends the child and starts one there. Every checkout that runs `./evals` takes the pointer, a review or agent worktree at an old commit included, so a pointer that fails validation while a checkout is serving does not close the area: the running child keeps answering, or with none running the last root that passed is validated again and started, and the refusal is logged once. That refusal is remembered for 30 s, so polls against such a pointer do not spawn git on every request; with nothing to fall back to, the 503 is never remembered. Only one such check (pointer read, validation, start) runs at a time, and requests that arrive during it share its result, so a burst of polls after `./evals` runs from another worktree restarts the child once. The child can die during that check, so the check reads the child it captured, never the shared slot.
  - **Shutdown.** `daemon.ts` stops the child on daemon shutdown (`stopEvalsBridge`).
- **Checkout validation, before any exec.** The daemon refuses with a reason unless all of these hold:
  - `checkout.json.root` resolves with realpath to a directory owned by the current uid;
  - `<root>/evals` exists and its first three lines match the known header (`EVALS_SCRIPT_HEADER`; a test holds it to the repo's real script, so editing that comment fails a test rather than every machine);
  - `git -C <root> rev-parse --show-toplevel` equals root;
  - `<root>/packages/evals/src/index.ts` exists, and so does `packages/evals/src/commands/api.ts` (`EVALS_API_COMMAND`): a checkout from before the api command has the entry but answers `api --stdio` with its help and exit 1, so it is refused as `checkout-no-entry` before any exec.

  `CODECAST_EVALS_REPO_ROOT` overrides the pointer for development. The daemon cannot import the eval tool, so it resolves `EVALS_HOME` itself (`evalsHomeDir`), and a test holds that to `paths.ts` `evalsHome()`.
- All work is async, to respect the loop budget guard (`daemon.ts:2426-2428`). The daemon computes nothing.

### 3.6 Web side

- **`lib/evals/client.ts`.** A thin wrapper over `loopbackFetch` (`lib/vault/client.ts:70`), like `lib/memory/client.ts`. Every call is built as an `EvalsBridgeRequest` (`evalsRequest(key, args)`, typed by `EvalsRoutes`) and sent through a transport, so the loopback transport and the fixture transport take the same value the daemon hands the child.
- **`lib/evals/fixtureTransport.ts`.** Dev builds only (`import.meta.env.DEV`), read from `sessionStorage.EVALS_FIXTURE` (one tab) when set, else `localStorage.EVALS_FIXTURE`: `"1"` answers every route from `components/evals/__fixtures__/world.ts` (a seeded fake EVALS_HOME, all 13 surfaces, with the settle regression, model and ruler changes, live reads, a re-captured freeze, bisects and a shrunk Multiplayer sim failure built in). Its clock defaults to the start of the UTC day (`fixtureWorldNow`), so the batch names, run ids and sim session ids built from it hold still while a page or a pinned link is open. Its cadence mix follows the real index: agent batches carry no cadence and a call surface's nightly lands every third day, the rest by hand; `"no-daemon"`, `"no-checkout"` and `"child-crashed"` act out each failure screen. The world is a dynamic import inside the dev branch, so it never ships.
- **`lib/evals/hooks.ts`.** `useEvalsConnection` (connect on first mount), `useEvalsResource(key, args)` (a cached answer by request, painted at once when cached) and `useEvalsChanges(live, onChanges)` (the `/changes` poller below). Pages read data only through these.
- **`store/evalsStore.ts`.** A zustand store that lives in memory only, beside `memoryStore`, with states `idle | discovering | connected | no-daemon | no-checkout | child-crashed`.
  - It is not in inboxStore, the client sync registry or IndexedDB. This is local disk data, not Convex data.
  - A guard test fails if any `evalsApi` type is imported from `store/inboxStore.ts`, `store/clientSyncRegistry.ts` or `store/idbCache.ts`.
  - Failures are classified once (`classifyEvalsFailure`): a 502 or `child-crashed` moves the area to `child-crashed` with stderr; a checkout reason or `no-bun` to `no-checkout` with the reason in words; a 404 with no reason (a daemon without `/evals`) or a 401/403 to `no-daemon`; a 404 the child wrote (`reason: not-found`) stays that page's problem.
- **Live updates.** While a view shows live work (a running batch, a bisect, a shrink or a sweep), it polls `GET /changes?since=` every 3 s. Polling pauses when the tab is hidden. A job with no new step for 5 minutes shows "stalled?".
- **Routing.** Register one area, `/evals` and `/evals/*`, rather than eight route families. This keeps edits to shared files to one pass.
  - Files to edit: `App.tsx` (routes `evals` and `evals/*`), `RoutePane.tsx` (patterns `/^\/evals$/` and `/^\/evals\/(.+)$/`, one component, so moving between views reconciles), `lib/pageLayout.tsx` (full width), `lib/desktopHandoff.ts` ("evals" in the in-shell set), `routes.manifest.ts` (entries `evals` and `evals/*`), `pathLabel.ts` (`evalsTabLabel`, so a tab reads "settle" or "Multiplayer sim", not a path), `CommandPalette.tsx` ("Evals", "Multiplayer sim"), and `appSurfaces.ts` (`evals` and `evals/sim`).
  - `routes.manifest.test.ts` reads a trailing `(.+)` in a RoutePane pattern as the splat `*`, and counts a surface as served when a splat route sits above it (`evals/*` serves `evals/sim`). A single `^/evals(/.*)?$` pattern is not readable by that parser.
  - `app/evals/page.tsx` dispatches sub-paths through a pure `parseEvalsPath()` in `components/evals/evalsPaths.ts`, and lazy-loads each view's page. That file also builds every href (`evalsHref`), resolves the nav's search box (`evalsSearchTargets`) and names tabs (`evalsTabLabel`).
  - Links inside the area go through `EvalsLink` (`parts.tsx`): a plain click is a router push, which moves the pane the page sits in, so a split sibling stays put; `next/link` would move the active tab instead.

  Sub-paths:

  | Path | View |
  |---|---|
  | `/evals` | home |
  | `/evals/s/:surface` | surface |
  | `/evals/f/:freezeId` | freeze |
  | `/evals/r/:runId` | run |
  | `/evals/compare?a=&b=` | compare two runs |
  | `/evals/bisect` | bisect list |
  | `/evals/bisect/new?surface&good&bad` | attribution and launcher |
  | `/evals/bisect/:id` | one bisect |
  | `/evals/sim` | sim catalog |
  | `/evals/sim/:session/:run` | one sim run |
  | `/evals/c/:sha?surface=` | one commit (CommitPanel), its diff limited to the surface's declared sources when one is named |
  | `/evals/p/:sha` | one kept tree patch (PatchPanel) |

  `/evals/f/:freezeId` also takes `?a=&b=`, two run ids that open on the cards in place of the freeze's default pair; a flip's links pass its before and after reps that way.

- **Page structure.** Every page is a connected `pages/XPage.tsx` plus a props-only `XView.tsx`, with a fixture and a mount test, following OrgHistory and OrgHistoryView.
- **Failure screen.** `LocalDaemonUnreachable` gains two reasons (`LocalUnreachableReason`):
  - `no-checkout`, "No codecast checkout has run ./evals on this machine", with the specific checkout reason (or `no-bun`) as its detail line;
  - `child-crashed`, "The evals process crashed", which shows its stderr (the `stderr` prop).

### 3.7 Multiplayer sim changes

- **History** (`sim/history.ts`; details in multiplayer-sim-harness.md section 3.12). Every `bun run sim` that runs tests writes a session folder at `<home>/sessions/<stamp>/`, where `<home>` is `$CODECAST_SIM_HOME`, else `~/.local/share/codecast/sim`. `--list`, `--invariants`, `--help` and `--shrink` write none.
  - `session.json` holds `{id, argv, gitHead, dirty, treePatch, startedAt, finishedAt, exit}`. `treePatch` is the sha256 of the uncommitted edits under `packages/web`, `packages/convex`, `packages/shared` and `platform/packages` (untracked files included), stored gzipped at `<home>/trees/<sha>.patch.gz`; it is computed while the tests run, so it lands with `finishedAt`.
  - `runs.jsonl` gets one line per scenario run: `{scenario, mode, seed, passed, deliveries, ms, dir?}`.
  - Failure artifacts go into `<scenario>-<mode>-<seed>/` inside the session: the runner passes the folder as `SIM_SESSION`, and `artifactRoot` picks `SIM_OUT`, else `SIM_SESSION`, else the temp dir. The known check (a scenario's first run again with nothing left out) writes `<scenario>-<mode>-<seed>-known/`, so it never overwrites that run's folder.
  - Full artifacts for passes are written only with `--keep` (`SIM_KEEP=1`) or `SIM_OUT`, so a `--sweep` does not write a thousand folders. Artifacts sent to `--out` outside the session get no `dir`.
  - The 200 newest sessions are kept. Older sessions with no failed run and a zero exit are pruned, with the tree patches only they named. A session with no `finishedAt` is left alone for a day.
  - Legacy `$TMPDIR/codecast-sim/*` folders, and a bare `bun test` run's, are shown read-only as "unsessioned".
- **result.json** gains `gitHead, dirty, startedAt, realMs`, and `minimalOrder` once a shrink has run.
- **Step markers.** `events.jsonl` gains `{seq, kind:"step", verb, actor, label}` rows from `dsl.ts`. A verb's row sits where its `actor:` delivery ran and carries that delivery's seq; a settle or point check's row sits where it began, with `seq` 0, actor `world` and verb `settle`, `expect` or `inspect`. Delivery rows carry no `kind`, old and new alike, and read as `kind:"delivery"`.
- **Shrink.** `bun run sim --shrink <artifactDir>` runs the pure ddmin in `sim/shrink.ts`.
  - The input is the recorded `--order` prefix.
  - A candidate reproduces only when the same invariant id fails on the same table and row. An `order-mismatch` or any other failure counts as not reproduced.
  - It first binary-searches the shortest prefix (order mode keeps running as scripted once the list is used up, per `net.ts:16-20` and `:355-363`), then runs ddmin over the entries of that prefix.
  - Each attempt is a subprocess (`sim.ts` spawns `bun test --isolate`). The caps are 400 attempts and 10 minutes.
  - The empty order is tried right after the full one: when it fails the same way, no pinned order is needed. A candidate runs as the scenario's one test at that seed (`-t`), so sibling scenarios in its file cost nothing.
  - It writes `minimal.json` as `{order, removed, attempts, ms, oneMinimal}`, and `minimal.json.tmp` with progress while it runs. `order` is the kept channels and `removed` indexes the recorded channels; a scripted run's leading `scripted` mark is in neither and is never removed. `result.json` gains `minimalOrder`, the `--order` value with the mark.
  - It adds a third replay line (`replayLines(ctx, minimal)`, or `replayCommands` from result.json's facts).
  - An empty `SIM_ORDER` is an order replay too (the DSL tests for a set value, not a non-empty one), so an empty minimal order replays. Replay lines print the order as one word, `--order="<order>"` (`--order=""` when empty), because `bun run` drops an empty argument and `--order ""` would reach sim.ts as a bare flag.
  - A filter that is exactly a scenario's name runs that scenario alone, so replay lines work for a scenario that shares a file (`agentPingPongOwnSessions`).
- **`--list --json` and `--invariants --json`.**
- The UI always calls this "Multiplayer sim", to keep it apart from `@platform/evals`' persona `sim` command.

## 4. Views

Shared parts (`components/evals/parts.tsx`):
- **VerdictGlyph:** filled disc for pass, ring for fail, cross for crash, half disc for mixed.
- **ScoreBar**, with the 0.7 pass mark.
- **ProvenanceChips:**
  - gitHead, which opens its commit (`/evals/c/:sha`, scoped to the rep's surface)
  - `dirty`, which opens the patch (`/evals/p/:sha`) when one was kept
  - `off-branch`, showing its main twin
  - epoch `eN`
  - batch and cadence
  - `live reads N`, labelled "not reproducible"
- **LockBadge:** private or public.
- **CopyCommand.**
- **ReplyCard:** verdict, score, model, batch, gitHead, failed gates, judge reasoning.
- **PromptDiff:** a DiffView wrapper that takes two run ids and a file name.
- **batchLabel / whenLabel** (`format.ts`, re-exported from `parts.tsx`): one batch reads the same on every page, as when it began in the viewer's local time; a batch whose name is not a time keeps its name. Matching a batch across pages is how a bisect is read, so no page slices the UTC name.
- **FlipRunLinks / flipFreezeHref:** a flip's before and after run, and its freeze opened on those two reps.

### 4.1 Home: the surface wall (`/evals`)

**Purpose.** One glance to see whether anything is getting worse, and where. It also routes into every other view.

**Layout.**
- **Top: the local nav.** It holds Surfaces, Bisects and Multiplayer sim, plus a search box that accepts a surface, a freeze id prefix, a batch, a sha or a run id prefix.
- **Main: one full-width row per surface.** Call surfaces come first, then agent surfaces. Rows whose latest batch separated worse sort to the top and get a magenta left edge. Each row shows:
  - the name and a route chip
  - the pinned model
  - a 30-day ScoreStrip: batch medians as a step line over faint rep dots, with the 0.7 hairline
  - epoch notches on the strip's baseline
  - footing markers: a diamond for a model change, a slash for a judge ruler change
  - the latest pass rate in large tabular figures
  - a verdict glyph against the pooled or previous baseline: better, worse, not separated, or too few
  - the staleness word (stale, waiting, due or blocked)
  - 7-day spend, summed from the index's `costUsd + judgeCostUsd`, never from `spend.jsonl`
  - a pulse while a batch is still landing
- **Right column: "What moved".** The last 12 events across all surfaces: an epoch began, the footing changed, freezes flipped, a bisect finished, a sim failure. Each is one clickable line.
- **Footer.** A per-day spend strip, compact ribbons for open bisects, and the latest Multiplayer sim session as one line (scenarios, failures).

**Interactions.**
- One shared hover cursor runs across all strips (the HealthStrip pattern). Its tooltip shows the stamp, batch name, gitHead chips, median, reps and cost.
- Clicking a row opens the surface page. A worse row opens it with its red batch and the newest batch of its baseline pinned (`rowHref`, the same pair `b` uses), so the surface page opens on the comparison the wall made. Clicking a strip point opens the surface page with that batch pinned.
- Keys: `j`/`k` move between rows, `Enter` opens one, and `b` opens `/evals/bisect/new` prefilled with the newest worse pair. All keys render as KeyCap and are registered in `shortcuts/`.
- A Cadence filter (all, nightly, named) uses SegmentedToggle. It defaults to all, as `/overview` does: the agent surfaces and most call batches carry no cadence (on the real index, anchor-brief, role-wake and org-review have no nightly row and 795 of settle's 1,124 rows are by hand), so a nightly default hides most of the wall.
- The row says what its verdict weighed: the baseline ("vs pooled 3") stays beside any flips ("vs pooled 3, 2 broke"), and titles name the test and the batches ("One-sided Mann-Whitney of the latest batch's scores against 3 pooled nightly batches: ..."). The strip's header reads "median score per batch", since the big figure beside it is the pass rate. An open bisect's ribbon says "stalled?" by the bisect page's own rule (`isBisectStalled` in `bisectModel.ts`).

**Data.** `GET /overview`.

### 4.2 Surface over time (`/evals/s/:surface`)

**Purpose.** Show how one surface moved across time, models and prompt versions, which freezes flipped, and the hop to attribution.

**Layout, top to bottom.**

1. **Header.** Title, route, pinned model, criteria (collapsible), and freeze count split into public and private. Under the chips, the latest batch's verdict as the wall weighed it (`SurfaceResponse.latest`): its separation and p, its baseline by kind with the batches named, its flips, and "Compare with its baseline", which pins that pair. The drawer's own separation then reads "against batch 1 alone", so a single-batch p is never mistaken for the wall's pooled one.
2. **Seismograph.** Full-width hand-drawn SVG.
   - The x axis is time by `batchAt`, with a toggle to "ordinal by batch". The y axis is score from 0 to 1.
   - Every rep is a dot, jittered within its batch column: filled for pass, hollow for fail. A gate failure drops to 0 with a short red tick.
   - Dirty reps are hatched. Dry reps and `bisect` cadence are hidden by default.
   - The batch median is a step line, and 0.7 is a ruled line.
   - Epochs are alternating faint bands labelled e1, e2 and so on along the top. Footing markers sit on the axis, and so does a tick for each commit that touched the declared sources in the window (`SurfaceResponse.commits`); its tip names the sha, subject and author, and a click opens the commit.
   - A "facet by model" toggle splits the chart into one lane per model, telling models apart by marker shape (circle, square, diamond) and colour.
3. **Cost track.** A thin bar per batch, split into model spend and judge spend.
4. **Freeze ledger, the assay plate.**
   - Rows are freezes, each with its lock or public badge and name. Columns are the same batches.
   - Each cell is a well: its fill density is the mean score, and its ring is the majority verdict.
   - A flip on the same footing gets a notch: magenta when it broke, cyan when it was fixed.
   - Rows sort by most flips. With two batches pinned, the freezes that flipped between them (the drawer's `/batches` flips) come first, broke before fixed, each marked before its name. The header reads "6 freezes, 54 flips on the same footing".
5. **Compare drawer** (right side). It opens when two columns are pinned and shows:
   - both sets (n, passed, median, cost) and the separation verdict with p;
   - newly failing gates;
   - flips as ExamplePair tiles, each with its before and after run linked and its freeze opened on those two reps;
   - the PromptDiff for the first flipped freeze, with a freeze picker;
   - a button, "Attribute this", which goes to `/evals/bisect/new?surface&good&bad`.

**Interactions.**
- Brush the x axis to zoom (`useDayBrush`, `BrushRect`, `timeAxisLabels`).
- Click a column to pin it; shift-click a second column to compare.
- Click an epoch label to open EpochDiffSheet: per-freeze prompt diffs plus the commits in the window.
- Click a dot to open its run, a ledger row to open its freeze, or a cell to open that freeze filtered to that batch.
- Keys: `[` and `]` step the pinned column, `e` opens the epoch diff, `b` attributes the pinned pair.
- Filters: cadence, model, dry, dirty, bisect batches.

**Data.** `GET /surface/:id`, `GET /batches`, `GET /epoch`.

### 4.3 One freeze across time (`/evals/f/:freezeId`)

**Purpose.** Show which freeze flipped and what its replies looked like before and after, next to the moment the surface answered.

**Layout.**
- **Left pane (40%).** The label card on top (verdict and why, from `labels/` or the inline fixture), then the production reply pinned, then the frozen moment with a "frozen here" cut. The moment is rendered by the child through `describe`/`judgeMoment`, falling back to `judge/prompt.md`.
- **Right pane.**
  - A strip of every rep of this freeze over time, as dots in batch columns with epoch bands.
  - Two ReplyCards. By default they are the last pass before the newest flip and the first fail after it.
  - A "prompt changed" banner between the cards when their promptSha differs, with an inline PromptDiff.

**Interactions.**
- Click any two dots to set the cards, and swap the cards between prod, A and B.
- Copy `./evals freeze replay <id> --reps 3`.
- "Attribute this freeze" goes to the launcher limited to this freeze, which keeps probe cost lowest.

**Data.** `GET /freeze/:id`, `GET /run/:id` for the two cards, and `GET /surface/:surface` (cached, shared with the surface page) for this freeze's ledger row and the footing markers. `FreezeResponse` carries the reps but no majority or flip per batch, so the default pair reads where it flipped from the ledger cells the child computed: the page and the plate cell it was opened from cannot disagree, and the web side never re-implements `majority()`. The pair waits for that answer (or its failure, which falls back to the newest two graded batches and says so).

**As built.** `FreezePage.tsx` is the connected page and `FreezeView.tsx` the props-only view, with the pure `defaultFreezePair`, `promptFilePairs`, `replyOfRun` and the reusable `MomentPane` exported from it; `__fixtures__/freeze.ts` is settle's `unresolvable-error` breaking at its newest epoch. The rep strip is ordinal by batch, hides dry and bisect reps (counted in its legend), and a click on a dot sets A, the next sets B. It draws through the seismograph's own pieces, exported from `Seismograph.tsx` (`RepMark`, `RepHatch`, `EpochBands` over `epochBandsOf`, `medianOf`, `RepTip`) and `FootingGlyph` from `charts/ScoreStrip.tsx`, so a rep looks the same on both pages: a failed gate drops to 0 with the red `ev-gate` tick and a dirty rep is hatched. The strip adds only the ledger's flip notches and the A and B rings. The heading over the cards describes the pair on screen (`pairStory`): the default pair keeps its reason, and a picked pair names each rep's seed, batch and verdict. "Attribute this freeze" takes its ends from the pair's rows in `FreezeResponse.runs` (`attributionEnds`), the earlier batch as good and the later as bad whichever card holds which, so a pick counts before its cards load. The cards stack A, the "prompt changed" banner, then B, so the banner sits literally between them; a toggle pairs production with A or B instead, and a swap button exchanges A and B. The two panes sit side by side (40/60) from 1,080px of page width, and below that the reps come first.

### 4.4 One run in full (`/evals/r/:runId`)

**Purpose.** Everything one rep did, and why it scored what it did.

**Header.**
- The verdict glyph and the score set large against the 0.7 mark.
- Chips: surface, freeze with lock, seed, model, judge model, ProvenanceChips, and cost (model plus judge) with wall time.
- A seed strip: this batch's other reps on the same freeze, as dots, to tell whether this rep is typical.
- When the rep crashed, the tail of `run.log` shows at the top.

**Tabs.**

1. **Verdict** (the default).
   - The reply first (the sends, else the last call's reply), so the judge's reasoning below reads against what it judged.
   - Failing gates, then passing gates. Each row shows the glyph, id, decidedBy and evidence summary; a gate with nothing to check reads "held, nothing to check".
   - Then the judged checks, each with weight, a score bar against its `must` floor, and the full reasoning, then missed floors.
   - When the rep has no score yet, the tab shows the rubric it will be held to.
   - Then the score history: every `score.*.json` as a row with judge model and scoredAt. Legacy runs are labelled "first and latest only".
   - Every gate and check has a URL fragment (`#gate-no-leak`, `#check-criteria`).
2. **Moment and reply.** The moment on the left. On the right, this rep's sends (rail, audience, chars), with a toggle to overlay the production reply.
3. **Calls.** One block per `callN`: the request (model, max_tokens, temperature), `system.md` and `prompt.md` in collapsible code panes, the reply, stopReason, tokens including cache tokens, and cost. Each prompt has a "diff against the previous epoch" button.
4. **Agent** (agent routes only). `stream.jsonl` as turns and tool calls, plus `brief.md`, `said`, and `args.json` (serve, guard, tools, maxTurns).
5. **Guard.** A count strip, then `calls.log` as a table with a status chip per line:

   | Status | Chip |
   |---|---|
   | SERVED | neutral |
   | UNSERVED | yellow |
   | LIVE | red (a reproducibility leak) |
   | REFUSED | orange (an attempted write) |
   | UNKNOWN | violet |
   | HELP | dim |

6. **Files.** The folder tree, each file opening read-only.

For org-review, the Verdict tab also shows `grade-auto.json` and `hashes.json`.

**Interactions.**
- `j`/`k` move to the previous or next seed. `[`/`]` move to the same freeze in the previous or next batch.
- `c` picks a second rep and opens `/evals/compare`, which shows the `diffRuns` list (gate flips, check moves of 0.2 or more), both replies, and both prompts diffed.
- Copy the run path, the replay command or the rescore command.

**Data.** `GET /run/:id`, `GET /run/:id/file`, `GET /compare`.

### 4.5 Attribution and bisect (`/evals/bisect/new`, `/evals/bisect/:id`, `/evals/bisect`)

**Purpose.** Take a regression to the source change responsible. Spend nothing when the records already answer, and only the shown bound when they do not.

**The new page** has three parts.

1. **Endpoints.** Good and bad, as batches or shas, editable.
2. **The free answer** (Tier 0), drawn as a fixed-order checklist: footing, then freeze, then live reads, then source, then noise. The first line that differs is lit and gives the answer. When the answer is source, the page shows:
   - the flipped freezes as ExamplePair tiles;
   - the recorded batches that narrowed the window;
   - the epochs inside the window with their PromptDiffs;
   - the candidate commits (sha, subject, session pill, off-branch mapping), each opening its CommitPanel in place, and the uncommitted patch opening its PatchPanel;
   - a confidence: pinned, narrowed or unattributable.

   When it is pinned, a CommitPanel is shown and there is no Start button.
3. **The plan.** Shown only when the range is narrowed but not pinned.
   - Tier 1 render classes. The page plans with `--no-render` (the renders can outlast the bridge's 120 s), so until Start renders them the panel says each candidate counts as its own class, which is how the bound is priced.
   - The freeze set, defaulting to the flipped freezes plus 2 stable controls.
   - Reps (3 to 7), budget and max minutes.
   - The cost line in plain words, for example: "2 controls + up to 2 probes + confirmation, 3 freezes, 3 to 5 reps: at most 110 reps, about $2.20, budget $2.60".
   - Agent surfaces show a confirm checkbox.
   - Start (`Enter`).

**The live page** centres on the commit ruler.
- Candidate commits are tiles in ancestry order: sha, subject, and the session pill from the trailer. Tiles in one render class are bracketed together. The uncommitted patch is a hatched last tile.
- Good and bad brackets slide inward as probes resolve. Recorded batches already inside the range appear pre-filled with the tag "recorded". The control columns sit at both ends.
- Each probed tile grows a column of wells, one per rep per freeze, that fill as reps land.
- The right rail shows spend against budget, probes left, elapsed time, the tmux session name, Stop, a stall flag, and a log tail.
- When the bisect finishes, the result card shows:
  - the culprit commit (or a range, when the answer is unsure) as a CommitPanel: the diff limited to declared sources, a "whole commit" toggle, and the session link;
  - the PromptDiff for the flipped freezes;
  - before and after ExamplePairs;
  - the confirmation separation with p;
  - which tier produced the answer.

  If the controls did not reproduce, the page instead shows a plain banner: "Does not reproduce on today's tool and judge: drift, not source."

**The list page** shows past bisects with surface, endpoints, outcome, culprit, spend and duration.

**Data.** `GET /attribution`, `POST /bisect/plan`, `POST /bisect`, `GET /bisect/:id`, `GET /commit/:sha`.

### 4.6 Multiplayer sim catalog (`/evals/sim`)

**Layout.**
- **The grid.** Rows are the scenarios plus the selftest. Columns are scripted and interleave modes. Each cell holds the latest result and a sparkline over sessions (seeds run against seeds failed). Red and known markers carry a dotted ring and link to their task. Each row shows its newest gitHead and the time since its last run.
- **Side panel.** The 15 INV-* ids, each with its meaning and how many failures it caught. Below them, the invariantCoverage list of store keys deliberately not compared, each with its reason.
- **Below the grid.** Sessions in time order: argv, gitHead, dirty, duration, pass and fail counts.
- **A sweep bar.** A filter and a seed count, which spawns `bun run sim <filter> --sweep N` in tmux and shows live progress.

**Interactions.** Click a cell to open its newest failing run (`SimGridCell.newestFailure`, so a cell whose latest session passed still reaches its last failure). Filter the grid by invariant: a row stays when a cell's newest failure broke it or a red or known marker names it.

### 4.7 One multiplayer sim run (`/evals/sim/:session/:run`)

**Layout.**
- **Failure card.** Scenario, mode, seed, gitHead, the step, the invariant id and meaning, and the window (name, principal, scope). The row diff is a table of field, server value and replica value. For INV-followers the `server` side of result.json holds the host window's row (`invariants.ts`), so its columns read host and follower, named by window from world.json (`rowDiffSides` in `simLanes.ts`).
- **Swim lanes** (DeliveryTimeline).
  - Devices are groups, each with its windows as lanes (from `world.json`). Below them are lanes for sched, timers and actors.
  - The x axis is delivery order: a delivery's position among the delivery rows of `events.jsonl`. Its `seq` is its enqueue number, which runs out of order (a real run delivers seq 3, 9, 1, ...), and `due` is not always +0 (a timer is due 60 s later), so neither can place it.
  - Channels map to lanes like this:

    | Channel | Drawn as |
    |---|---|
    | `conn:<win>`, `live:<win>:<feed>` | a tick in the window's lane; the feed sets the tick colour |
    | `repl:a>b` | a short arc between the two window lanes |
    | `bridge:<dev>:<from>` | a mark in the device header |
    | `timer:`, `sched`, `actor:` | a tick in their own lane |

  - Step rows are labelled vertical bands, and closed windows end their lane.
  - The failing delivery has a magenta rule through every lane. result.json's `delivery` is a count (the check failed after that many deliveries), so the rule sits on index `delivery - 1`.
- **Order strip.** The full recorded prefix as channel chips. After a shrink, removed chips fade to 25% and the lanes dim every delivery not in the minimal order. A caption reads, for example, "17 recorded, 4 needed (1-minimal)".
- **Replay box.** Trace, full order and minimal order lines, each copyable.
- **From `final.json`, collapsed.** Calls and actor verbs that errored, and window errors.

**Interactions.**
- Arrow keys or a draggable playhead step one delivery, highlighting its producer and label. The keys are registered in `shortcuts/` under the `evalsSim` context: left and right step, Home goes to the first delivery, End to the failing one, `P` plays. Clicking an order chip moves the playhead to it.
- Clicking a label filters the lanes to the deliveries that touch it (the same as `--trace`).
- "Shrink" posts `/sim/shrink` and shows attempt progress.
- "Bisect this failure" is the free sim bisect (wave 3, cut-able).

## 5. Bisect mechanics

The UI always says which tier produced an answer. The CLI is the engine, and the UI only launches and watches it:

```
./evals bisect plan   <surface> --good <batch|sha> --bad <batch|sha> [--freeze ids] [--reps n] [--no-render] [--json]
./evals bisect start  <surface> --good … --bad … [--freeze ids] [--reps n] [--budget usd] [--max-minutes n] [--all-commits] [--no-render] [--yes] [--id id]
./evals bisect resume <id> ; ./evals bisect status|watch|stop <id> ; ./evals bisect ls
```

`--good` and `--bad` may be left out; Tier 0 then finds them from the records. `plan` runs the Tier 1 renders unless `--no-render`, which can take minutes on a loaded machine (a worktree per candidate), so a caller that wants the free answer at once passes `--no-render` and lets `start` render: `start` writes its state before the first render, so a page watching the id sees it plan. With `--json`, stdout is the plan alone and progress goes to stderr.

### Tier 0: attribution from records (free, instant; `history/attribution.ts`)

1. **Endpoints.**
   - B is the red batch: it separated worse against its baseline (weighed with `earlierOnly`), or a freeze broke. Left out, it is the newest such batch.
   - G is the newest earlier batch on the same footing in which each flipped freeze passed by majority; in score mode, the newest batch of B's baseline. A user-picked G is accepted. Either end may be a sha: it stands for the newest clean batch that ran on it, or for the bare commit (an orphan through `heads.json`).
   - The flipped freezes come from `flipsBetween`. For a score-only regression with no flips, take the 3 freezes with the largest median drop.
2. **Classes, in a fixed order.** The first one that differs between G and B is the answer:

   | # | Class | Test | Outcome |
   |---|---|---|---|
   | 1 | Footing | model or `rulerOf` differs | stop |
   | 2 | Freeze | `freezeSha` differs; for legacy runs, a public freeze's pointer or committed snapshot changed in git between the two heads (one `git diff --name-only`). A private legacy freeze cannot be told and reads as unchanged, which the line says. | stop |
   | 3 | Live reads | `liveReads > 0` on B | not reproducible |
   | 4 | Source | `sourceHashDisk` differs, or the rendered promptSha differs on a flipped freeze; for legacy runs (no `sourceHashDisk`), the commit differs | continue to step 3 |
   | 5 | Noise | nothing differs | stop |

   The classes are tested on the flipped freezes (in score mode, the largest drops). Each checklist line says truthfully whether its class differs; the first that does is the answer.

3. **Candidates.** `git rev-list --ancestry-path G.mainSha..B.mainSha -- <declared sources ∪ fixtures ∪ freezes ∪ judge prompt ∪ models.ts>`, using the union of both sides' registries.
   - Orphan heads resolve through `refs/evals/heads/*` and `heads.json`.
   - B's `treePatch`, when B was dirty and has one, is appended as a virtual candidate: "uncommitted edits on top of <sha8>".
   - When no declared source moved, the answer says so ("no declared source moved"), and `--all-commits` widens the search to every commit in the range.
4. **Narrow for free** (`narrowByRecords` in the contract, which `attribution.ts` and the fixture world both call). Every recorded batch whose head lies inside the range, on the same footing, that ran a flipped freeze, and that is clean or carries a `treePatch`, is classified with the probe rule. The range then shrinks to the adjacent good/bad pair of these recorded batches. A batch on edits that reads bad may owe it to those edits, which land as later commits, so only a clean bad batch moves the bad bound; a good reading moves the good bound either way. B's patch candidate stays only while no clean recorded batch reads bad.
5. **Confidence.**
   - pinned: one candidate left. The answer is that commit, with no spend.
   - narrowed: k candidates left.
   - empty: no candidate left, because no declared source moved in the range or the recorded batches bracket a stretch that touches none. The answer says how many commits the range holds (`rangeCommits`) and offers `--all-commits`; it is never "narrowed".
   - unattributable: an endpoint was dirty, has no patch, and is not mapped by Tier 1; or an endpoint's head is on no branch with no main-line twin (the reason and `near` from `heads.json` are quoted); or G is not an ancestor of B. The candidates are still listed, and the reason says why none can be trusted.
6. **The prompt diff is always shown,** whatever the confidence. Both reps share the moment, so the diff of their rendered prompt files is exactly the prompt change.

### Tier 1: dry render probes (free, takes minutes; `bisect/probe.ts`)

At each candidate commit, build `prepareTreeAt(sha, {patch})` (`line.ts`; the line's base tree uses it too): a detached worktree under `scratch/` with today's eval tool, freezes and fixtures; that commit's surface adapters; node_modules borrowed per entry (`borrowNodeModules`: installed packages link to the checkout's, and a workspace link such as `@codecast/convex` or `@codecast/shared` points at the tree's own copy, since linking the checkout's whole `node_modules` made every tree load the checkout's convex and shared code); then missing imports pinned (`pinMissingImports`): a tool file's import that the commit cannot satisfy, a relative helper or a workspace package subpath alike (today's index reads `@codecast/shared/contracts/evalsApi`, which older commits lack), reads this checkout's copy. Package imports are followed as bun resolves them in the tree, which is why the borrow comes first. For the patch candidate the dirty rep's patch is applied with `git apply` on top of the commit's own surfaces and prod code, the replayed moments (fixtures, freezes) left out because they are today's.

- Run `baseLoadErrors` first. A surface that does not load at that commit is marked `skip`.
- Then run `check <surface> --dry --reps 1 --freeze <flipped> --batch bisect-render-<tool9>~dry-<sha9>[+<patch8>] --cadence bisect --no-state`. Dry writes the real prompt files and records promptSha, and after the 3.1 fix this includes agent follow-up turns. The batch is keyed by the tool's head and the tree, not by a bisect, so `plan`'s renders are reused by the `start` that follows it and by later bisects, and a render on record is never run again (a freeze it lacks is topped up in place, since check resumes a named batch).

What the probes give:
- **Render classes.** Neighbouring candidates whose renders match on every flipped freeze fold into one class, because a replay cannot tell them apart. Only neighbours fold, so the classes keep ancestry order and the search can halve them. A render is the freeze's most common promptSha in the batch plus each call's `request.json` less its prompt text, so a model or parameter change keeps candidates apart. A candidate that does not load, or whose render recorded no prompt, is a class of its own marked `skip`. A class's `n` is its index; a commit is keyed by its sha and the patch candidate by `patch:<treePatch>`.
- **Legacy mapping.** An endpoint that ran on uncommitted edits with no patch, whose render equals a class's on every flipped freeze, ran what that class runs: the bad side takes the newest matching class and the good side the oldest, so a render that recurs never narrows past what it proves. The plan keeps every class and candidate (the ruler shows them all); the attribution's answer names the ones still in play, which can turn "unattributable" into "narrowed" or "pinned".
- **Unmatched legacy runs.** A dirty run with no match and no patch is reported as "uncommitted edits nothing recorded can replay". The search brackets to the last commit; if the bad control at that commit then reads good, the answer is `unreplayable` rather than drift.
- **Nothing renders differently.** When a legacy good side maps onto the newest class, no commit in the range changes what the model saw: the source line goes dark ("but every candidate renders as the good side does") and the answer falls through to noise, unless the bad side's unmatched edits remain, which reads unattributable with only those edits. On 2026-10-03 settle's `2026-10-03T00:53:31.614Z` (dirty on 6cd0083b3) against the clean nightly on 907fc8c7e rendered its three candidates alike and answered this way, for $0.
- **A pinned answer** (by the records, or by Tier 1 folding the range into one class) has nothing to search: no Start. Neither has a range whose every class fails to load: no replay can probe it.

### Controls (paid, cheap, run before the search)

Replay G and B under today's tool and judge, on the chosen freezes at r reps. If G does not come out good or B does not come out bad, stop with "does not reproduce on today's tool and judge: drift, not source". Control reps also serve as the search endpoints.

### Tier 2: replay probes (paid, bounded)

- **Search.** A binary search over the remaining render classes. The representative of each class is its newest commit.
- **Each probe.**
  1. Build `prepareTreeAt(sha, patch?)` (with `git apply` for the patch candidate).
  2. Run `baseLoadErrors`. A load failure is a skip. A probe records the render class it replays (`BisectProbe.renderClass`); the ruler places a probe on its tile by sha and class together, which is the only way to tell the patch candidate from the bad end's own commit (they share a sha).
  3. Run `check <surface> --freeze <set> --reps r --model <B model> --batch <id>~<sha8> --cadence bisect --budget <remaining> --stop-file <bisects/<id>/stop>` with `CODECAST_EVALS_REPO_ROOT=<wt>`, into the same `EVALS_HOME`.
  4. Drop the tree (`dropBaseTree`).

  Probe reps are ordinary runs. They link to their run pages, appear on the surface chart as bisect-cadence dots (hidden by default), and count as recorded evidence for later bisects.
- **Classifying a probe.**
  - In flip mode, majority per flipped freeze. A probe is bad if the majority of flipped freezes match B, and good if they match G.
  - A split vote adds 2 reps per freeze once. If it is still split, the probe is "unsure": it sides with the control its flipped-freeze median sits nearer (the bad one on a tie), and the answer's confidence drops.
  - In score mode, use `separate()` against the good control's scores on the focus freezes, pooled; `too-few` is a split. The default reps rise to `ceil(5 / focus freezes)` when that is more than 3, so a side can reach 5.
  - Every decision is a function of the reps on record, and a probe whose batch already holds its reps is never run again. A killed bisect resumes (`./evals bisect resume <id>`) by walking the same path for free up to where it stopped.
- **Controls.** The good control must read good and the bad control bad by the same rule; in score mode the good control is the reference and the bad one must separate worse against it.
- **Confirmation.** Replay the culprit class and the class before it (or the good control, when the search never moved off it) at 5 reps per side on the probe's freeze set (the flipped freezes plus the 2 controls), topping up the probe batches already recorded: each tree's batch is `<id>~<sha9>[+<patch8>]`, shared by every role that runs that tree. The separation is taken on the flipped freezes. The culprit is reported only when the result is `separated: worse`, and it is the class's oldest commit, where its render changed; a confirmed patch class answers as a one-candidate range, since a culprit names a commit. Otherwise the answer is a range with p: the culprit class, or every class between the last sure good and sure bad probes when a probe was unsure.
- **Halts.** The stop file, the budget (spent from the probe batches' model and judge cost) and `--max-minutes` are checked before every probe, and passed to each `check` as `--stop-file`, the budget left and the minutes left. A time stop ends with status `budget`, since `BisectStatus` has no time state. `check` refusing its estimate (exit 1 with no rep) or stopping short (exit 3) is a budget halt; crashed seeds are left out and the rest still read.

### Cost bound (shown before Start, enforced by `check --budget`)

```
C = render classes left after Tier 0 narrowing and Tier 1 collapse
P = ceil(log2(C + 1))
F = freezes in the set
r = reps per probe
reps ≤ (2 + P) × F × (r + 2)  +  2 × (F + 2) × 5
usd  ≤ reps × perRep[model].usd (state.json, else meta.maxUsdPerRep) + reps × judge usd per rep
```

- The default budget is 1.2 times the bound. `--budget` refuses a plan over budget and stops between reps when the budget is spent. `--max-minutes` bounds time.
- Agent surfaces (anchor-brief, role-wake, org-review) need `--yes`, which the UI asks for as a confirm.
- One bisect runs at a time, with the existing `--parallel` cap.

### Process and state

- The api child launches `tmux new-session -d -s evals-bisect-<id> -c <root> -- <bun> <root>/packages/evals/src/index.ts bisect start … --id <id>`, the `./evals` wrapper's own command with the child's absolute bun, because a running tmux server keeps its own PATH and may lack bun. Without tmux it starts a detached process that writes `log.txt`. It refuses while `bisects/running.json` names a live process (the runner's lock), so a crashed run's leftover `probing` state never blocks the next one.
- The bisect folder is `EVALS_HOME/bisects/<id>/`:
  - `plan.json`;
  - `state.json`, rewritten atomically after each rep: seq, range, probes and their reps, spent, budget, status, answer, tier;
  - `steps.jsonl`;
  - `log.txt`;
  - `stop`, written to cancel (a resume removes it).

  One bisect runs at a time: `EVALS_HOME/bisects/running.json` names the one that holds the machine and its pid, and a holder whose process is gone is taken over. The bisect can be resumed after a crash or a laptop sleep. The page attaches to a bisect started from a terminal. The runner writes `log.txt` itself (steps, then each check's output) and echoes to its terminal only when stdout is a TTY, so a detached start whose stdout is `log.txt` does not write every line twice.
- When it finishes with a culprit or a narrowed range, it files one `regression` signal through `signals.ts` (`bisectSignal`, called by `commands/bisect.ts` after `start` and after a `resume` of a bisect that was not already done). The signal detail holds only the shas, the surface, the broken freezes' id prefixes, the bisect id and the in-app paths (`/evals/bisect/<id>` and `/evals/s/<surface>?batch=<bad>`); never a commit subject, a freeze name or a reply. A bisect that answers drift, unreplayable or a non-source class files nothing: the check's own signal already stands for the drop.

### Sim bisect (free, wave 3)

`./evals bisect plan|start --sim <artifactDir>` takes a failing run's artifact folder in place of a surface (`bisect/simProbe.ts`). Each probe is deterministic, so there are no controls, reps or budget, and the cost is always $0.

- **Ends.** Bad is the failure's commit (result.json `gitHead`, else its session's), plus the session's kept edits (`<sim home>/trees/<sha>.patch.gz`) when it ran dirty. Good is `--good`, else the newest clean session before the failure, on an ancestor of bad, in which the same scenario, mode and seed passed.
- **Candidates.** `repoGit().path(good, bad, SIM_SOURCES)`, the eval bisect's ancestry walk limited to what the sim loads (`--all-commits` walks every commit), with the kept edits as a last candidate. The bound is the two ends plus `ceil(log2(C + 1))` probes.
- **A probe.** A `prepareTreeAt(sha)` tree, the failing commit's harness (`store/__tests__/sim/` and `scripts/sim.ts`) checked in, and one `scripts/sim.ts <scenario> --seed N --order="<order>" --out <scratch>` with a scratch `CODECAST_SIM_HOME`, so probes never enter the sim history. The order is `minimalOrder` when a shrink ran, else the recorded one. The harness is the failing commit's, not the checkout's working copy: the order is that harness's recording, and the shared checkout's copy can carry other sessions' unsaved edits. A probe reads bad when the same invariant fails on the same row (the shrink's rule), good when it passes, and skip otherwise (another failure, an `order-mismatch`, no result).
- **Search.** Good must read good and bad must read bad, or the answer says why not (the break is older than good; the failure does not reproduce at bad; it ran on edits its session did not keep). Then a binary search with skips, as the eval runner's. The answer is a culprit commit, the kept edits, a range when skipped commits sit next to the break, or "the change lies outside SIM_SOURCES".
- **Record.** The folder is a bisect folder (`EVALS_HOME/bisects/<id>/`, id `sim-<scenario>-<stamp>`) with `sim.json` in place of `state.json`, since `BisectState` describes an eval plan; `steps.jsonl`, `log.txt` and the stop file work as for an eval bisect, and the run holds the same one-bisect lock. `status`, `watch`, `stop`, `resume` and the text `ls` read it; `ls --json` and the api child read only `state.json`, so the Evals pages do not list it yet. A resume reuses every tree already probed. No signal is filed.

## 6. Visual direction

The metaphor is a lab bench, built on the app's own system.

**Theme and type.**
- Colour comes only through `var(--sol-*)`. The Tailwind `text-sol-*` and `bg-sol-*` accent classes are hardcoded hex (`tailwind.config.ts:49-66`) and are not used.
- Type is JetBrains Mono; minimal style switches to SF Pro, as the app already does.
- It must work in light, `.dark` and `.minimal-style`.
- Charts sit on a faint 8px bench-paper grid of `color-mix(in srgb, var(--sol-border) 35%, transparent)`, drawn only under charts and lanes. Text panels sit on `var(--sol-card)`.

**Signature elements.**
- **Assay plate** (freeze ledger). Circular wells. Ink density is the score, the ring is the verdict, and a notch marks a flip.
- **Seismograph** (surface chart). Dense rep dots, a step median, and epoch bands with a perforation line at each boundary. Footing glyphs sit on the axis.
- **Ruler** (bisect). Commit tiles whose brackets close in as wells fill.
- **Tape** (sim). Multi-track lanes, replication arcs, and a playhead.

**Fixed colour meanings.**

| Colour | Meaning |
|---|---|
| `--sol-cyan` | pass, fixed |
| `--sol-magenta` | fail, broke, and the failure rule |
| `--sol-red` | only a hard gate failure and LIVE reads |
| `--sol-orange` | refused writes |
| `--sol-yellow` | unserved reads, and the dirty hatch at 18% |
| `--sol-violet` | judge ruler change (dashed) |
| `--sol-blue`, `--sol-green`, `--sol-violet` | categorical, for up to three models, always paired with a marker shape |

Pass and fail are also told apart by filled against hollow, so state never depends on colour alone.

**Type rules.**
- Section titles are sentence case at 13px, weight 600, led by a state glyph. There are no uppercase letter-spaced kickers, no hairline rules before labels, and no serif anywhere.
- The platform HTML page's `h2` and `.tag` treatment is not carried over.
- Key numbers are 28 to 36px tabular figures.
- The judge's reasoning is set in mono italic in `--sol-text-muted`, with a 2px `--sol-violet` left border, so the model's voice reads differently from the system's.
- There is no charcoal-and-amber page; `--sol-amber` stays reserved for triggers.

**Motion** (CSS only, one orchestrated moment per view, all stopped under `prefers-reduced-motion`):
- **Home.** Strips draw left to right (stroke-dashoffset, 400ms ease-out), staggered 30ms per row.
- **Surface.** Wells fill column by column in time order, 10ms apart, and the dots settle after.
- **Bisect.** Brackets slide over 400ms. Each rep's well pops in at a 120ms scale from 0.6. The answer tile lifts out of the ruler.
- **Sim.** "Play" steps the deliveries 60ms apart, and the shrink fades removed chips.

**Charts.** All charts are hand-drawn SVG, following the app's rule (`ProgressChart.tsx`, `BurndownChart.tsx`). They reuse `useDayBrush`, `BrushRect`, `timeAxisLabels`, `useContainerWidth`, `HoverTip` and `MiniTrace`.

## 7. Files

All paths are under `/Users/ashot/src/codecast` unless they start with `~/src/platform`.

### Create

- **Eval tool (`packages/evals/src/`):**
  - `provenance.ts`, `provenance.test.ts`
  - `commands/pin.ts`
  - `commands/indexCmd.ts`
  - `commands/api.ts`
  - `commands/bisect.ts`
  - `history/runIndex.ts`, `history/runIndex.test.ts`
  - `history/epochs.ts`, `history/flips.ts`, `history/attribution.ts`, `history/analysis.test.ts`
  - `api/handlers.ts`, `api/files.ts`, `api/git.ts`, `api/simHistory.ts`, `api/api.test.ts`
  - `bisect/plan.ts`, `bisect/probe.ts`, `bisect/runner.ts`, `bisect/state.ts`, `bisect/bisect.test.ts`
  - `bisect/simProbe.ts`, `bisect/simProbe.test.ts` (wave 3)
  - `commands/publish.guard.test.ts`
- **Shared contract:** `packages/shared/contracts/evalsApi.ts`, `evalsApi.test.ts`
- **Daemon:** `packages/cli/src/evals/evalsServer.ts`, `evalsBridge.ts`, `evalsServer.test.ts`
- **Web, foundation:**
  - `packages/web/lib/evals/client.ts`, `lib/evals/fixtureTransport.ts`
  - `packages/web/store/evalsStore.ts`, `store/__tests__/evalsStore.guard.test.ts`
  - `packages/web/app/evals/page.tsx`
- **Web, `packages/web/components/evals/`:**
  - Foundation:
    - `EvalsShell.tsx`, `EvalsNav.tsx`, `evalsPaths.ts`, `evalsPaths.test.ts`, `parts.tsx`, `evals.css`
    - `charts/ScoreStrip.tsx`, `charts/Well.tsx`, `charts/scale.ts`
    - `__fixtures__/world.ts`
  - Pages:
    - `pages/HomePage.tsx`, `SurfacePage.tsx`, `FreezePage.tsx`, `RunPage.tsx`, `ComparePage.tsx`
    - `pages/BisectNewPage.tsx`, `BisectListPage.tsx`, `BisectPage.tsx`
    - `pages/SimCatalogPage.tsx`, `SimRunPage.tsx`
  - Views:
    - `SurfaceWallView.tsx`, `WhatMoved.tsx`
    - `SurfaceView.tsx`, `Seismograph.tsx`, `FreezeLedger.tsx`, `CostTrack.tsx`, `ComparePanel.tsx`, `EpochDiffSheet.tsx`
    - `FreezeView.tsx`
    - `RunView.tsx`, `GateList.tsx`, `JudgeChecks.tsx`, `GuardLog.tsx`, `CallPane.tsx`, `AgentTranscript.tsx`, `RunFiles.tsx`, `CompareView.tsx`
    - `AttributionView.tsx`, `BisectPlanPanel.tsx`, `BisectRuler.tsx`, `BisectView.tsx`, `BisectListView.tsx`, `CommitPanel.tsx`, `bisectModel.ts`, `bisect.css`
    - `SimCatalogView.tsx`, `SimRunView.tsx`, `DeliveryTimeline.tsx`, `OrderStrip.tsx`
  - Fixtures and tests: `__fixtures__/<view>.ts` and `__tests__/<View>.mount.test.tsx` per view unit.
- **Multiplayer sim:** `packages/web/store/__tests__/sim/shrink.ts`, `shrink.test.ts`, `history.ts`, `history.test.ts`, `replay.ts` (the replay lines and order format, shared with the api child and the web pages), `grid.ts` (the catalog grid fold, shared with the api child and the fixture world)
- **Docs:** `docs/architecture/evals-ui.md`

### Change

- **Eval tool (`packages/evals/src/`):**
  - `paths.ts`, `main.ts`, `layout.ts`, `state.ts`
  - `adapters/replay.ts`, `adapters/dryRun.ts`, `adapters/runs.ts`
  - `commands/grade.ts`, `commands/check.ts`, `commands/verdict.ts`, `commands/line.ts`
  - `signals.ts`
  - tests: `adapters/replay.test.ts`, `commands/check.test.ts`, `commands/line.test.ts`
- **Platform:** `~/src/platform/packages/evals/src/render/runs.ts` and a new `render/runs.test.ts`, then `scripts/vendor-platform.sh`, which refreshes `platform/packages/evals` and `platform/vendor-manifest.txt`.
- **Shared:** `packages/shared/package.json`, `packages/shared/contracts/appSurfaces.ts`.
- **Daemon:** `packages/cli/src/daemon.ts`.
- **Web:**
  - routing: `src/App.tsx`, `components/RoutePane.tsx`, `lib/pageLayout.tsx`, `lib/desktopHandoff.ts`, `src/routes.manifest.ts`, `lib/pathLabel.ts`, `components/CommandPalette.tsx`
  - `components/LocalDaemonUnreachable.tsx`
  - `components/decisions/ChangeCardView.tsx` (export `ExamplePair`)
  - `components/line/LinePage.tsx`
- **Multiplayer sim:** `packages/web/store/__tests__/sim/report.ts`, `dsl.ts`, `net.ts` (re-exports the order format from `replay.ts`), `packages/web/scripts/sim.ts`.
- **Docs:** `docs/architecture/evals-home.md`, `docs/architecture/multiplayer-sim-harness.md`.

## 8. Work units and waves

Every unit owns its files exclusively within its wave. Before editing, each unit scans `git status` and `git diff` on its shared files (`daemon.ts`, `App.tsx`, `RoutePane.tsx`, `routes.manifest.ts`, `main.ts`), because other sessions edit them. Typecheck with `cast check <project>` and run tests as `bun test <file>`.

### Browser check recipe (web units)

1. Dev server on `http://localhost:3200`.
2. `cast browser open http://localhost:3200/evals…`.
3. `cast browser eval "sessionStorage.EVALS_FIXTURE='1'"` (waves 1 and 2) or `'0'` (wave 3), then reload. `'no-daemon'`, `'no-checkout'` and `'child-crashed'` show each failure screen. The per-tab sessionStorage flag wins over `localStorage.EVALS_FIXTURE`; use it, because localStorage is shared by every tab on the origin, so one unit setting or clearing it flips every other unit's tab between fixture and real data mid-check. Remove the flag when done (`sessionStorage.removeItem('EVALS_FIXTURE')`, and `localStorage.removeItem('EVALS_FIXTURE')` if you set that): it lives in the founder's Chrome and would keep their own `/evals` on fixture data. `cast app goto` may move the tab to the `local.codecast.sh` dev origin, whose storage is separate. `127.0.0.1:3200` is a separate origin too, but signed out.
4. `cast browser shot` in light, then `.dark`, then minimal style. Post the screenshots in the thread.
5. Close the tab when done.

Background-tab timers stall, so check end states, not mid-animation frames: run `document.getAnimations().forEach(a => { try { a.finish() } catch {} })` before a shot (the pulses loop forever, and `finish()` throws on an infinite animation, which aborts the loop), and never `await` a timer inside `cast browser eval`. Parallel units spawned by one workflow share one browser owner (`CLAUDE_CODE_SESSION_ID`), so one unit's `open` moves every unit's target tab; give each unit its own owner by suffixing that variable for its `cast browser` commands (`CLAUDE_CODE_SESSION_ID=$CLAUDE_CODE_SESSION_ID-u8`), and close that owner's tab with `cast browser stop` under the same suffix. If the dev server is unreachable under load, use the static `__harness` rig pattern with the props-only View and its fixture.

### Wave 0 (first, small; U0 must land before anything else)

**U0 Pin heads and pointers.**
- Owns: `provenance.ts` (pinHead, backfillPins, mapOrphans → `heads.json`) and `provenance.test.ts`, `commands/pin.ts`, `paths.ts` (`heads`, `checkout`, `PIN_REF_PREFIX`, `writeJsonAtomic`), `main.ts` (register `pin`; write `checkout.json` on every invocation through main).
- Then run `./evals pin --backfill`.
- Accept:
  - `git for-each-ref refs/evals/heads | wc -l` is 18 or more;
  - `heads.json` has an entry for each of the 7 orphans (67fa6e7c5, 6420806e2, 64f5cff63, c0e2a7aed, a989429a0, bdedf4b4f, 830683c2f), each mapped or `null` with a reason;
  - `git push --dry-run` shows no `refs/evals`;
  - `checkout.json` is written;
  - `cast check` is green.

**U0c Contract.**
- Owns: `packages/shared/contracts/evalsApi.ts`, `evalsApi.test.ts`, `packages/shared/package.json`.
- Accept:
  - `cast check` is green for all three programs;
  - `cast --help` still runs (the exports trap);
  - the types cover every endpoint in 3.4 and the sim formats in 3.7.

### Wave 1 (parallel)

**U1 Writer provenance.**
- Owns: `adapters/replay.ts`, `layout.ts`, `state.ts`, `provenance.ts` (adds treePatch), `adapters/dryRun.ts`, `commands/grade.ts`, `commands/check.ts`, `replay.test.ts`, `check.test.ts`. Small edits outside that list: `paths.ts` (`homePaths().trees`), `adapters/resolver.ts` (exports `canonical` for `freezeSha`), and the scratch-repo world moved out of `cli.test.ts` into `testWorld.ts` so `check.test.ts` reuses it.
- Accept, by unit test on a scratch repo:
  - a dirty rep records `sourceHashDisk` different from `sourceHash`;
  - its `treePatch` file applies cleanly to gitHead;
  - `freezeSha` changes when the snapshot changes;
  - a dry agent rep writes `then2.md` and its promptSha covers it;
  - a rescore or rejudge leaves `score.<stamp>.json`;
  - `--stop-file` stops between reps with `endedBecause: budget`;
  - `check` output is unchanged otherwise.
- Real check: `./evals check title --dry` writes the new fields. Dry costs nothing.

**U2a Index.**
- Owns: `history/runIndex.ts` and its test, `commands/indexCmd.ts`, `adapters/runs.ts`, `main.ts` (register `index`).
- Accept:
  - `./evals index` over the real `EVALS_HOME` yields one row per run folder (4,949 or more; stray `…-agent1` subfolders are not run folders);
  - a second run reads fewer than 100 files;
  - touching one `score.json` re-reads only that row;
  - settle lists every one of its run folders with no cap (995 on 2026-10-03; the old 2,000 cap never bit settle, so the check is equality with the folder count);
  - every row parses against the contract.
- As built, measured 2026-10-04 on an APFS clone of the real home (`cp -cRp`, mtimes kept, so the stored keys still match), with every atime set to 2000 so a read shows as a moved atime:
  - a first build from no index read 6,035 folders into 6,035 rows in 51 s at a load of 40 to 80, with no duplicate, missing or extra id and no row failing `runRowProblems`; the three `-agent1` subfolders are not run folders;
  - a second run read 3 files (`index/runs.jsonl`, `heads.json`, `checkout.json`) and no run folder;
  - touching one settle `score.json` read that folder alone (its `run.json`, `result.json`, `score.json`, `sends.json`);
  - `surfaceRuns('settle')` returned 1,124 reps for 1,124 folders;
  - the fresh build and the real home's incrementally kept index agreed on every field of every shared row, so no derivation change has left stale rows behind a stale `INDEX_VERSION`.
  - `runIndex.test.ts` holds the same checks on a scratch home. A head `heads.json` does not name (a `line` branch's batch, say) gets no `mainSha` until `./evals pin --backfill`; `./evals index` names such heads, and attribution falls back to the raw sha.

**U2b Analysis.**
- Owns: `history/epochs.ts`, `flips.ts`, `attribution.ts`, `analysis.test.ts`, `commands/verdict.ts`.
- Accept:
  - `check` output byte-identical before and after on a recorded batch (snapshot test);
  - epochs computed for settle match a hand check of promptSha changes;
  - `flipsBetween` refuses across footing;
  - attribution fixtures cover all five classes plus the patch candidate, the orphan mapping and "no declared source moved".

**U3 Platform diffRuns.**
- Owns: `~/src/platform/packages/evals/src/render/runs.ts` and a new `render/runs.test.ts` (the package's only other test, `evals.test.ts`, is shared and stays untouched), then the vendor run (`platform/packages/evals`, `vendor-manifest.txt`).
- `--check` used to report `update-prompt/src/cli.ts` as drift after every install: bun installs a package's bin target as a hardlink to the mirror file and marks it 777. `--check` now ignores a mode-only difference when both sides agree on the executable bit, the only mode bit git records.
- Accept:
  - `bun test` in the platform package passes;
  - `scripts/vendor-platform.sh --check` is clean;
  - `cast --help` runs.
- Run the vendor script only when no other unit has a test or dev server mid-flight, because it purges caches.

**U5 Daemon bridge.**
- Owns: `cli/src/evals/evalsServer.ts`, `evalsBridge.ts`, `evalsServer.test.ts`, `daemon.ts`.
- Accept, by unit test with a fake child script:
  - a bad origin or token gets 403;
  - each bad `checkout.json` case (missing, not owned, wrong header, not a git toplevel) gets a 503 with its reason and no exec;
  - a crashed child gets a 502 with its stderr;
  - the child is killed after idle;
  - the handler never blocks (async).
- `cast check cli` is green.
- As built: `evalsServer.test.ts` runs a fake api child (a scratch git checkout whose `index.ts` echoes requests and records each exec) behind a standalone loopback server, 32 tests. Beyond the list above it covers the 404 for a path outside the contract (no exec), the 400 for a non-JSON POST, one child for concurrent first requests, the crash backoff, the 504 timeout, a pointer moving under a running child (one restart for a burst), the fallback to the serving checkout when the pointer names one that cannot serve and the 30 s memo of that refusal, and the header and `EVALS_HOME` agreement with the eval tool. Run it with `ulimit -n 10240` or lower.

**U6 Web foundation.**
- Owns: `lib/evals/*` (client, fixtureTransport, hooks), `store/evalsStore.ts` and its guard test, `app/evals/page.tsx`, `components/evals/{EvalsShell, EvalsNav, evalsPaths(+test), parts, evals.css, charts/*, __fixtures__/world.ts, __tests__/EvalsFoundation.mount.test.tsx}`, the first `pages/*.tsx` (stubs that each rendered a "not built yet" EmptyState until its view's unit replaced it; all are real pages now), all route registration files plus `routes.manifest.test.ts`, `LocalDaemonUnreachable.tsx`, `ChangeCardView.tsx`.
- Accept:
  - `routes.manifest.test.ts` passes;
  - `cast app goto evals` and `cast app goto evals/sim` open;
  - `/evals` opens in a tab and in a split pane;
  - the palette finds "Evals";
  - the guard test fails when an evals type is imported into inboxStore;
  - browser screenshots of the shell in fixture mode and of each unreachable reason (no daemon, no checkout, child crashed) in all three themes.

**U11 Sim writer and shrink.**
- Owns: `store/__tests__/sim/report.ts` and `report.test.ts`, `dsl.ts`, `history.ts`, `history.test.ts`, `shrink.ts`, `shrink.test.ts`, `scripts/sim.ts`, `docs/architecture/multiplayer-sim-harness.md`.
- Accept:
  - `bun run sim memberRemovedMidTurn` creates a session folder with `session.json` and `runs.jsonl`;
  - a failure writes artifacts inside the session, including step rows;
  - `--list --json` and `--invariants --json` parse;
  - the `shrink.test.ts` ddmin unit test passes on a synthetic predicate;
  - `--shrink` on a real failing artifact writes `minimal.json` with a shorter order;
  - the minimal replay line reproduces the same invariant on the same row.
- As built: the code is `history.ts`, `shrink.ts` and the runner's `--shrink` as multiplayer-sim-harness.md section 3.12 describes; the order format and replay lines moved to the leaf `replay.ts` (U4). Checked on 2026-10-04 at a load of about 80. A clean `bun run sim memberRemovedMidTurn` wrote a session with three `runs.jsonl` rows, and its kept tree patch applied cleanly to its gitHead in a scratch worktree. The real failures ran in that worktree, never the shared checkout, whose convex edits the gated pusher would ship. With `hideConversationForViewer`'s access check removed, the scenario failed `expect.noHide` on `inbox_hides#1` in all three runs. Each run's artifacts landed in the session (events.jsonl with 8 step rows; result.json with `gitHead`, `dirty`, `startedAt`, `realMs`), and the shrink went straight to the empty order in 2 attempts, because that failure does not depend on order. An order-dependent check came next. A scratch copy of the scenario with the drains removed failed on 4 of 12 sweep seeds. Its seed 968891 shrank from 38 recorded deliveries to 21 in 84 attempts (355 s, 1-minimal; 41 candidates hit an order mismatch, 38 passed). Its printed minimal line failed `expect.noHide` on `inbox_hides#1` again.

**U13 Publish guard.**
- Owns: `commands/publish.guard.test.ts`.
- Accept: it builds the site into a temp dir and fails if any private freeze id from `EVALS_HOME/freezes` appears in the output; it passes today.
- As built: `writeSite` always writes to `homePaths().site`, so the test points `CODECAST_EVALS_HOME` at a temp home that mirrors the real one (every other dir, `runs`, `freezes`, `snapshots`, `labels`, `trees`, `bisects` and `locks` among them, symlinked because nothing on `writeSite`'s path writes to them; small files and the `index` dir copied, because the index refresh rewrites it; `html` and `scratch` left out). Every freeze in `EVALS_HOME/freezes` counts as private, read without the publish code's `isPublicFreeze`. The scan matches the full id, the 8-character prefix every run folder name carries, and the freeze's name (which cites the real session or task). It reports only the prefix, so a failure never prints a private name. A second case builds a synthetic home with one private and one public run and checks that the public run renders, the private one does not, and a planted leak of each kind is caught. That case runs in CI; the real-home case skips where no `EVALS_HOME/freezes` exists. On 2026-10-04 both cases passed in 32 s at a load of 85 (the real build left out 240 private runs); the real-home build takes up to about 3 minutes at higher load. A mutation probe that mocked `isPublicFreeze` to call every freeze public failed both cases, and the real one listed three private freezes by prefix only.

### Wave 2 (parallel; needs wave 1)

**U4 API child.**
- Owns: `commands/api.ts`, `api/*`.
- Accept:
  - `api.test.ts` drives each endpoint through the stdio protocol against a fixture `EVALS_HOME`;
  - path traversal (`../`), a bad sha and an unknown run id are refused;
  - bisect and sim POSTs build argv arrays only;
  - `echo '{"id":1,"method":"GET","path":"/overview"}' | bun packages/evals/src/index.ts api --stdio` answers on the real home in under 2 s once the index is warm, on a machine that is not saturated. The daemon and every child it starts run clamped to utility priority (pri 20), so wall time is the child's CPU stretched by load: the bound is on CPU, about 1.1 s for a fresh child, and a running child (the bridge keeps one 10 minutes) must answer a repeated `/overview` from memory, in tens of milliseconds of CPU.
- As built:
  - `commands/api.ts` is the stdio loop (`serveStdio`, `apiMain`, `registerApi` for U16). While it serves, `console.log` goes to stderr, so stdout carries answers only. When stdin closes it lets answers in flight finish (up to 120 s) and exits.
  - `api/handlers.ts` holds one handler per `EvalsRoutes` key, chosen by `matchEvalsRoute`, and every input check. `api/views.ts` builds the analysis answers from the index through `verdict.ts`, `history/*` and `diffRuns`. `api/files.ts` reads one run folder: calls through `readCallRun`, agents through `readAgentRun`, the guard log through roleWake's `callsByTurn`, and `runFile`'s realpath check. The folder's units and harness files are read through `layout.ts` (`unitDirs`, `thenFiles`, `harnessExit`, `harnessTookMs`), the same helpers `grade.ts` and the run writer use, so a missing `exit.txt` reads as failed everywhere. `api/git.ts` handles commits and the declared-path windows. `api/bisects.ts` sits over `bisect/state.ts` and adds the stall flag, the lock check and the argv. `api/simHistory.ts` reads sessions through the sim's own `history.ts` and runs `sim.ts --list/--invariants --json`, cached per HEAD and the mtimes of the scenario files. `NOT_COMPARED` is read from the source text, because `invariantCoverage.ts` imports the store registry. `api/spawn.ts` launches work in tmux. `api/staleWorker.ts` computes staleness in a Worker: `state.ts staleness()` runs git synchronously and took 2.7 s under load, so the first overview starts it before the index load and awaits it last.
  - What a polled page pays: `handlers.ts` `rows()` hands back the same `RunRow[]` until the index changes (its version is runs.jsonl's mtime and size, since every refresh that changes the index rewrites it, the per-surface ones `flipExamples` runs included). `views.ts` `onRows` keeps any answer computed from the index alone per array and key: the overview's analysis (per cadence and minute), `/attribution` and `/batches`; a rejected one is dropped. Requests that arrive together (a page and its `/changes` poller) join the one index load in flight, because `refreshRunIndex` runs its own sweep for each caller waiting behind a refresh once the index is past its 2 s age: a burst of five against a stale index cost about 1 s of CPU before the join and 0.3 s after it. The freeze list (5 s) and the staleness words (30 s) are `kept`: the first ask waits, later asks get the last answer while an older one is read again in the background. A bisect endpoint that looks like a sha passes git.ts `verifiedSha` (`rev-parse --verify <sha>^{commit}`) before anything spawns.
  - `simReplay` builds its lines with the sim's own `store/__tests__/sim/replay.ts`, a leaf with no runtime imports that holds `formatOrder`, `parseOrder` and `replayCommands`. `report.ts` (which imports the convex denylist the child cannot load), `net.ts` (which imports the store) and `scripts/sim.ts` take them from there, so the lines cannot drift.
  - Test seams: `CODECAST_EVALS_API_TOOL` names the eval tool entry a spawn runs, and `tmux` comes from PATH. `api.test.ts` puts a recording fake of each first on PATH: 35 tests over the real protocol, the last of which fails unless every `EVALS_ROUTE_KEYS` route was answered 200 at least once, so a route added to the contract without a case fails there. A sweep filter may not start with a dash, so it can never reach `sim.ts` as a flag. Run it with `ulimit -n 10240` or lower: above that, bun's child spawns from a repo-root `bun test` exit 1 with no output. The bisect POSTs spawn `index.ts bisect …`, which U16 registered; the test now spawns the child the way the bridge does, `index.ts api --stdio`. A real `plan` run on settle, through a wrapper that ran U12's direct entry, answered in 7.9 s.
  - Timing on 2026-10-04, child CPU from `ps`. The echo check at load 110 to 120 answered in 1.8 to 2.5 s of wall time on 0.63 to 0.67 s user and 0.44 to 0.52 s system time; at load 300 the same CPU takes 25 s or more of wall. A fresh child's CPU goes to its imports (about 140 ms), the index's load and stat sweep (`runIndex.ts`, about 550 ms) and the overview's first build (about 200 ms). A running child answers a repeated `/overview` in 0.01 to 0.02 s of CPU (28 to 200 ms of wall at load 110 to 230); when the index is over 2 s old it first pays the stat sweep, about 0.2 s of CPU. Under load an answer takes more than 2 s of wall, so a page polling at 3 s pays the sweep on every poll, and while reps are landing every new row rebuilds the overview (0.6 to 0.9 s of CPU per repeat, measured during a live `suggest` batch). Rechecked later on 2026-10-04 at load 86 to 100: a fresh child answered the echo check on 0.99 to 1.03 s of CPU (5.7 to 8.3 s of wall); a repeat within the window took 0.01 s of CPU, and five at once 0.04 s. `/attribution` for settle costs 1.4 s of CPU once (its flip examples read every flipped rep's folder), then nothing until the index changes.

**U12 Bisect engine.**
- Owns: `commands/bisect.ts`, `bisect/{plan, probe, runner, state}.ts`, `bisect.test.ts`, `commands/line.ts` (export `prepareTreeAt`, `baseLoadErrors`, `dropBaseTree`, `checkArgs`), `line.test.ts`.
- As built:
  - The regression signal on finish is filed by `commands/bisect.ts` through `signals.ts` `bisectSignal` (U16). The api child's `api/bisects.ts` reads the same folder through `bisect/state.ts` (`readBisectState`, `readSteps`, `listBisects`, `requestStop`, `BISECT_ID_RE`, `LIVE_STATUSES`) and keeps no copy.
  - `bisect.test.ts` (21 tests, fake `check`) covers each Tier 0 answer (footing, freeze, live reads and noise, plus source narrowed and pinned), render-class collapse with a load-error skip and reuse of renders on record, the legacy mapping, the unsure path, a skipped probe widening the answer, drift, budget refusal and a budget spent mid-search, the stop file with resume, resume after a kill, and the one-bisect lock.
  - The re-verify on 2026-10-04 found every real render failing once U17's `borrowNodeModules` gave each tree its own `@codecast/shared`: today's tool imports `@codecast/shared/contracts/evalsApi` and `random`, which older commits lack, and `pinMissingImports` followed relative imports only, so every candidate was a load skip. It now follows package imports too (`line.test.ts`, "a tool file reading a workspace package"). Real runs at a load of about 60, with `git worktree list` at the same count before and after and nothing left in `scratch/`: settle `--good 2026-10-02T16:52:41.655Z --bad 2026-10-03T07:33:53.398Z` rendered all 8 candidates into one class and answered noise for $0 (5 fresh trees, 1m55s); `--good 2026-10-03T07:33:53.398Z --bad 2026-10-04T07:55:00.000Z` answered source, narrowed, in two classes (`0775ece83` a load skip, since it imports `web/lib/stickyPrompt` two commits before that file landed; `859e334c2` folded with the bad side's patch) and printed "2 controls + up to 1 probe + confirmation, 5 freezes, 3 to 5 reps: at most 145 reps, about $0.200, budget $0.240" (3 fresh trees, 1m40s).
- Accept:
  - unit tests with a fake `check` cover each Tier 0 answer, render-class collapse, the unsure path, skip on load error, the stop file, budget refusal and resume after a kill;
  - `./evals bisect plan settle --good <batch> --bad <batch> --json` on real data prints the classes and a cost bound;
  - a Tier 1 dry probe on two real commits creates and removes worktrees, leaving `git worktree list` clean;
  - `./evals line` still passes its tests.

**U7 Home.**
- Owns: `pages/HomePage.tsx`, `SurfaceWallView.tsx`, `WhatMoved.tsx`, plus its fixture and mount test.
- Accept: the mount test passes; browser screenshots in fixture mode, in three themes, of 13 rows, a worse row sorted first with its magenta edge, the hover tooltip, and `j`/`k`/`Enter`/`b` working.
- As built: the keys live in `SurfaceWallView` behind an `active` prop (the page passes `useTabActive()`), so the mount test drives them. `j`/`k`/`Enter` are the shortcut registry's `list` context; `b` is `evals.attribute` in a new `evals` context (`shortcuts/registry.ts`, `sections.ts`) that later views share for their own `b`. The staleness word sits under the surface name rather than in its own column, so it survives a split pane; styles are in `wall.css`. `b` takes the newest worse pair's red batch and the newest batch of its baseline; with nothing worse it opens the launcher for the selected surface, which picks its own red batch. `shortModel`/`shortRuler` joined `parts.tsx`. What moved is the right rail from 1,180px of pane width; below that it stacks under the foot, because a 300px rail beside a 1,135px pane (a 1,512px laptop with the app's right sidebar open) would leave the strips about 210px for 30 days. The verdict column is 188px so "vs pooled 3, 2 broke, 1 fixed" never ellipsizes away the fixed count, and the strip cell clips, so a pane resize that paints before the width observer fires cannot draw a strip over the pass rate. The strips stay on a linear 0 to 1 scale: on the real index nine of 13 surfaces have a batch median of 0, so any shared floor would be 0.
- Re-verified 2026-10-04 in the founder's Chrome (fixture, own tab via the sessionStorage flag): 13 rows with settle first and its 3px `--sol-magenta` inset edge; the shared cursor drew in all 13 strips and the tip named the stamp, cadence, batch, median, reps, cost and heads; `j`, `j`, `k` selected settle, title, settle; `Enter` opened `/evals/s/settle?batch=<red>&compare=<baseline>`; `b` opened `/evals/bisect/new` with the same pair; light, dark and minimal, the stacked layout at 1,135px and the rail at 1,920px. `SurfaceWallView.mount.test.tsx` 11/11, `cast check web` 0 errors.

**U8 Surface.**
- Owns: `pages/SurfacePage.tsx`, `SurfaceView.tsx`, `Seismograph.tsx`, `FreezeLedger.tsx`, `CostTrack.tsx`, `ComparePanel.tsx`, `EpochDiffSheet.tsx`, plus its fixture and mount test.
- Accept: screenshots of the seismograph with epochs and footing glyphs, the ledger with flip notches, the brush zoom, two pinned columns opening the compare drawer with ExamplePair and PromptDiff, and the epoch sheet.
- As built: the view's styles are `surface.css`, and the fixture is `__fixtures__/surface.ts` (`surfaceFixture`). `surfaceColumns` in `Seismograph.tsx` gives each batch one x that the cost track and the ledger share. Pins live in the URL (`?batch=&compare=`); both pins are numbered by time (the earlier is 1, the baseline of `/batches`) on the chart, the ledger and the drawer. The drawer sits beside the chart and stacks under it below an 820px pane. A footing change draws a dashed rule through the plot as well as its glyph on the axis, which `ScoreStrip` exports as `FootingGlyph`. Unchanged prompt files are named on one line rather than diffed in full. The keys (`[`, `]`, `e`, `b`, `esc`) are handled by the page while its pane is active and render as KeyCap; they are not in `shortcuts/registry.ts`, a shared file outside U8. The ledger scrolls sideways once the batches outrun the pane, so it keeps the pinned columns in view (the later one when both do not fit, with the flip counts when it is the newest batch), else the newest batches, and does so again when the drawer narrows the pane. A flip's `ExamplePair` tints Before red and After green whichever way it flipped; inside the area each tile carries `data-ev-flip` and `evals.css` colours each side by its outcome (cyan passing, magenta failing), in the drawer and on the attribution page. The cost track's top is a round number (`niceCeil`, `axisUsd` in `charts/scale.ts`) so its label fits the gutter. Every verdict title names the test as `verdict.ts` ran it (`separationTitle` in `parts.tsx`): a pooled cadence baseline is weighed night by night per freeze, the others by a per-rep Mann-Whitney.

**U9 Run and compare.**
- Owns: `pages/RunPage.tsx`, `pages/ComparePage.tsx`, `RunView.tsx`, `GateList.tsx`, `JudgeChecks.tsx`, `GuardLog.tsx`, `CallPane.tsx`, `AgentTranscript.tsx`, `RunFiles.tsx`, `CompareView.tsx`, plus its fixtures and tests.
- Accept: screenshots of each tab for a call-surface fixture and an agent-surface fixture, a crashed rep, the unscored rubric state, `#gate-…` deep links scrolling into place, and the compare page.
- As built: the page also reads the freeze's `GET /freeze/:id`, because `RunResponse` carries no moment, production reply or epochs; the "diff against the previous epoch" button diffs against the same freeze's newest rep in epoch n-1 (`previousEpochRun`). The moment and production reply reuse U10's `MomentPane` and `ProductionCard` from `FreezeView.tsx`. The fragment names the tab too (`#moment`, `#calls`, `#agent`, `#guard`, `#files`); a gate or check fragment opens Verdict and lands on its row through `landOn` (`hooks/useDiffAddress.ts`). Keys are the `evalsRun` context in `shortcuts/registry.ts` and `sections.ts`. Styles live in `components/evals/run.css`, beside `evals.css`. The fixture is `__fixtures__/run.ts`, the test `__tests__/RunView.mount.test.tsx`.
- Dry reps, as the real folders hold them: the tool grades a dry rep too, scoring the rendered prompt (which `adapters/dryRun.ts` returns as the call's reply) as if it were the answer, and the api child then sends no rubric, since it sends one only when a folder has no score (`api/views.ts`). On the 2026-10-04 index, 310 dry reps score 0 with `parse` failed and 204 score 1 with a Sonnet judge. So a dry rep reads "dry, counts toward nothing" in the header with no score on its ruler; the Verdict tab shows the rubric from the freeze's own criteria (`rubricOfRun`) and folds the tool's grade under "The tool also graded the rendered prompt" (`dryGradeWords`), with no gate flag on the tab; Calls marks the call "dry render, no model called" with no reply or tokens, and Moment says it sends nothing. The compare picker never offers a dry rep, and offers the batch on either side only once the freeze's runs name it. `[` and `]` still step every batch, dry ones included, as the child's `adjacent` does. The fixture world's dry reps carry the same kind of score.json, and its Files tree takes each size from the text the file route serves.

**U10 Freeze.**
- Owns: `pages/FreezePage.tsx`, `FreezeView.tsx`, plus its fixture and mount test.
- Accept: screenshots of the moment pane, the rep strip, the default flip pair and the "prompt changed" banner.

**U14 Bisect pages.**
- Owns: `pages/Bisect*.tsx`, `AttributionView.tsx`, `BisectPlanPanel.tsx`, `BisectRuler.tsx`, `BisectView.tsx`, `BisectListView.tsx`, `CommitPanel.tsx`, `bisectModel.ts` (candidate order, bracket positions, probes left, status words), `bisect.css`, `__fixtures__/bisect.ts` and `__tests__/Bisect.mount.test.tsx`.
- Accept: fixture screenshots of each Tier 0 answer, a pinned answer with no Start button, a plan with its cost line and the agent confirm, a live ruler mid-run, a stalled flag, the drift banner, and the result card.
- As built: `__fixtures__/bisect.ts` plays one plan out as a running, stalled, drift, culprit or range bisect with the real search (binary over render classes, the newest known bad), and `world.ts` builds its five bisects from it (settle running and finished, anchor-brief stalled, call-summary range, handoff drift); the world's `GET /bisect/:id` reports `stalled` after five quiet minutes. `attributionPairs(world)` finds a real endpoint pair for each Tier 0 answer, so the test and a browser check use the same cases. Every change to the plan's freezes, reps, budget or minutes is priced again by `POST /bisect/plan` (debounced), so the bound on screen is always the engine's; the first answer's freeze set becomes the list of options. Start answers `Enter` through the existing `list.open` chord rather than a new registry action. `CommitRef.session` is the trailer value as `git log` prints it, which on agent commits is the full session link, not an id; `commitSessionId` (`CommitPanel.tsx`) reads it through the shared blame parser (`extractSessionTrailer`), which refuses short ids, before any session pill, and the fixture world writes the same link-shaped trailers. In a ruler tile's foot the pill shrinks and ellipsizes its label beside the culprit, recorded and off-branch tags.

**U15 Sim pages.**
- Owns: `pages/SimCatalogPage.tsx`, `pages/SimRunPage.tsx`, `SimCatalogView.tsx`, `SimRunView.tsx`, `DeliveryTimeline.tsx`, `OrderStrip.tsx`, plus its fixtures and tests.
- As built: the lane model is the pure `simLanes.ts` (channel grammar, step bands, the trace picker, shrink caption) with `simLanes.test.ts`; which deliveries a trace keeps is the runner's own rule, `traceMatches` in the sim's pure `labels.ts`, which `dsl.ts` calls for `--trace` and the page calls over `SimLabels.from(<recorded labels>)`; styles are `sim.css` (`evs-` classes) beside `evals.css`; `__fixtures__/sim.ts` builds a run shaped like a real artifact folder and world.ts's sim section builds its failing runs from it; the grid's sparkline reuses `MiniTrace`, made generic over `{at}`; the keys live in `shortcuts/registry.ts` and `sections.ts`. The contract gained `SimGridCell.newestFailure` (null when the cell has no failure with artifacts). The grid fold moved out of `api/simHistory.ts` into the leaf `store/__tests__/sim/grid.ts` (`simGridOf`, no runtime imports, like `replay.ts`): the api child calls it with an `invariantOf` that reads result.json, and world.ts calls it over its own history, so the child fills the field and the fixture cannot fold differently. A cell links to `newestFailure`, else to its `latest` run when that failed and left a folder (`cellFailure` in `SimCatalogView.tsx`). The pages read an order with the sim's own `replay.ts` `parseOrder` and `shrink.ts` `splitOrderLine`, and `__fixtures__/sim.ts` builds its replay lines with `replayCommands` and `formatOrder`; both files are leaves with type-only imports. The lanes size to the scroll box beside the label gutter, so the box's width is the lanes' whole width.
- Accept: screenshots of the grid and invariant panel, a run with lanes, arcs and step bands, the failure rule, the minimal-order dimming, and playhead stepping.

### Wave 3 (integration; mostly serial)

**U16 Wire-up.**
- Owns: `main.ts` (register `api`, `bisect`), `signals.ts`, `LinePage.tsx`, `docs/architecture/evals-home.md`, `docs/architecture/evals-ui.md`.
- Accept:
  - `./evals api --stdio` and `./evals bisect ls` run;
  - a test signal's detail carries `/evals/s/<surface>?batch=…` and no reply text;
  - the Sense row links into `/evals`.
- As built:
  - `main.ts` registers `bisect` and `api`, and the two direct `import.meta.main` entries in `commands/api.ts` and `commands/bisect.ts` are gone: the bridge, `api.test.ts` and the bisect spawns all run `index.ts`. A fresh `./evals api --stdio` answers `/health` at a load of 800 in under 3 s of wall time.
  - `signals.ts`: a check's signals carry `/evals/s/<surface>?batch=<batch>` in their detail (`evalsSurfacePath`; `check` passes the batch it weighed), and `bisectSignal` files a finished bisect's answer (section 5, "Process and state"). `signals.test.ts` holds both to their paths and to no reply, freeze name or commit subject.
  - The Line page's Sense row for the `evals` source opens the surface its newest signal names, else the wall (`evalsSenseHref` in `evalsPaths.ts`); other sources still open their cause task.
  - A second design pass (2026-10-04) fixed what the critique of the fixture walk-through found:
    - Attribution: zero candidates answer `empty`, not `narrowed`, with `rangeCommits`; the page says how many commits sit in the range and offers "Search every commit", which re-asks `/attribution` with `allCommits=1` (the launcher's `all=1`) and prices the plan with `--all-commits`. The plan panel's own all-commits checkbox is gone: it could only show when nothing was searchable.
    - The launcher reads `GET /bisects`: bisects on the surface whose range overlaps good..bad are listed above the answer with their outcome (`bisectsOverRange` in `bisectModel.ts`; a batch-name end is a time, a sha end is placed only when it is one of this attribution's own ends), and the bisect holding the lock is named above Start, which stays disabled while it runs.
    - Surface: "Attribute this" sits in the compare drawer's header, in view whenever the drawer is (a sticky footer could still sit below the viewport, since the drawer is taller than the space under the chart). The header's verdict and its baseline are two lines, and the pooled baseline batches are bracketed in cyan under the seismograph's axis. Gate deltas read "failed 0 of 12 reps in 1, 1 of 12 in 2".
    - Wall: the strip has room (row 62px, strip 54px); a worse row draws its red batch as a magenta step and ring with a dotted drop from the baseline's level, and its baseline batches as a cyan bracket on the axis. The newest batch always gets a 12px step. The column reads "Latest batch", "5 of 12 reps", and one `pLabel` prints every p.
    - Bisect: the ruler's wells say "6 pass 6 fail" or "4 of 12 landed", rows carry f (flipped) or c (control), and step text prints each batch name as `batchLabel`, linked to that batch on the chart (`splitBatchNames` in `format.ts`).
    - Multiplayer sim: "failing now" filters the grid; a session's Failed count opens its failing runs; a dirty chip with a kept patch opens it; the run page adds "Bisect this failure" and names its session by local time.
    - Every lazy view shows "Opening the run..." while its code loads.
    - The fixture world narrows with the engine's rule (and the engine's probe rule: majority per flipped freeze, a dirty batch with no patch skipped, either end on unkept edits unattributable), decides dirty per batch with the newest batch dirty, adds a denser last six days of commits, varies each flip's moment and reply by freeze, and picks the reps that show the flip. Its bisects run on the real clock, so elapsed time and the stall flag agree with the pages, and landed probe reps link to world runs.
    - Trap: the dev server's watcher ignores `**/__tests__/**` (`vite.config.ts`), so an edit to a sim leaf the pages import (`store/__tests__/sim/replay.ts`, `grid.ts`, `shrink.ts`, `labels.ts`) never reaches a running dev server, and the page fails on a missing export. Touching `vite.config.ts` restarts it with a fresh module graph.
  - The design pass that followed the first fixture walk-through landed in the view files in the same wave: the wall row's pinned pair and its default cadence (4.1), the surface header's verdict line, commit ticks and ledger order (4.2), the run page's reply-first Verdict tab (4.4), candidates that open their diff and the stall flag in every list (4.5), the sim row diff's labels (4.7), one batch label everywhere and the commit and patch pages (section 4's shared parts, 3.6). The contract gained `SurfaceResponse.latest`, `BisectSummary.updatedAt` and `GET /patch/:sha`.

**U17 Sim bisect** (can be cut).
- Owns: `bisect/simProbe.ts`, plus a `--sim <artifactDir>` flag in `commands/bisect.ts`.
- Accept: on a sim failure introduced in a scratch branch, the bisect names the commit at $0.
- As built: `bisect/simProbe.ts` with `simProbe.test.ts` (15 tests on a fake line of commits and a scratch sim home), and `--sim` on `plan` and `start` in `commands/bisect.ts`, with `resume`, `status`, `watch` and the text `ls` reading `sim.json` (section 5, "Sim bisect"). Building it found that `prepareTreeAt` linked the checkout's whole `node_modules` into each tree, so `@codecast/convex` and `@codecast/shared` resolved to the checkout's working copy at every commit, for the eval bisect and `line` base runs too. `borrowNodeModules` in `commands/line.ts` (tested in `line.test.ts`) fixes it there. On 2026-10-04, a scratch branch off `5f0e6b1ff` had five commits: A (a convex comment), B (`hideConversationForViewer` drops its access check), C and E (source comments) and D (docs only). `memberRemovedMidTurn` interleave seed 1 then failed `expect.noHide` on `inbox_hides#1`, and its shrink went to the empty order. `./evals bisect start --sim <artifact>` took its good end from the clean baseline session, filtered D out, and named B (`culprit 5f6c393ce`) for $0 in 4 probes of a bound of 5, in 3m19s at a load of about 450. Only a tree running its own convex can tell B from A, so the answer also proves the borrow fix end to end.

**U18 End-to-end in the founder's Chrome** (no file ownership).
1. Restart the local daemon so it loads the handler.
2. Set `EVALS_FIXTURE` to `0` and open `http://localhost:3200/evals`, then the same path on codecast.sh.
3. Screenshot every view on real data:
   - the home wall with 13 surfaces;
   - settle's surface page;
   - a real flipped freeze;
   - a real agent run (role-wake) Guard tab showing SERVED, UNSERVED and LIVE;
   - a Tier 0 attribution on a real worse pair;
   - a `plan` with its cost;
   - the Multiplayer sim run page for a real memberRemovedMidTurn failure after a shrink.
4. Confirm in DevTools (Application) that no evals data sits in IndexedDB or localStorage beyond the fixture flag.
5. A paid bisect is spend: queue it through `cast decide` with the plan's bound, and run it only on the founder's answer. Without approval, prove the paid path with the fake-check unit tests and a `--dry-run`.

## 9. Risks

- **Legacy provenance is weak.** 81% of runs are dirty with no patch, and their `sourceHash` names HEAD code they did not run. Epochs from promptSha and Tier 1 mapping recover part of it. The rest must read "uncommitted edits, not replayable", never a guessed commit, and such runs never narrow a range.
- **Orphan heads can be collected.** If `git gc` runs before U0, the commits behind 1,956 runs are gone. U0 ships alone and first. Patch-id mapping fails on squashed rebases, so those runs show "no main twin".
- **The daemon execs checkout code.** That is the confirm item. Validation is in 3.5. A checkout that is mid-edit crashes the child, and the page shows the child's stderr rather than a generic 500.
- **Old commits may not load under today's tool.** `pinMissingImports` covers missing helpers. Load failures are skips, which can widen the final answer to a range.
- **LLM noise.** 3 to 5 reps can misclassify a probe. Splits add reps once and then mark the probe unsure. A culprit needs a `separated: worse` confirmation, and the bound includes the unsure and confirmation reps.
- **Tool or judge drift since the good batch** can make the controls fail. That is reported as its own answer, and it costs the control reps.
- **Declared sources can miss shared helpers.** A regression in a helper outside them yields "no declared source moved", with `--all-commits` at a higher cost.
- **Index drift and scale.** The index is a cache keyed on mtimes and can be rebuilt. The first build is about 25k reads, so it runs off the loop with progress shown. Settle grows nightly; the in-memory rows stay small (about 5k rows today).
- **Privacy.**
  - Private replies are served to any allowlisted origin holding the per-boot token, the same boundary as Memory and Files.
  - evalsStore lives in memory only, with a guard test.
  - Publishing stays public-only, with a scan test.
  - Signals carry no reply text.
- **Load.** Bisect worktrees, dry probes, shrink subprocesses and sweeps add bun processes on a machine prone to swap. One bisect at a time, the `--parallel` cap, and tmux or log observability for every job.
- **Shared-file churn.**
  - Route registration, `daemon.ts` and `main.ts` are edited by other sessions; scan before editing.
  - The vendor run purges bun and vite caches, so schedule it when nothing is mid-test.
  - A new shared contract without its `exports` entry kills every `cast` command.
- **Naming.** "Multiplayer sim" must never be shortened to "sim" in the UI, because `@platform/evals` has an unrelated persona `sim`.
- **Sim history move.** Docs and habits that point at `$TMPDIR/codecast-sim` need the new path. Replay lines print the full path, and the UI still shows legacy folders read-only.

## 10. Considered and left out of this build

- **`promptSources` / `promptVersion` per surface.** `sourceHashDisk` plus per-freeze epochs and render classes cover the need without editing 13 `meta.ts` files.
- **`moment.md` per rep.** The api child renders moments with the surface's own `describe`/`judgeMoment`, with `judge/prompt.md` as the fallback.
- **Precomputed `batches.json`.** The child computes verdicts on demand from the single `batchVerdict`, so the index holds rows only.
- **Server-sent events.** Cursor polling through the existing loopback server is simpler and needs no streaming in the daemon.
- **Gate `excerpts` evidence.** The run page renders excerpts when present. Filling them per gate is follow-up work in each surface.
- **Replacing the platform's static pages, and a cross-app (eaiden, union) UI.**