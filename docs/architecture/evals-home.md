# Phase 1 implementation spec: one eval home on @platform/evals (ct-55687, pl-810)

This spec was written read-only. It starts from the operator design (Design 2), which scored best. It adds Design 0's data split and its prompt-dry-run-only route, and Design 1's request builders and cassette guard. It avoids every fatal flaw the judges named. I re-checked every fact it depends on against the tree on 2026-09-30, and section 10 lists what changed since the survey.

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Where the home lives | A new workspace package `packages/evals` (`@codecast/evals`, private), run by a root launcher `./evals`. It is never mounted under `cast`. |
| Replay route | Every model call goes through `packages/cli/scripts/prompt-dry-run.ts`, as pl-810's rule requires. It gains a `--call` mode for single-call surfaces. The shared request builders make the user prompt and the system prompt prod sends identical to prod's. `--max-output-tokens` plus the `prod-budget` and `model-as-pinned` gates recover most of the fidelity `claude -p` loses. Three gaps remain: temperature (claude cannot set it; `run.json` records what prod sends), a fixed preamble of about 175 input tokens that claude adds on a subscription login (an SDK identity line in the system prompt and reminders for the environment, the model and today's date, which matters to a date-sensitive prompt), and a neutral system line (`Follow the user's instructions.`) where prod sends no system prompt (title, settle, insight, call-summary, handoff, suggest). The API backend (founder decision 2) closes all three. No prod API key is ever needed. |
| How a freeze picks its surface | A `<surface>@<ref>` prefix on the ref. `FreezeResolver.resolve` only ever sees `{messageRef, runRef}`, and tags are applied after it returns (`platform/.../cli/freeze.ts:56-57`). |
| One concept for cases | Every case is a freeze. Settle's 17 synthetic cases, org snapshots and real moments are all freezes. The `sim` seam stays unset. |
| What goes in git (the repo is PUBLIC) | Surface code, synthetic fixtures (with their labels inside), and freeze pointers for synthetic fixtures only. Every real freeze, snapshot, run, label and ground-truth file lives in `EVALS_HOME`. Codecast's own grade sets are kept private too. That is founder decision 1, with this as the default. |
| `EVALS_HOME` | `${CODECAST_EVALS_HOME:-~/.local/share/codecast/evals}`. This is a data dir, not a cache, because hand labels are precious. `labels/` is a git repo whose remote is the private GitHub repo `ashot/codecast-eval-labels`; every label write commits and pushes (founder decision sd-319, 2026-09-30). |
| Reads for freezes | Access-checked only. Session reads use `cliFetchRead` on `/cli/read` plus `readAuthConfig` (config.json stores the token encrypted, and `readLocalConfig` does not decrypt it), imported directly with no new `--json` flags. The inbox uses `cast sessions --json`, calls use `cast call <id> --json`, and a trigger is read through `/cli/tasks/list` (what `cast trigger ls --json` reads; there is no `cast trigger show`), with a role's wake frame from the self-only public query `agentTasks:injectFrame`, the one the daemon delivers it through. No `run.sh`, no system-table reader, no `npx convex run`. The one new server read is a self-only `/cli/suggestion-profile` route. |
| Agent replays | Reads are served from a cassette keyed by an argv hash, with UNSERVED logging and a `frozen-reads` gate. There is no generic `<w1>.txt` fallback. `cast org review` without `--spawn` becomes a permitted read. |
| Precheck | `./evals stale` hashes the declared sources at HEAD with `git rev-parse HEAD:<path>` and never reads the disk. A surface is blocked after 2 crashes on the same hash. `check --stale` skips a surface whose sources are dirty in the checkout. |
| Model pins | Call surfaces use `CHEAP_MODEL`, imported from `convex/lib/anthropic.ts`. `JUDGE_MODEL` and `AGENT_MODEL` are `claude-sonnet-5-5`. The role and anchor surfaces pin the production session's model when the resolver can read it, context suffix (`[1m]`) included. org-review pins `PROD_DEFAULT_MODEL` (`claude-opus-5-5`), because `cast org review` spawns the analyzer with no `--model` and it runs on the person's Claude Code default. `AGENT_MODEL` is the fallback for fixtures and for freezes whose capture read no model. `prompt-dry-run.ts --model` is required. |
| Vendoring | Only evals is vendored, through a `PLATFORM_SRC` overlay (section 4, U1). The other eight mirrored packages stay byte-identical. The existing drift is out of scope. |
| Samples | Call surfaces run 5 reps. Agent surfaces run 3 as a smoke test and 8 for any comparison. "Better" means a one-sided Mann-Whitney at p ≤ 0.05. A gate is zero tolerance per sample. |
| Cadence | Trigger A (tr-1245): every 2h, with a stale precheck; call surfaces run, agent surfaces get a manual-run notice in the run's summary. Trigger B (tr-1246): nightly at 03:00, call surfaces only, one rep per freeze. Both use `--spawn`, not `--safe`, and `--model sonnet`, with a `--budget` stop and a `--max-minutes` stop inside the trigger's `--max-runtime`, so `check` ends on its own even when the session that started it is gone. Unattended runs stop for the day at `DAILY_USD` ($20) of real spend. |
| Publishing | `./evals publish` passes `--email-gate --task ct-55687` and republishes one fixed dir. The email gate is a capture step, not secrecy, so the run pages carry runs of public (fixture) freezes only; a run of a private freeze replays a real workspace and never leaves `EVALS_HOME`. |
| Out of Phase 1 | Upstream edits to `~/src/platform`; the API route; a prod parity action; the `briefingFacts` query; the `apply.py` update grade; replays of the `agentTasks` and `storyMode` surfaces (only their model literal moves). |

---

## 1. Goal and done bar

**Goal.** One command, `./evals`, reads codecast moments, freezes them and replays the current prompts against them on a pinned model. It then grades each replay with mechanical gates, weighted checks and one judged criterion, and publishes a gated report. It covers these subtasks:

- settle and suggest (ct-55701)
- titles, insights, call summaries, ask, handoff, role wake frames and anchor briefing (ct-55702)
- the org analyzer, with presentation grading and the ct-49328 gate (ct-55699, ct-55703)

It runs on a cadence (ct-55704) and never runs LLM calls in CI.

**Done when:**

1. `./evals` works from the main checkout and any worktree. `bun test packages/evals` is green in CI's `test-cli` job and makes no network or model calls.
2. Every Phase 1 surface has at least 3 freezes. Each call surface has a 5-rep baseline and org-review an 8-rep baseline, recorded under a pinned model with `model-as-pinned` passing. role-wake and anchor-brief have 3-rep smoke runs on their real freezes only (U15); their 5-rep baselines, at one tree, are still to record, and a comparison on them needs the 8 reps of 2.8.
3. The TS org grader matches `grade.py` on three saved round-36 samples. It fails round-35's samples on `no-wrong-close` (ct-49328).
4. `settle-eval.ts` and `suggest-eval.ts` are deleted. `~/.cache/org-eval` is an untouched archive.
5. Both triggers are armed. Trigger A has shown a precheck skip when nothing changed, and a run that publishes when a committed source changed; that run needs the Phase 1 tree committed, because `check --stale` skips surfaces whose sources are dirty. Trigger B has no precheck, so it has no skip to show: it has run within its `--max-minutes` and published.
6. No committed file under `packages/evals` carries real content. `freezes.guard.test.ts` enforces this.

---

## 2. Architecture

### 2.1 Package and launcher

- `packages/evals` sits inside the root `packages/*` glob. That makes it a workspace member, and `scripts/vendor-platform.sh` (`list_packages`, lines 31-35) finds its `@platform/*` dep lines.
- The deps are:
  - `@platform/evals`, `@platform/cli-kit` and `@platform/snippets`, each as `file:../../platform/packages/<name>`
  - `commander ^12.1.0`
  - `@codecast/shared`, as a `workspace:*` dep if that is how cli declares it; copy cli's line
- The root launcher `./evals` (sh, executable) is:
  ```sh
  #!/bin/sh
  root="$(cd "$(dirname "$0")" && pwd)"
  exec bun "$root/packages/evals/src/index.ts" "$@"
  ```
- It is not mounted under `cast`. `cast` runs from source on every session's boot path, and the release binaries would ship eval code.
- `index.ts` answers `stale` itself, before commander or the platform load, and otherwise loads `main.ts`. `main.ts` builds a commander program named `evals` and calls `registerEvals(program, sources)` and `runEvalsCli`, as eaiden does in `~/src/eaiden/tools/xrun/src/index.ts`.
- The network-backed seams (`convo`, `freezeResolver`, `productionReply`) sit behind eaiden's lazy Proxy (lines 34-41), so `runs` and `freeze list` work with no auth.
- The codecast commands are listed below. Each is one file in `src/commands/`.

| Command | Behaviour |
|---|---|
| `./evals` / `status` | One row per surface: route, pinned model, freezes (public/private/snapshot missing here), last run age, pass rate of the last 5 runs, stale or blocked mark, estimated cost of a default `check` over the freezes whose snapshot is here, the same number `check` estimates and refuses on. Ends with the next command, whose `--budget` is that estimate for the surfaces it names plus half again, rounded up to whole dollars (`suggestedBudget` in `state.ts`), so the suggestion never refuses. |
| `check [surface…] [--stale] [--route call\|agent] [--freeze id…] [--reps n] [--model id] [--budget usd] [--dry] [--publish]` | Replays every freeze of each chosen surface. It estimates the cost first and refuses when the estimate exceeds `--budget`, and it stops mid-run with `endedBecause:'budget'`. It prints a verdict table per surface against that surface's previous run set: pass rate, mean score, min to max, flips, cost, model. It adds `separated` or `not separated` (see 2.8) and ends with `runs diff` / `freeze results` hints. Exit 1 on any gate failure or a separated regression. With `--stale`, the list comes from `stale`; an empty list prints "nothing changed" and exits 0. A surface whose sources are dirty in the checkout is skipped with one line. |
| `stale [surface…] [--route r] [--list]` | The precheck. Surface ids narrow it (`check [surface…] --stale` intersects the same way). Exit 0 when some surface is stale, exit 1 otherwise. No imports beyond `registry.ts` and `state.ts`. Uses git only. Well under 1 s. |
| `snapshot <surface> <args>` | Captures the served world for an agent surface into `EVALS_HOME/snapshots/…` and makes it read-only. Replaces `snapshot.sh`. |
| `grade <surface> <dir>` | Grades an existing output dir with the surface's gates and checks. Used for regrading old org rounds. |
| `capture <surface> <runDir>` | Presentation capture, attended only. org-review is the only surface in Phase 1. |
| `doctor [--init]` | Uses `@platform/cli-kit` doctor, as eaiden's `commands/doctor.ts` does. Checks: the mirror resolves; cast auth (`readAuthConfig` decrypts an auth token); `claude` on PATH; the keychain login, or a note that `--account` is needed on Linux; `EVALS_HOME` exists and `labels/` is a git repo with the private `ashot/codecast-eval-labels` remote and nothing unpushed (`--init` creates the dir, clones the remote, or creates the private repo with `gh repo create --private` when it does not exist); snapshot and label presence per freeze; that `prompt-dry-run.ts` without `--model` exits 2; that `models.ts` pins equal the prod constants; snippet status. |
| `snippet install\|show\|status\|remove` | Copies eaiden's `src/snippet.ts`. It calls `installSectionToFile` from `@platform/snippets` against `AGENTS.md` (the real file, not the `CLAUDE.md` symlink), with codecast's own section (`## Prompt evals`, the codecast reference alone). The platform's generic `evalsSnippet` body covers channels, phones and simulations, which codecast lacks, so it is not stamped; the section's second heading is the generic one, so a re-stamp replaces it in place. |
| `publish [--since 24h]` | Writes `EVALS_HOME/html/site/{index.html, report.html, matrix.html}` through the platform's `runs report` and `runs matrix --html` renderers. Then runs `cast publish EVALS_HOME/html/site --email-gate --task ct-55687 --title "Codecast evals"`. There is no ungated path. |

### 2.2 Vocabulary

- **Surface.** One production prompt with one call site. Each surface is a directory `src/surfaces/<dir>/`, where `<dir>` is the id in camelCase (`orgReview` for `org-review`, as U14 names it), that holds:
  - `meta.ts`: light, no heavy imports, statically imported by `registry.ts`
  - `index.ts`: the implementation, loaded lazily
- **Freeze.** One case: a synthetic fixture, a real moment, or an org snapshot. It is always created with `./evals freeze create <surface>@<ref>`.
- **Run.** One replay rep of one freeze, in one folder under `EVALS_HOME/runs/<surface>-<freeze8>-seed<rep>-<YYYY-MM-DDTHH-MM-SS-mmmZ>/`. That name matches the `fs/runs.ts:53` regex, and `run.json.freezeId` is set on it.

`meta.ts` shape (in `src/surface.ts`):

```ts
export interface SurfaceMeta {
  id: string;                        // 'title'
  title: string;
  route: 'call' | 'agent';
  model: string;                     // pinned id (models.ts)
  sources: string[];                 // repo paths hashed by `stale` (always add this surface's dir and packages/cli/scripts/prompt-dry-run.ts)
  reps: { check: number; smoke?: number };
  maxUsdPerRep: number;              // fallback cost estimate before any real run
  criteria?: string | null;          // the default judge criteria from section 3; a fixture's own `judge` wins
  frozenReads?: string[][];          // agent route: argv templates captured by `snapshot`, e.g. [['brief'], ['org','inputs','--team','{team}','--json']]
  frozenVerbs?: string[];            // agent route: first words (or "w1 w2") that must be served, never live
  allowedRefusals?: string[];        // agent route: REFUSED argv patterns the surface's harness note allows
}
```

The `index.ts` interface:

```ts
export interface SurfaceImpl {
  refForms: string;                                             // one line for the UsageError
  capture(ref: string, ctx: CaptureCtx): Promise<Captured>;     // snapshot + subject + asOf + anchor + visibility
  replay(snap: any, ctx: ReplayCtx): Promise<ReplayOutput>;     // uses ctx.call(req) and/or ctx.agent(opts); may call more than once (ask)
  gates(snap: any, out: ReplayResult, label?: any): GateResult[];   // ReplayResult = ReplayOutput {reply, parsed?, extra?} + every harness run it made {calls, agents}
  checks?(snap: any, out: ReplayResult, label?: any): CheckResult[];
  describe(snap: any): ConvoMessage[];                          // what the judge and convo views show
  productionReply?(snap: any): ProductionReply | null;
  grade?(dir: string, label: any): Score;                       // org only in Phase 1
  capturePresentation?(runDir: string): Promise<void>;          // org only
  summarize?(scores: Score[]): string[];                        // extra lines `check` prints under the verdict (suggest's grade distribution)
}
```

`ReplayCtx` works like this:

- `call(req: SurfaceRequest, opts?)` returns `{text, outputTokens, stopReason, modelUsage, costUsd, isError}`. `opts.grader` marks a call that grades the reply rather than one under test (suggest's hit/partial/miss grader); its prompt stays out of `run.json.promptSha`, while its cost still counts toward the budget.
- `agent({prompt, serveDir, model, tools, maxTurns, then?})` returns `{runSubdir, said, calls, costUsd, modelUsage, isError}`.
- Both spawn `prompt-dry-run.ts` through `adapters/dryRun.ts`.
- `ctx.dry` makes both return canned output without spawning, for tests.

### 2.3 Data homes and privacy

In git, under `packages/evals`:
- `freezes/*.json`: synthetic freeze pointers only.
- `fixtures/<surface>/<case>.json`: synthetic snapshot content, with `label` inline.
- `src/**`: the code.

Out of git, in `EVALS_HOME`:
- `freezes/`: private freeze pointers (every real moment)
- `snapshots/<surface>/<sha12>.json` and `snapshots/<surface>/<name>/` for agent served worlds
- `runs/`
- `labels/<surface>/…`: a git repo
- `html/`
- `state.json`: stale hashes, crash streaks, notified hashes, and last cost per surface

**Composite freeze store** (`adapters/freezes.ts`, about 40 lines over two `fsFreezeStore` instances):
- `create` routes by `meta.visibility`, which the resolver sets. It is `public` only for `fixture:` refs.
- `list` merges both stores. `get` tries public, then private, and throws on an ambiguous prefix across both.
- A public write passes through `committedFreeze()`:
  - Allowed keys are `id, name, createdAt, anchor{kind,id}, subject{id,kind,title}, asOf, trigger{type}, judge, notes, tags, meta{surface, visibility, snapshot}`. Any other key is refused, with its name in the error.
  - `subject.title` becomes `<surface> <case>`, because `fs/freezes.ts` searches that field.
  - `trigger.data` is dropped.
  - A string that `containsSecrets` (`packages/cli/src/secretRedaction.ts:154`) matches is refused.

**`src/freezes.guard.test.ts`** fails on any of these:
- a committed freeze outside the allowlist, or not `visibility: 'public'`, or not `subject.kind: 'synthetic'`
- a committed freeze whose `meta.snapshot` does not resolve to a committed fixture
- a `containsSecrets` hit anywhere under `freezes/` or `fixtures/`
- any string under those dirs that looks like a Convex document id (`/\b[a-z0-9]{32}\b/`)
- in a freeze file, a `judge` longer than 1000 characters or any other string longer than 300 characters (fixtures hold synthetic transcripts, so they get the secret and id scans only)

Snapshots of real moments pass through `redactSecrets` (`secretRedaction.ts:143`) before they are written. They are content-addressed: sha256 of the canonical JSON, file named by the first 12 hex characters. A replay recomputes the hash and fails gate `snapshot` on a mismatch.

### 2.4 Freeze creation

The ref grammar is `<surface>@<ref>`. The resolver splits on the first `@`. An unknown or missing surface raises a one-line `UsageError` that lists every surface's `refForms`, for example: `title@ needs a session and line, like title@jx7c6zk:142`. `--run` is refused with a pointer to the prefix form.

| Ref form | Surfaces | asOf |
|---|---|---|
| `fixture:<case>` | all | fixture's `asOf` |
| `<session7>:<line>`, or a session id or share URL with `#msg-<messageId>` (a bare message id cannot be read: `/cli/read` needs the conversation). `adapters/moment.ts` (`readSessionMoment`) parses both forms and reads the rows up to the line. | title, insight, settle, suggest, ask, handoff | that message's timestamp |
| `<callId>` | call-summary | call end |
| `<trigger tr-N>` or a snapshot name | role-wake (the "now" form: `./evals snapshot role-wake --trigger tr-N --team T --role <handle>` captures the reads, and `freeze create` reads prod's frame within the hour after) | snapshot's `captured_at` |
| `<session7>[:<line>]` | anchor-brief (the user message at that line, default 1, is the production opening: a seat adopted from an older session has its opening later; reads captured now by `./evals snapshot anchor-brief --session <id> --team T --role <handle>`) | snapshot's `captured_at` |
| `<snapshotName>` | org-review (for example `union-base8`, a dir already in `EVALS_HOME/snapshots/org-review/`) | snapshot's `captured_at` |

**ConvoSource** (`adapters/convo.ts`):
- `inbox` spawns `cast sessions --json`.
- `load` and `message`: when the subject has a freeze snapshot, they return the snapshot's messages. Otherwise they page `/cli/read` via `cliFetchRead(`${siteUrl}/cli/read`, …)` with `{api_token, conversation_id, start_line, end_line, full_content: true}`. `siteUrl` and `api_token` come from `readAuthConfig(defaultConfigDir())` (`packages/cli/src/config/readAuthConfig.ts`), which decrypts the stored token.
- `find` runs `cliSearchRequest(siteUrl, {api_token, query, …})`.
- Messages map to `ConvoMessage` as follows: `channel: 'session'`, `isGroup: false`, `direction` inbound for user and outbound for assistant, `at` = the message's ISO timestamp, so that `momentOf`'s cut works.
- `toRows()` maps `/cli/read` messages to the row fields the prod selectors read. U4 writes the mapping and a fixture test.

The private freeze `meta` also carries: `{surface, visibility:'private', snapshot, conversation_id|call_id|trigger_id|workspace, model?, captured_at}`.

### 2.5 Replay routes, all through prompt-dry-run.ts

**Call route** (settle, title, insight, call-summary, ask, handoff, suggest):
- The surface builds a `SurfaceRequest {model, system?, prompt, max_tokens, temperature?}` with the same exported function prod uses (units U5-U7).
- `ctx.call` writes `prompt.md` and `system.md` (if any), then runs:
  ```
  bun packages/cli/scripts/prompt-dry-run.ts --run <runDir>/call<k> --prompt prompt.md --call [--system system.md] --model <req.model> --max-output-tokens <req.max_tokens>
  ```
- Gates added on every call:
  - `model-as-pinned`: `out.json.modelUsage` has the pinned id, and it has the most output tokens.
  - `prod-budget`: `stop_reason !== 'max_tokens'` and `usage.output_tokens <= max_tokens`. If `--max-output-tokens` is honoured, prod would have truncated at exactly this point; if not, the gate still flags it.
  - `ok`: `is_error` is false and the exit code is 0.
- `run.json` records `temperatureProd`, the temperature each call under test sent as prod's builder set it (`api-default` when it sets none), read from the requests rather than copied into meta, and `temperatureReplay: 'cli-default'`. That gap is the known fidelity limit (founder decision 2).

**Agent route** (org-review, role-wake, anchor-brief). `ctx.agent` runs:
```
prompt-dry-run.ts --run <runDir>/agent --prompt prompt.md --model <pin> --serve <snapshotDir> [--max-turns N] [--tools …] [--then <file>]...
```
Each `--then` is one more turn sent into the same session once the previous one ends (turn N writes `outN.json` and `saidN.json`, and `calls.log` gets a `# turn N` line before its calls). `AgentResult.turns` keeps what was said per turn, and the run's cost is the sum over its turns.
Then `layout.ts` folds its outputs into the platform layout:
- `said.txt` becomes `sends.json` and `send_captured` events.
- Each `calls.log` line becomes a `cast_call` event.
- `out.json` cost and turns go to `result.json`.
- `err.txt` goes to `run.log`, so the platform's crash view shows the last 12 lines.

Gates:
- `model-as-pinned`
- `ok`
- `frozen-reads`: no `UNSERVED` line in `calls.log`. The evidence names the argv and the fix: "add it to meta.frozenReads and re-run `./evals snapshot` (for a fixture, add it to the world it reads)".
- `no-unexpected-writes`: no `REFUSED` line except the patterns the surface's harness note allows.

**Replayer** (`adapters/replay.ts`). For each rep, capped at 25:
1. Load the snapshot and check its hash.
2. Run `surface.replay`.
3. Run the gates and checks.
4. Run the judge when `freeze.judge` is set.
5. Write the run folder through `layout.ts`. It writes the same files and field names as the platform's `writeFixtureRun` (`platform/packages/evals/src/fixture.ts`): `result.json` (`endedBecause`, `costUsd`, elapsed from `took.txt`), `events.jsonl`, `sends.json`, `captures.json` (the request and raw reply), `score.json`, and `run.json`. `run.json` holds `{freezeId, notes, model, route, sourceHash, promptSha, judgeModel, budgetUsd, gitHead, dirty, dry, temperatureProd, temperatureReplay, liveReads}`. `dry: true` marks a `--dry` rep: the platform summarizes it as status `dry`, never a pass or a fail, so no view counts it and no `check` takes it for a previous run set. `liveReads` counts the agent reads that went to the live workspace; above 0, the rep saw a world its snapshot does not hold and is not reproducible.

`ReplayOptions.model` overrides the surface's primary model for ablation, and the override is recorded. The judge model never changes.

**Judge** (`adapters/judge.ts`). It uses eaiden's prompt shape (`adapters/freeze.ts:75-112` in xrun):
- the transcript up to `asOf` (from `surface.describe`), the reply, and one check `criteria`, returned as JSON `{score 0..1, reasoning}`
- it passes at 0.7 or above
- it runs through `ctx.call` on `JUDGE_MODEL` with `max_tokens` 1500
- `Score` records `judgeModel` and `judgeCostUsd`
- the check id is `criteria`, because the freeze page reads it (`html/freeze.ts:22`)
- a freeze tagged `must` gives the check a `must` floor of 0.7

### 2.6 Guard: served reads

All of this is in `packages/cli/scripts/prompt-dry-run-bin/cast`, in this order:

1. Log `"$*"` to `calls.log`, as today.
2. Keep the three existing org cases (`org inputs|health|ls` from `org-inputs.json`, `org-health.json`, `org-ls.json`) and `org proposals`. Old `served/` dirs keep working unchanged. Each answer also logs `SERVED <argv>`.
3. When `SERVE` is set: compute `key = sha256` of the bytes of each argument followed by `\x1f` (`printf '%s\x1f' "$@" | shasum -a 256`, with `sha256sum` as the fallback). If `$SERVE/reads/$key.out` exists, print it, log `SERVED <argv>`, and exit with the contents of `$SERVE/reads/$key.exit`, or 0 when that file is missing.
4. Classify the argv as a read by the existing live read dispatch, with `review` added to the org read verbs only when no argument is `--spawn`. `cast org review` without `--spawn` prints the review prompt (`orgInit.ts:102`). `brief` is a read unless any argument is `edit` (it writes the narrative and pins the standing session's state), and `call` unless any argument is `hold` (it changes a live huddle's delivery) or `snap` (it uploads frames). Any argument, because commander takes a subcommand after the parent's flags.
5. A read, when `SERVE` is set and `$SERVE/frozen` lists `$1` or `"$1 $2"`, or holds a `*` line (a fixture's closed world): refuse with `dry run: 'cast <argv>' is frozen for this replay and was not captured`, log `UNSERVED <argv>`, and exit 1. Any other read logs `LIVE <argv>` and goes to the real `cast`, and its output and exit code are kept under `$RUN_DIR/live-reads/<key>.out|.exit`, the served-read layout. The frozen check applies to reads only, so a write under a frozen verb (`org propose` with `org` frozen) is a refused write for `no-unexpected-writes`, never an uncaptured read for `frozen-reads`.
6. Everything else is refused as before, and logs `REFUSED <argv>`.

The same key is computed in TS by `src/served.ts` (`servedReadKey(argv)`). Both the TS test and the guard test assert these vectors:
- `["brief"]` → `5aade2e80f5dd74f765b32cf20b9954d5283af5331c34e0ad909d8a609cecbcf`
- `["org","review","--team","T"]` → `c3c8e1815ea12c65ef7b12528037651900c290fc2fe246959cf0beb491c3b04a`

`./evals snapshot <surface>` does the following:
- Runs each `meta.frozenReads` argv, with placeholders filled from its args, through the real `cast`.
- Writes `reads/<key>.out` and `.exit`, after `redactSecrets`.
- Writes `frozen` from `meta.frozenVerbs`.
- For org-review, also writes the three legacy file names.
- Writes `captured.json` `{argv list, captured_at, gitHead}` and chmods everything 444.

### 2.7 Scoring

- **Gates** are mechanical, zero the score, and run per surface as listed in section 3. The platform's `Score` does the rest: `score = 0` on any failed gate, otherwise the weighted mean of the checks.
- **Checks** come in two kinds:
  - mechanical weighted checks: org recall bands, coverage, summary words, suggest grades
  - the one judged `criteria` check per freeze
- If a freeze has neither a label nor judge criteria, `check` warns ("only gates grade this freeze") and still runs it.

### 2.8 Samples, stability, separation

- Default reps come from `meta.reps`:
  - call surfaces: 5
  - agent surfaces: 3 (smoke) and 8 for `check --compare`
  - org-review always 8 when run by hand
- `check` prints the per-freeze mean score and min to max across reps.
- When a previous run set on the same freeze set exists (same `promptSha` baseline or the `--against <gitRef|runId>`), `stats.ts` runs an exact one-sided Mann-Whitney U on per-rep scores.
  - At p ≤ 0.05 it prints `separated: better|worse`.
  - Otherwise it prints `not separated: medians X vs Y, ranges a-b vs c-d`.
  - With fewer than 5 reps on either side it prints `too few samples to separate (need 5+ per side)`.
- The snippet's `repoNotes` states the rule: never claim a win without `separated`, and a single gate failure in any sample fails the variant.

### 2.9 Cadence, budget, publishing

**`state.json` per surface:** `lastRunHash`, `lastNotifiedHash`, `lastRefusedHash`, `crash {hash, count}`, `lastCostPerRep`, `lastSecondsPerRep` (a rep's average wall time in the last real run). **`spend.json`:** the real spend of the current UTC day across every check.

**`stale` rules:**
- `hash = sha256(join(git rev-parse HEAD:<p> for p in meta.sources))`. `state.ts` reads every surface's objects with one `git ls-tree -z HEAD -- <paths>`, which names the same objects; a path HEAD lacks hashes as `missing`.
- A call surface is stale when `hash ∉ {lastRunHash, lastRefusedHash}`. An unattended `check --stale` that refuses on its `--budget` records `lastRefusedHash`, so the refusal is named once per source change and the surface waits for a run by hand.
- An agent surface is stale when `hash ∉ {lastRunHash, lastNotifiedHash}`.
- It is blocked, and not counted as stale, when `crash.hash === hash && crash.count >= 2`.
- The precheck shows a stale call surface whose sources are dirty in the checkout but does not count it, because `check --stale` skips it. Counting it would spawn a run that does nothing every 2h until the edit is committed.
- Once the day's real spend reaches `DAILY_USD` ($20), the precheck exits 1 and `check --stale` refuses, until the next UTC day. A check by hand is never refused, but its spend counts. Unattended, the budget stop is also what is left of the day.
- A check that stops short (the budget, `--max-minutes`, or a surface that scored no rep) exits 3, and a surface it cut short keeps its old `lastRunHash`, so the next firing finishes it.

**Parallel reps.** `check` puts every rep of every freeze of every chosen surface into one pool of `--parallel` slots (default 4, `DEFAULT_PARALLEL` in `commands/check.ts`; the bounded map is `mapLimit` in `@codecast/shared/async`). Jobs go in surface order, so a stop leaves later surfaces unreached instead of every surface half run. The reps share one ledger (`RepLedger` in `adapters/replay.ts`): a rep starts only while the spend so far, plus the estimated cost of the reps still in flight, plus its own estimate fit the budget, and only before the `--max-minutes` deadline. The first rep that finds no room writes the stop folder and marks the ledger, so every later rep returns without a trace. `freeze replay` still runs one freeze's reps one after another. HEAD, source hashes and dirtiness are read once per check (`treeFacts`), not once per freeze.

**Time estimate.** `check` prints the minutes a real run takes next to its cost: each surface's reps times its `lastSecondsPerRep`, divided by `--parallel`. It prints nothing until every chosen surface has a real run on record, warns when the estimate is over `--max-minutes`, and prints the estimate under `--dry` too, so a dry check sizes a real one for free.

**Sizing, measured on 2026-10-02** at load 400 to 800 on 16 cores. Run one at a time, a rep took 43 to 50 seconds of wall time. The 3-rep nightly passes (171 reps) took 125 to 144 minutes, so tr-1246 hit its 120 minute runtime three times running (each kill was a retry) and was retired. Tr-1245's 5-rep pass stopped at its 105 minute limit after 147 of 285 reps. A calibration of every call freeze at 1 rep and `--parallel 6` (58 reps, `--no-state`) ran in 461 seconds, 7.9 seconds of wall time a rep. Each rep's own time held at a 40 second median, so six slots did not slow a rep down, and a slot count's minutes are close to `reps × seconds per rep ÷ parallel`. At that rate the 3-rep nightly (174 reps) takes about 23 minutes, and an all-stale 5-rep pass (290 reps) about 38. Every call surface declares `lib/anthropic.ts` and `prompt-dry-run.ts`, so a change to either makes them all stale at once. `check` refuses outright when its estimate is over `--budget`, so a budget below the all-stale estimate ($5.94 at 5 reps on 2026-10-01) would refuse on every firing and never record a run.

**Trigger A** (tr-1245), "Evals: prompts changed":
```
cast trigger add - --every 2h --spawn --model sonnet --max-runtime 90m --precheck './evals stale' --title "Evals: prompts changed"
```
The prompt tells the run to:
1. Run `./evals check --stale --parallel 6 --budget 8 --max-minutes 60 --publish`.
2. For each agent surface the output names as "manual run needed", run nothing. `check` has already set `lastNotifiedHash`.
3. Complete with `cast trigger complete <id> --summary "<table + URL>"`. Add `--needs-attention` only on a separated regression, a crash, a refusal on `--budget`, a stop on the budget or the time limit, or a check that failed to finish. Gate failures and manual-run notices go in the summary, not the inbox (the plan owner's call on 2026-10-01, after the first notice run paged the inbox). A notice is named once per source hash, because `check --stale` records `lastNotifiedHash`.

A spawned run is one `claude -p` turn (`taskScheduler.ts`), so it ends when the agent ends its turn, no background-task notice reaches it, and one shell call stops at 10 minutes. Both prompts start `check` detached with its output and exit code going to files, then keep the turn alive by waiting for the exit file in foreground shell calls of under 10 minutes each. A session killed at its `--max-runtime` does not take the detached `check` with it, so `--max-minutes` is what ends `check`: it starts no rep past the limit and exits 3. Each `--max-runtime` sits above its `--max-minutes` by the longest rep (about 3.5 minutes) plus publishing and the summary: A at 60 and 90m, B at 45 and 75m.

`check --stale` publishes only when it ran something; "nothing changed" exits before publishing.

**Trigger B** (tr-1267), "Evals: nightly drift", which replaced tr-1246 on 2026-10-02:
```
cast trigger add - --in <minutes until 03:00>m --every 1d --spawn --model sonnet --max-runtime 75m --title "Evals: nightly drift"
```
A recurring trigger's first run anchors its grid (`nextArmingAfterRun`), so `--in` with `--every` sets the time of day. `cast trigger add` ignored `--in` beside `--every` until U18 fixed it. B runs `./evals check --route call --reps 3 --parallel 6 --budget 7 --max-minutes 45 --notes nightly --publish --signal`: 3 reps keep a night comparable with the 3-rep nights already on record, the budget is the estimate and half again, and `--signal` files a signal for each regression, failed gate and failing freeze (ct-56261, asked for by tr-1262). A manual run ahead of the next slot leaves that slot standing, so a `cast trigger run` does not move B off 03:00. Drift means a surface's pass rate falls outside the min to max of its previous 7 nightly run sets: the runs that `runs list --scenario <surface>- --since 8d --json` returns (a `--since` window lists every run in it; the default of 30 rows applies only without one) with notes `nightly`, grouped by the UTC date of `startedAt`. A replay has no simulated clock, so its `startedAt` is when the rep began (layout.ts); the frozen moment stays on the freeze as `asOf`. With fewer than 3 previous nights, the run reports that it is still building a baseline. `check` exits 1 whenever any rep failed a gate, so neither prompt reads the exit code as news; a gate failure inside the usual pass rate does not ask for attention.

A manual `cast trigger run` never runs the precheck (`triggerPrecheckApplies`): a person asking for a run is the evidence. Only a scheduled or recurring firing can show a skip.

Agent surfaces never run unattended. Presentation capture is attended only.

---

## 3. Surfaces

The table has one row per surface. The route, model and max_tokens (m_t) come first, then the ref and snapshot, the gates beyond the route gates, and the default judge criteria. The call-summary max_tokens is 700, read from the code during U6.

| id | Route / model / m_t | Ref and snapshot | Gates beyond the route gates | Default judge criteria |
|---|---|---|---|---|
| settle | call / CHEAP_MODEL / as prod (`idleSummary.ts:333-337`) | fixture or session line. The snapshot is the `shapeSettleTail` input rows. | `parse`: `parseSettleReply` is non-null. `label-match`: the parsed state equals the label. | none (labels decide) |
| title | call / CHEAP_MODEL / 400 (title), short-title as prod | session line. The snapshot is the rows `selectTitleInput` reads, cut at `asOf` (`pickSpineRows` and the newest 20 rows). `/cli/read` has no subtitle or title history, so a captured snapshot carries no `currentTitle` anchor and its `message_count` is the moment's `/cli/read` line; both are listed in the snapshot's `approximate`. A `mode: 'short-title'` snapshot replays `shortTitleRequest`, with the fence nonce pinned to `untrusted-00000000` so a freeze keeps one `promptSha`. | `parse`: `extractTitleJson`. `clean`: `cleanShortTitle` is non-empty. `no-refusal`: `isRefusalProse` is false. | "names what the session is actually doing at this point, specific enough to find it later" |
| insight | call / CHEAP_MODEL / 1200, prod temp api-default | session line. The snapshot is `selectInsightContext` input (the newest 80 message rows before `asOf`, chronological; the selector keeps the first 8 + last 10 turns and the tool names) plus the conversation metadata, commits and PRs that `insightRequest` prints. `/cli/read` gives only the project path, so a captured snapshot leaves title, subtitle, idle_summary and git_branch blank, takes `started_at` from the first row, and has empty commits and PRs (no access-checked read lists them); `approximate` says so. Fixtures may set all of them. | `parse`: the fields the prompt asks for (headline, turns, summary, themes, confidence) parse with prod's `parseInsightReply`, extracted from `generateSessionInsight` in U12. | "the headline and each turn are supported by the transcript: every ask is the user's, every did item happened" (the prompt asks for headline, turns, summary, outcome_type, themes and confidence; it never asks for goal, blockers or next action) |
| call-summary | call / CHEAP_MODEL / 700, prod temp api-default | callId. The snapshot is `cast call <id> --json` segments (`speaker_name` maps to `speaker`), the kind from `callSummaryKind(room_key)`, `started_at`, `ended_at`, and whether it was a rolling recap. | `skip-honored`: under 40 words means no call is made and the replay is an empty pass. `tail-rule`: sources over 60k characters keep the tail. `parse` as prod. `owners-credited`, when the fixture's label lists `owners`: the owners the action items name first (prod's "Sam: …" format) are exactly those, one per item. | "action items are real commitments from the transcript, with owners where stated" |
| ask | call ×2 / CHEAP_MODEL / 200 then 1500 with `ASK_SYSTEM_PROMPT` | session line holding a `cast read <id> --ask "<q>"` call (no id, or `self`, means the asking session). The snapshot is the question, the asked-about session's title, and its non-empty rows up to the asking line's timestamp, not a `selectAskContext` selection: which lines match depends on the terms call's reply, so every rep runs `readRows` and `askAnswerRequest` over the rows with its own terms. | `parse`: `parseTermsReply` finds terms in the terms reply. `citations-real`: every line a citation names on its own was shown: a single `msg N`, or both ends of a range. A range between two shown lines may pass over lines the budget left out; the evidence counts them. | "answers the question from the sessions, says so when it cannot" |
| handoff | call / CHEAP_MODEL / 1200 | session line, or a bare session id that is the child of a real handoff (its first message carries the `# Handed off from` header). The snapshot is the `shapeHandoffTranscript` input (the newest 400 rows, newest first) plus the source facts `handoffBriefInput` reads. | `non-empty`, `no-refusal` | "a cold reader can continue: decisions, state, next steps" |
| suggest | call / CHEAP_MODEL (anthropic provider pinned) / as prod | session line where the next user turn is typed. The snapshot is the context rows, the profile (self-only route), and `truth` (the real next message, excluded from the prompt, as `scrubTruth` does today). | `pipeline-ok`: no `provider_failed` or `invalid_json`. `graded`: the grader returned a grade. | Checks, not criteria: one `grade` check, hit / partial / miss / silent / nudge graded as the retired `suggest-eval.ts` did, judged on JUDGE_MODEL. |
| org-review | agent / PROD_DEFAULT_MODEL / max-turns 200 | snapshotName. The served dir holds legacy files, `reads/` and `frozen` (`org`, and `brief` in snapshots taken since 2026-10-02, so a brief read never reaches the live workspace). | `spec-parses` on each `proposals/op-*.json`. `no-wrong-close` (`must_not_close`, which includes ct-49328). `no-never-name`. `no-phantom-handle` (pool = the labels' handle pool, every snapshot's roster, and the roles runs since proposed). `frozen-reads`. | Checks ported from `grade.py` with the same numbers: records 3/2/1 at recall 70%/40%, sessions, roles_named, coverage, repeats, summary_words. Presentation checks from `capture`, attended only. |
| role-wake | agent / production session model else AGENT_MODEL / max-turns 80 | `tr-N`. A role's trigger runs inline in its standing session, so the frame is the server's inject frame (`triggerRunFrame` in `shared/contracts/triggerLifecycle.ts`, built by `agentTasks.triggerFrameFor`), not `buildTriggerFrame`, which frames a spawned run. A real freeze replays prod's frame; a `fixture:` renders it from the tree over synthetic facts and the routine prompts in `lib/orgRoutine.ts`. Frozen reads: `brief @{role}` (served as `brief`) and its `--json`, `org inputs/health/ls --team T --json`, `sessions` and `sessions --json`, `org review --team T` (served also without `--team`). `frozenVerbs: brief, org, sessions`. | `brief-parses`: the brief the harness note asks for, written to `<runDir>/brief.md`, passes `parseStandingSection`. `no-stale-lines`: `standingLineStale` is false for every line. `frozen-reads`. `no-unexpected-writes`. A fixture's label adds its scenario's gate from `roleWake/actions.ts` (below). | "asks a person only what needs them; each line names evidence" |
| anchor-brief | agent / as role-wake | standing session short id, with the opening's line when it is not 1. The prompt is the production opening (replays test agent and model changes). A second freeze kind, `fixture:`, renders `bootstrapMessage` / `roleOpeningMessage` over synthetic facts so builder edits are tested, and may go on past the opening with `turns`: each is the next message the session gets, either text a person typed or a chat wake rendered by prod's `buildAnchorWake` (chat.ts). | `frozen-reads`, `no-unexpected-writes` (a `cast chat reply` is allowed: a chat wake tells the agent to fill its placeholder with it). A fixture's label adds its scenario's gate over the turns after the opening (below). | "the opening turn orients the role to its scope and does no writes" |

**Agent replay fidelity.** An agent replay is one fresh `claude -p` session, and prod's turn differs from it in ways no gate sees:
- The frame or opening is the user message itself (the harness sends the prompt file on stdin, as prod delivers it), but prod's client may wrap a pasted frame in `<pasted_content>`, and the replay does not.
- The run has a private config dir, `--setting-sources project` and its own run dir as cwd. Prod's role session runs in a checkout with the person's CLAUDE.md (the installed cast instruction block), skills and user settings (model, effort, thinking).
- A role's trigger runs inline in its standing session, with the opening and every earlier wake before it. The replay has none of that history.
- Only the frozen verbs answer from the snapshot. Other reads (`task show`, `plan show`, `feed`, `chat read` and the like; the org analyzer makes thousands) go to today's live workspace, so replays of one freeze on different days see different worlds. Each such read is kept under the rep's `live-reads/` and counted in `run.json.liveReads`. A closed world for a real freeze needs a capture of every read it makes, as the fixtures' worlds have.
Findings that depend on the instructions, the history or a moving world are invisible to these replays; compare reps of one batch, not across days.

The org-review harness note is `mkrun.ts`'s note. It tells the agent to write `proposals/op-<n>.json` and check it with `bun packages/evals/src/surfaces/orgReview/checkProposal.ts <file>`, the port of `check.ts`. `assemble.ts` merges the proposal files, as `assemble-proposals.py` did, and drops asks.

---

## 4. Work units

Units in the same wave touch disjoint files and can run in parallel in the shared checkout. Before editing, every unit runs `git status --short -- <its files>`. If another session has uncommitted edits in one of its files, it stops and coordinates rather than overwriting. Typecheck with `cast check <name>`, never `tsc`. Run tests per file or per package, never the whole suite. Changes stay in the working tree.

### Wave 1

**U1: Vendor @platform/evals** (ct-55698)

Files:
- `packages/evals/package.json`, final: name, private, `type: module`, deps from 2.1, `scripts.test: "bun test src/"`, and cli's devDependencies (`@types/bun`, `@types/node`, `typescript`) so U4's typecheck has its types
- `bun.lock`
- `platform/packages/evals/**`, generated
- `platform/vendor-manifest.txt`

Steps:
1. `git -C ~/src/platform status --short packages/evals`, and record the result.
2. Build an overlay source so only evals changes:
   ```
   rm -rf /tmp/plat-src && mkdir -p /tmp/plat-src/packages
   cp -Rp platform/packages/* /tmp/plat-src/packages/
   git -C ~/src/platform archive HEAD packages/evals | tar -x -C /tmp/plat-src
   ```
   Use HEAD, not the working tree: it is reviewed code, and the mirror's other packages already differ from platform HEAD (auth and cli-kit hold files HEAD lacks), so vendoring everything from either source would break codecast.
3. Write `packages/evals/package.json`.
4. Run `PLATFORM_SRC=/tmp/plat-src/packages scripts/vendor-platform.sh`.

Acceptance:
- `git status --short platform/` shows only `platform/packages/evals/**` added and `platform/vendor-manifest.txt` modified.
- `git diff platform/vendor-manifest.txt` only adds evals lines.
- `scripts/vendor-platform.sh --check-manifest` exits 0.
- `(cd platform/packages/evals && bun install && bun test)` passes, 17 or more tests.
- `cast --help` and `cast task ls -q x` still run.
- `git diff bun.lock` adds only the `packages/evals` workspace block and its `@platform/*` resolution entries (`commander` and the devDependencies already resolve, so no new packages). bun also writes whatever the committed tree already owed the lock: on 2026-10-01 that was the cli and electron workspace versions from release commits that bumped `package.json` without the lock, and one `@platform/cli-kit` entry reduced to `{}`. Keep those lines, because they are what bun writes for this tree. The real check is that `bun install --frozen-lockfile` passes and leaves `bun.lock` unchanged.
- The commit of `packages/evals/package.json` must include `bun.lock` (Railway frozen lockfile). Note this for whoever commits.

**U2: One home for the Anthropic request body**

Files:
- `packages/convex/convex/lib/anthropic.ts`
- its test: extend `lib/anthropic.test.ts` if it exists, or create it

Changes:
- Export `type SurfaceRequest = {model: string; system?: string; prompt: string; max_tokens: number; temperature?: number}`.
- Export `anthropicBody(req)`. It returns the exact JSON object prod posts: `{model, max_tokens, ...(temperature !== undefined ? {temperature} : {}), ...(system ? {system} : {}), messages: [{role:'user', content: prompt}]}`, with the key order matching today's fetch bodies. Read them first; if the literal bodies differ in key order, keep the order `JSON.stringify` produces today per site by letting each site pass its own order. Byte-identity is the test, not this sketch.
- `callModel` builds its body through `anthropicBody`, and its default temperature of 0 is unchanged.
- Checked on 2026-10-01: every server fetch body (`callModel` and the eight literal sites in section 7) uses the order model, max_tokens, temperature, system, messages, so one order serves all sites and none needs its own. A site with no `temperature` key today passes `temperature: undefined`.

Acceptance:
- a test asserts `JSON.stringify(anthropicBody(x))` equals the string `callModel` sent before, for 3 inputs
- `cast check convex` is green

### Wave 2 (after wave 1, all parallel)

**U3: Harness** (ct-55700)

Files:
- `packages/cli/scripts/prompt-dry-run.ts`
- `packages/cli/scripts/prompt-dry-run-bin/cast`
- new `packages/cli/scripts/prompt-dry-run.guard.test.ts`

Precondition: `pgrep -fl prompt-dry-run` is empty. Never edit the guard while a run is alive.

`prompt-dry-run.ts` changes:
- `--model` is required. It exits 2 with `--model is required: an unpinned run takes the account default and cannot be compared`. Update the usage line at 62.
- It writes `args.json` `{model, call, maxOutputTokens, tools, maxTurns, serve, guard}` to the run dir.
- New `--call` mode:
  - the prompt file's text goes to `claude -p` on stdin as the whole user message (there are no tools to read a briefing file with)
  - `--tools ""` in place of `--allowedTools`, and no `--dangerously-skip-permissions`
  - `--max-turns 1`
  - `--system-prompt-file <--system file>`, or a one-line neutral system `Follow the user's instructions.`
  - `--strict-mcp-config`, `--disable-slash-commands`, and in the child's env `CLAUDE_CODE_DISABLE_THINKING`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and `CLAUDE_CODE_DISABLE_ATTACHMENTS`, because a prod call has no thinking, CLAUDE.md or memory (claude 2.1.286 thinks by default, with a 31999 token budget)
  - no guard or serve needed, but keep all the isolation
  - `--then`, `--tools` and `--max-turns` are refused, and `--system` without `--call` is refused
  - `--include-partial-messages`, so the stream carries each API response's `stop_reason` and usage. A reply cut at `max_tokens` makes claude resume the turn by itself ("Output token limit hit", up to three times, no knob turns it off) and end on an error. Prod gets the first reply only, so when that happens `out.json` reports the first reply's text, `stop_reason` and `usage`, sets `is_error: false`, `num_turns: 1` and `resumed_past_cap: <n>`, and the exit code is 0. `total_cost_usd` and `modelUsage` stay the whole run's real spend.
  - what claude still adds on a subscription login is fixed, about 175 input tokens: an SDK identity line in the system prompt and three reminders (environment, model, date) before the prompt. `CLAUDE_CODE_SIMPLE` would drop them but refuses OAuth.
- New `--max-output-tokens N`, which sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=N` in the child's env only. An inherited `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is dropped, so `args.json` names every cap. Measured on 2026-10-01: claude sends it as the request's `max_tokens`.
- Line 26 already named `prompt-dry-run-bin/cast`; describe the served reads there.

Guard changes: as in 2.6.

The test runs the guard as a subprocess with a temp `RUN_DIR` and `DRY_RUN_SERVE_DIR`, and a fake real `cast` earlier on PATH that echoes `LIVE $*`. It takes the key from U4's `servedReadKey` (`packages/evals/src/served.ts`), so the TS and bash keys are proven equal. It also runs the harness against a fake `claude` and a fake `--account` token in a temp `CODECAST_DIR`, with no keychain or network, to check the `--call` flags, stdin, env and the first-reply rewrite. It asserts:
- the legacy org files are served
- a `reads/<key>.out` hit is served with its exit code
- a frozen verb miss prints the refusal and logs `UNSERVED`
- a non-frozen read goes to the fake live `cast`
- `org review --team T` is live, and `org review --spawn` is refused with `REFUSED`
- `task create` is refused
- the two key vectors hold
- `bun prompt-dry-run.ts --run /tmp/x --prompt <file>` without `--model` exits 2 without spawning `claude`

Acceptance:
- `bun test packages/cli/scripts/prompt-dry-run.guard.test.ts` is green.
- `grep -rn "prompt-dry-run.ts" --include=*.ts --include=*.sh --include=*.md .` shows no in-repo caller without `--model`, apart from docs that U16 updates.
- Manual smoke, which spends a few cents of the subscription window: `--call` on a prompt `Reply with the word ok.` with `--model claude-haiku-4-5-20251001`. Then:
  - `out.json.modelUsage` has only that id, or it dominates
  - `usage.input_tokens + cache tokens` is within 300 of a local estimate of system + prompt, which proves no hidden Claude Code context
  - a second smoke with `--max-output-tokens 20` and "count to 200" ends with `stop_reason: "max_tokens"`
- If the cap is ignored, record that in the task. The `prod-budget` gate still catches overruns, so this is not a blocker.

**U4: Core package** (ct-55698)

Files, all new:
- `evals` (root launcher)
- `.codecast/check.toml` (add `evals = "packages/evals/tsconfig.json"`)
- `packages/evals/tsconfig.json`: model it on `packages/cli/tsconfig.typecheck.json`, include `src/**` plus the convex, shared and cli source files the surfaces import (today `lib/anthropic.ts`, `cliHttp.ts`, `config/readAuthConfig.ts`, `secretRedaction.ts` and `ccKeychain.ts`, which doctor's login check reads), no `rootDir`, `noEmit`
- `packages/evals/src/{index,main,paths,models,surface,registry,layout,stats,served,state,snippet}.ts` (`main.ts` is the program; `index.ts` keeps `stale` off its import graph)
- `src/adapters/{convo,freezes,resolver,replay,judge,runs,dryRun}.ts`
- `src/commands/{status,check,stale,snapshot,grade,capture,doctor,snippetCmd,publish}.ts`
- `src/testSurface.ts`: an `echo` surface used only by tests
- `src/surfaces/<id>/meta.ts` for all 10 surfaces, values from section 3
- `src/surfaces/<id>/index.ts` stubs that throw `"<id> is not implemented yet"`
- `src/{cli,freezes.guard,served,stats,state}.test.ts`, plus `src/adapters/convo.test.ts` (the `toRows()` fixture test from 2.4) and `src/adapters/replay.test.ts` (route gates, scoring, `snapshot` with an injected `cast`)
- the test hooks, read only from the environment: `CODECAST_EVALS_REPO_ROOT` points `stale`, the dirty check and the public freeze and fixture dirs at a scratch git repo, and `CODECAST_EVALS_TEST=1` registers the `echo` surface. The public tree check lives in `adapters/freezes.ts` as `auditPublicTree`, so the guard test and `cli.test.ts` share it.
- `freezes/.gitkeep`, `fixtures/.gitkeep`

`models.ts`:
- `export { CHEAP_MODEL as CALL_MODEL } from '../../convex/convex/lib/anthropic'`
- `JUDGE_MODEL = 'claude-sonnet-5-5'`
- `AGENT_MODEL = 'claude-sonnet-5-5'`

`paths.ts`:
- `REPO_ROOT`
- `EVALS_HOME` and its subdirs
- `PUBLIC_FREEZES = packages/evals/freezes`
- `FIXTURES = packages/evals/fixtures`

`snippet.ts` holds the `repoNotes`:
- the prefix ref grammar
- the two data homes and the rule that real content never enters git
- the separation rule
- that agent surfaces are manual

The index wires `EvalSources` as `{convo, freezes, freezeResolver, replayer, judge, productionReply, runs}`, and `sims` stays unset.

Acceptance, with no model calls:
- `CODECAST_DIR=$(mktemp -d) ./evals --help` prints all four platform groups and the codecast commands.
- `./evals stale` answers in under 1 s: `time ./evals stale; echo $?`.
- `cli.test.ts` covers:
  - help with no auth
  - `runs show` over `writeFixtureRun` in a temp `EVALS_HOME`
  - `freeze create echo@fixture:a` writes a public freeze that passes the guard test
  - `freeze create nope@x` errors with the surface list
  - `check echo --dry --reps 3` writes 3 folders that `runs list` shows and `freeze results` reads
  - `check --budget 0.0001` refuses before running
  - `stale` exit codes across a temp git repo commit
  - `check --stale` with an empty list runs nothing
  - a dirty source skips its surface
  - a crash streak of 2 blocks a surface
  - `snippet show` equals `EVALS_SNIPPET` and carries no channel, phone or sim lines
- `freezes.guard.test.ts` fails on a planted bad file (in a temp copy) and passes on the tree.
- `stats.test.ts` checks Mann-Whitney exact p on known vectors: 5 vs 5 all-greater gives p = 1/252.
- `served.test.ts` checks the two key vectors.
- `cast check evals` is green.
- `bun test packages/evals` is green.

**U5: Title, settle, trigger title, story on shared requests**

Files:
- `packages/convex/convex/titleGeneration.ts`
- `idleSummary.ts`
- `agentTasks.ts`
- `storyMode.ts`
- `titleGeneration.test.ts`
- `idleSummary.test.ts`
- new golden files under `packages/convex/convex/__golden__/`, one per surface (`title.json`, `short-title.json`, `settle.json`)
- new `packages/convex/convex/__golden__/golden.testkit.ts`, shared by U6 and U7. Its name has two dots so the Convex bundler skips it, since it imports `node:fs`. It holds:
  - `goldenBody(req)`, the body prod posts for a request, with the fence nonce pinned
  - `captureFetch(reply)`, a fetch stub that records each posted body and answers in the Messages API shape (`type: "text"` blocks), so a reply reaches `callModel`
  - `loadGolden(name)`, which only reads; tests that check a builder against a recorded body use it
  - `recordGolden(name, actual)`, which returns the recorded cases with `actual`'s names for `expect(actual).toEqual(…)`. Under `UPDATE_GOLDENS=1` it first merges `actual` into the file case by case, so two tests sharing one golden never erase each other, and a test that only reads can never blank a golden
- new `packages/convex/convex/__golden__/golden.testkit.test.ts`, which proves both re-record properties and that the stub's reply reaches `callModel`

Changes:
- Export `titleRequest(input)` and `shortTitleRequest(input)`, plus a pure `selectTitleInput(rows, conversation)` extracted from `getConversationForTitle`. `rows` is `{spine, latest}`: the prompt rows the three spine reads return, and the newest 20 rows newest first. The query fetches the same rows and calls the selector.
- Also export `pickSpineRows(rows)`, which takes the same three spine views (first 10 prompts, last 10, 4 per time bucket) from an in-memory transcript, and `spineBucketBounds(lo, hi)`, which both the query and `pickSpineRows` use. The title resolver (U12) builds its snapshot with `pickSpineRows` over `/cli/read` rows, so it needs no copy of the sampling.
- Export `settleRequest(tail)` around `buildSettlePrompt`.
- Each site posts through `callModel` (`lib/anthropic.ts`), which sends `JSON.stringify(anthropicBody(req))`. That removes three copies of the fetch, header and error code. Only the error log lines change.
- `agentTasks.ts` (`generateDisplaySummary`, now about line 2651) and `storyMode.ts` use `CHEAP_MODEL`; that is a literal swap only, and storyMode's `SUMMARY_MODEL` alias is gone.
- Order of work: first write golden JSON of today's request bodies for 3 fixtures per site from the current code; then refactor; then assert equality. The goldens run the real actions and queries under convex-test with a stubbed `fetch`, over synthetic sessions.
- `buildShortTitlePrompt` fences its context with `fenceForeignText`, which draws a random nonce per call, in prod as well. The goldens pin it to `untrusted-00000000` and compare everything else byte for byte.

Acceptance:
- goldens are equal
- `grep -rn 'claude-haiku-4-5-20251001' packages/convex/convex --include=*.ts | grep -v test` leaves only `lib/anthropic.ts:7` and any U6/U7 site not yet swapped
- the rows path (`pickSpineRows` + `selectTitleInput` + `titleRequest`, and `settleRequest(shapeSettleTail(rows))`) produces the same golden bytes as the actions
- `cast check convex`
- `bun test packages/convex/convex/titleGeneration.test.ts packages/convex/convex/idleSummary.test.ts packages/convex/convex/__golden__/golden.testkit.test.ts`
- `UPDATE_GOLDENS=1` over every golden test file leaves each golden byte for byte unchanged

**U6: Insight and call summary on shared requests**

Files:
- `packages/convex/convex/sessionInsights.ts`
- `transcripts.ts`
- `transcripts.test.ts`
- new `sessionInsights.request.test.ts`
- goldens

Changes:
- Extract `selectInsightContext(rows)` (from 119: first 8 + last 10, plus the tool names the query derives from the same rows) and `insightRequest(ctx, source)` (from 486-546; `source` is the run reason the prompt prints), with `toLocaleTimeString(…, {timeZone: 'UTC'})` at 466 and `temperature` left undefined so the API default of 1 is preserved. The query now returns the sampled turns instead of up to 80; the action was their only reader.
- Extract `callSummarySource(lines, kind)` (the 40-word skip at 918 and the 60,000-character tail at 921; null means skip) and `callSummaryRequest(source, {kind, started_at, ended_at?, rolling?})` (1116-1142), with temperature undefined. The second argument carries more than the kind because the prompt prints the duration and whether the call is still going. `callSummaryKind(room_key)` names the kind.
- Both handlers post `anthropicBody(req)` with `CHEAP_MODEL`.
- Goldens are generated under `TZ=UTC` before the refactor: `__golden__/insight.json` and `__golden__/call-summary.json`, through the shared `__golden__/golden.testkit.ts`. The insight goldens and builder tests live in `sessionInsights.request.test.ts`, the call-summary ones in `transcripts.test.ts`.
- Record, but do not fix, that the insight parser reads `key_changes`, `timeline`, `goal`, `what_changed`, `blockers` and `next_action`, none of which the prompt asks for. File it as a finding on ct-55702.

Acceptance: goldens are equal, `cast check convex`, and both test files are green.

**U7: Suggest pipeline seams**

Files:
- `packages/convex/convex/composerSuggestions.ts`
- `composerSuggestions.test.ts`
- `packages/convex/convex/http.ts`: one appended route

Changes:
- `predictSuggestions(context, profile, provider, complete = llmComplete)`. It takes its prompt and cap from `suggestRequest`, so an injected `complete` sees exactly what `llmComplete` would.
- The Haiku branch is shared by the suggester and the profile miner, so it gets two builders, both on `CHEAP_MODEL` and posted through `anthropicBody`: `haikuRequest(prompt, maxTokens)` (temperature 0.3, as prod) for the branch itself, and `suggestRequest(context, profile)` for one suggestion moment (`buildPrompt` at the 1200 cap). The eval replays `suggestRequest`.
- Extract `contextFromRows(rows, conversation)` from `getSuggestionContext`. `rows` are in time order and end at the moment being predicted; the selector keeps the newest 60 and filters to real turns, so the live query and a past moment share one window.
- New `POST /cli/suggestion-profile`, appended to http.ts. An httpAction has no db for `verifyApiToken`, so the route forwards only `api_token` to a new internal query `getOwnSuggestionProfile({api_token})`. It resolves the token to its user and reads that user's profile through the same reader as `getSuggestionProfile`. There is no `user_id` parameter; a bad or missing token is a 401. It returns the profile or null.
- The golden is `packages/convex/convex/__golden__/suggest.json`: the bodies for three synthetic suggest moments and one miner call, recorded from the code before the refactor, in the shared `GoldenCase[]` format through `__golden__/golden.testkit.ts` like the other goldens. `UPDATE_GOLDENS=1` rewrites it on a deliberate prompt change; only a recording call writes, so a test that just reads a golden cannot blank it.

Acceptance:
- a test shows the injected `complete` receives the same opts `llmComplete` did
- a golden for the Haiku body
- a route test, or a code read, confirms no user id is accepted
- `cast check convex`

**U8: Trigger frame leaf**

Files:
- new `packages/cli/src/triggerFrame.ts`
- `packages/cli/src/taskScheduler.ts`
- new `packages/cli/src/triggerFrame.test.ts`
- new `packages/cli/src/__fixtures__/triggerFrame.golden.json`: the fixture tasks, the fixed `now`, and each pre-refactor frame

Change: move `buildPrompt`'s body (595 on) into `export function buildTriggerFrame(task, now: number)`. Its imports stay light: `SAFE_MODE_MANDATE` from `./agentLaunch.js`, and `triggerLifecycleInstructions` and `runResultThreadOf` from `@codecast/shared/contracts`. `formatTimeAgo` was a private function at the bottom of `taskScheduler.ts` with no other caller, so it moves into `triggerFrame.ts` unchanged. `Date.now()` becomes `now`. The private `buildPrompt(task)` returns `buildTriggerFrame(task, Date.now())`.

Acceptance:
- the frame for 3 fixture tasks, with and without `last_run_summary`, equals the pre-refactor output at a fixed `now` (golden written first)
- `cast check cli`
- `bun test packages/cli/src/triggerFrame.test.ts`
- importing `triggerFrame.ts` alone does not load `taskScheduler.ts`: check with `bun -e "await import('./packages/cli/src/triggerFrame.ts')"` and an import-graph assertion in the test

**U9: CI wiring**

Files:
- `scripts/ci/changed-path-scope.ts`
- `scripts/ci/changed-path-scope.test.ts`
- `.github/workflows/ci.yml`
- `scripts/ci/ci-workflow.contract.test.ts`, only if it pins test-cli steps

Precondition: if a session is still mid-change on any of these files, send it the exact lines below with `cast send` and wait for them to land. On 2026-10-01 `ci.yml`, `changed-path-scope.ts` and the contract test held Phase 0's (ct-52537) finished but uncommitted edits, untouched for five hours, and the owning session was the dormant orchestrator of this plan, so U9 added its lines beside those edits and kept them byte for byte.

Changes:
- Add `"packages/evals/"` to the `cli` entry of `AREA_PREFIXES`, so `test-cli` runs.
- In `ci.yml`'s `test-cli` job, add a step "Unit tests (evals package)" with `working-directory: packages/evals`, running `bun test src/`, right after the cli unit tests. The job's `setup-bun` composite action installs the root workspace, which includes `packages/evals`, so the step needs no install of its own.
- The contract test pins no test-cli step, so it is unchanged.

Acceptance:
- `bun test scripts/ci/` is green
- a scope test asserts that `packages/evals/src/x.ts` sets `run_test_cli` and does not force every job

**After wave 2:** run `packages/convex/deploy.sh` once from a tree that is a superset of origin/main. This deploys U5-U7 and the new route. It must happen before any push that includes them.

### Wave 3 (after wave 2, parallel; each unit owns only `packages/evals/src/surfaces/<its ids>/` and `packages/evals/fixtures/<its ids>/`, plus the files named)

**U10: settle** (ct-55701). Also deletes `packages/convex/scripts/settle-eval.ts`.

Steps:
- Move the 17 inline cases (22-164) into `fixtures/settle/<case>.json` with the label inline. A fixture's `snapshot` is `{newestFirst}`, the raw rows the old `tail()` handed `shapeSettleTail`; its `label` is `{verdict}`; the old case name is its `notes`.
- Create 17 public freezes: `./evals freeze create settle@fixture:<case>`.
- Before deleting the old script, prove the move lossless. `surfaces/settle/settle.test.ts` pins a fingerprint (sha256 of the rows and verdict) per case, taken from the old script's inline cases, and asserts that each replay sends exactly `settleRequest(shapeSettleTail(rows))` with a prompt equal to `buildSettlePrompt` over that tail. Those two halves keep the proof after the script is gone. A one-time comparison against the old script itself, run before the deletion, found all 17 prompts byte-identical.
- Run `./evals check settle --reps 5`.
- Freeze 3 of the founder's own moments privately (`settle@<session>:<line>`, captured through the shared `adapters/moment.ts`), with labels at `EVALS_HOME/labels/settle/<freezeId>.json` as `{verdict, why}`, committed and pushed in the labels repo.

Acceptance:
- a pass rate is recorded, and `model-as-pinned` and `prod-budget` pass in every rep
- the old script is deleted, and `grep -rn settle-eval` finds only history

**U11: suggest** (ct-55701). Also deletes `packages/convex/scripts/suggest-eval.ts`.

Steps:
- Port `buildFixtures`' pair-finding (`isTyped`, the assistant-turn to typed-reply pairs) into the resolver over `toRows()` from `/cli/read`.
- Read the profile via `/cli/suggestion-profile`.
- Apply `scrubTruth` as today.
- Port the judge rubric (hit / partial / miss / silent / nudge) to checks on `JUDGE_MODEL`.
- Create 2 synthetic fixtures (public) and 5 or more private freezes from the founder's own sessions.

Acceptance:
- `./evals check suggest --reps 5` runs green on gates and reports the grade distribution
- the old script is deleted

As built (2026-10-01):
- Refs: `suggest@<session>:<line>` names the line of the typed reply; the line before it must be the agent turn. A bare `suggest@<session>` answers with the newest moments as refs. The `<messageId>` and share URL forms are not taken: `adapters/convo.ts` has no resolver for them yet, and they belong there, shared with title, insight, ask and handoff.
- A typed reply is judged after `stripInjectionNoise` (`@codecast/shared/contracts`). Claude Code 2.1.277+ wraps every delivered paste, which includes composer sends, in `<pasted_content>`, and `isMachineCarrierText` reads that wrapper as markup, so the old test would discard almost every recent reply. The truth is the unwrapped text; the context rows stay as stored, because that is what prod's selector sees.
- The snapshot holds the rows up to the agent turn (up to 120, so a wider prod window still has rows; `contextFromRows` keeps 60), each cut to the fields the selector reads, with tool results kept only as a count. It also holds the profile as `/cli/suggestion-profile` returns it, minus `_id`, `_creationTime` and `user_id`, and the truth. `/cli/read` carries only the title and project path, so branch, idle summary and thread state are left out; the private freeze records this in `meta.snapshot_approximate`, together with the fact that the profile is the one stored at capture.
- The replay runs `predictSuggestions` with its `complete` sending `haikuRequest(prompt, maxTokens)` through `ctx.call`, which is the request `llmComplete` posts on the anthropic branch and equals `suggestRequest`. `--dry` answers `[]`.
- Scores: hit 1, nudge-silent 1, nudge-shown 0.7, silent 0.7, partial 0.4, miss 0. A rep passes when it showed nothing wrong, and a hit is the only full score. `check` prints `grades: hit … | precision … coverage … | nudge moments …` through `summarize`. Its "only gates grade this freeze" warning skips surfaces that grade with their own checks.
- Freezes: public `fixture:approve-plan` (the agent stops for a verdict, the truth is a reusable prompt the profile holds and also sits in `recent`, so `scrubTruth` has work to do) and `fixture:correction` (the truth is a correction only the developer could write). Six private freezes from the founder's own sessions: five substantive moments and one nudge. Labels are not needed, because the truth is in the snapshot.
- Finding, not fixed here (filed on ct-55701): prod's habit miner (`getRecentUserInputs`) tests raw content with `isMachineCarrierText`, so every `<pasted_content>`-wrapped input is skipped as a machine carrier, and a profile is mined only from messages that arrived unwrapped. `buildPrompt` also shows the wrapper to the suggester inside the context turns.

**U12: title, insight, call-summary** (ct-55702)

For each surface:
- 1 or more synthetic fixtures (public), plus 3 private freezes from the founder's own sessions and calls, with hand-written criteria reviewed for privacy
- `productionReply`:
  - title: current `conversation.title` from `/cli/read`, labelled "current, may postdate the moment"
  - call-summary: the stored summary from `cast call --json`
  - insight: null

Acceptance: `./evals check title insight call-summary --reps 5` completes, and every freeze has a recorded baseline.

As built (2026-10-01):
- The gates reuse prod's own code. U12 extracted `parseInsightReply` (`sessionInsights.ts`) and `parseCallSummaryReply` (`transcripts.ts`) out of their actions, and exported `countWords`, `SUMMARY_MIN_WORDS` and `SUMMARY_MAX_CHARS`, with no change to what either action writes. call-summary's `parse` gate is that parser; `skip-honored` checks that a call was made exactly when the transcript has 40 words or more; `tail-rule` checks the prompt ends with `Transcript:` and exactly the last 60,000 characters.
- A fixture's `"judge": null` means only gates grade its freeze (the call under 40 words makes no model call, so a judge would grade an empty reply). Unset still takes the surface's default criteria.
- `gate()` lives in `surface.ts` for every surface and the replayer; `adapters/moment.ts` is the session-line reader every session surface shares.
- Tests: `src/surfaces/u12.test.ts` (each fixture's request equals prod's builder over the same input; each gate passes a good reply and fails the one it exists to catch).

**U13: ask, handoff** (ct-55702)

- ask: two sequential `ctx.call`s, terms then answer.
- The judge sees the question and the selected context. `productionReply` is null.
- handoff: `productionReply` is the child session's first message when the ref anchors a real handoff (resolved from `/cli/read` of the child). Otherwise null.

As built:
- Prod gained the builders the replay calls, with no change to the bytes posted: `askTermsRequest`, `askTerms`, `askAnswerRequest`, `readRows` and `ASK_BUDGET_CHARS` in `lib/sessionAsk.ts`, and `handoffBriefInput` and `handoffBriefRequest` in `handoff.ts`. Goldens (`__golden__/ask.json`, `__golden__/handoff.json`) were recorded from the actions before the refactor; `sessionAsk.request.test.ts` and `handoff.request.test.ts` prove both the actions and the rows path still post them.
- The judge's "selected context" is a selection made from the question's own words (`questionTerms`) at 60,000 characters, because `describe` sees only the snapshot and the answer's selection also used the terms reply.
- A real handoff is frozen from the child's id (`handoff@<child>`), not a source line: the child's first message names the source, its model, task and plan, and holds the brief, and the source is read up to the child's first message. `productionReply` is that brief, the part of the child's first message the model wrote. Only one real handoff child exists in the founder's sessions (2026-10-01), so the other private handoff freezes are source lines with no production reply.
- Snapshot gaps are listed in each snapshot's `approximate`: titles are today's, the file change index (ask's extra files) and a pre-handoff pinned state are not captured, and `/cli/read` carries no subtype or images.

Acceptance: the same baseline as U12.

**U14: org-review** (ct-55699, part of ct-55703)

Files: `src/surfaces/orgReview/{meta,index,build,checkProposal,assemble,grade,present,migrate}.ts` and `grade.test.ts`. Three one-line seams outside the dir: `ReplayOutput.promptSha` (`surface.ts`, read by `adapters/replay.ts`), `grade?(dir, label, freeze)` with `grade --freeze <id>` (`commands/grade.ts`; without the flag it takes the freeze the dir's `run.json` names), and `LEGACY` exported from `commands/snapshot.ts` so the migration writes the same layout.

Port:
- `build.ts`: `mkrun.ts`. Import `buildOrgAnalyzerPrompt` and `summarizeInputs` from `packages/cli/src/orgInitRun.ts` by relative path. That builder only wraps `headOfPeoplePrompt()` (`packages/shared/contracts/headOfPeoplePrompt.ts`, the analyzer's text), so `meta.sources` lists that file, and `orgProposal.ts`, which `spec-parses` grades against, beside `orgInitRun.ts` and `orgInit.ts`. Keep the harness note, and point it at `checkProposal.ts`. Keep the hashes that `hashes.json` recorded: the replay writes `hashes.json` (plus `workspace` and `promptSha`) into the run folder, and `run.json.promptSha` is the full sha256 of the analyzer prompt without the harness note (its first 12 characters are the old `prompt` hash), so reps compare even though each note names its own run folder.
- `checkProposal.ts`: `check.ts`.
- `assemble.ts`: `assemble-proposals.py`.
- `grade.ts`: `grade.py`, with the same sets, bands and pools. The workspace comes from `freeze.meta.workspace`, not the path. The pool is `labels/org-review/<ws>/handle-pool.json` (every role handle any old round proposed or any old served roster held, which grade.py globbed and the old rounds no longer carry here), every snapshot's roster for the workspace, and every role an org-review run since proposed. Check scores: records, sessions and roles_named are grade/3; coverage is the share of projects with work that has a lead after; repeats is 1 when nothing repeats; summary_words has no band in grade.py, so it is shown at weight 0.
- `present.ts`: `capture.sh`, `capture-raw.ts` and `chart-fit.ts`, same behaviour. It needs `localhost:3200` and the founder's Chrome, and refuses with one line when either is missing. One implementation over the raw bridge covers all three scripts (capture.sh's CLI attach stalls under load), and the saved tree is the snapshot's own `org-ls.json` (the page's tree is what `cast org ls --json` answers; the old loop's `raw/org-tree.json` was that same read, taken days before base8). The run's snapshot is the one its `hashes.json` names, by `served` and `workspace`. Capture uses this session's existing Cast tab on `localhost:3200/org` and never opens one. There is no ReplayCtx at capture time, so the presentation grading run calls `runAgent` (what `ctx.agent` wraps) on `JUDGE_MODEL` with `--tools Read` and max-turns 10. It reads the rubric from `docs/architecture/org-eval.md` "Presentation rubric" at run time, so the rubric has one home, and writes `presentation:<line>` checks at weight 0: capture grades only the reps a person picks, so a weighted line would put those reps on another basis than the rest of their run set (U17).

Data migration, copy only (`~/.cache/org-eval` stays untouched):
- `{union,codecast}/{grade-sets.json, ground-truth.md, sample30-labels.*, extra-labels.json, final-fixes.md}` go to `EVALS_HOME/labels/org-review/<ws>/`, followed by a git commit in the labels repo.
- `union/served/base8` and codecast's latest full-round base, `served/base3`, go to `EVALS_HOME/snapshots/org-review/<ws>-<name>/`, bytes as they were, with `reads/<key>.out` for the three legacy reads, `frozen` (`org`), and `captured.json` (with `workspace`), all 444, written with `writeServedRead`, `writeFrozenVerbs` and `lockSnapshot` as `./evals snapshot` writes them.
- `migrate.ts` does both and commits and pushes the labels repo; it never overwrites.
- Grading and capture refuse a dir inside `~/.cache/org-eval` (`refuseArchive`): both write into the dir they are given, so an old round is graded as a copy.
- Create the private freezes `org-review@union-base8` and `org-review@codecast-base3`, with `meta.workspace`.

`grade.test.ts`, which reads `~/.cache/org-eval` and skips when it is absent (so CI skips it):
- copy `union/round-36/s{1,2,3}` to `/tmp`, without their `grade-auto.json` (and, for the TS copy, `proposal.json`, so the port assembles it)
- run `python3 ~/.cache/org-eval/bin/grade.py` on the copies. grade.py takes its workspace from the run dir's path under `~/.cache/org-eval` and writes `grade-auto.json` into the run dir, so it runs with `HOME` at a scratch dir whose `.cache/org-eval/union/` links to the real labels, served dirs and rounds (its pool) and holds the copies; nothing in the archive is written
- run `migrate.ts` and `./evals freeze create org-review@union-base8` into a scratch `EVALS_HOME`, then `./evals grade org-review <copy> --freeze <id>`
- every field must be equal
- `round-35/s{1,2,3}` must fail `no-wrong-close`, with ct-49328 in the evidence

Acceptance: the regrade matches exactly, and round 35 fails the gate.

**U15: role-wake, anchor-brief** (ct-55702)

Steps:
- Snapshots use `./evals snapshot role-wake --trigger tr-N --team T --role <handle>`. `--role` is needed because a role's own `cast brief` is captured as `cast brief @<handle>`: a bare read from the role's session would move its brief clock in prod. `meta.servedAliases` serves that capture under the bare argv the role types.
- The frame is prod's inject frame (`agentTasks:injectFrame`, read at `freeze create` within an hour of the snapshot), not `buildTriggerFrame`, which frames spawned runs only. The pure part of `agentTasks.triggerFrameFor` moved into `triggerRunFrame` (`shared/contracts/triggerLifecycle.ts`) so prod and the fixtures render one way. The harness note asks for the brief as it should stand, written to `brief.md` in the current directory.
- anchor-brief takes the production opening from `/cli/read` at the line the ref names (default 1), and prod's answer up to the next typed message as the production reply.
- The `fixture:` freezes render `bootstrapMessage` (anchors.ts, which calls `roleOpeningMessage` when the facts name a role) over synthetic facts; role-wake fixtures render `triggerRunFrame` over a synthetic role card and the tree's routine prompts.
- Every fixture of both surfaces reads one shared synthetic world, `fixtures/role-wake/worlds/<name>.json`, named by the snapshot's `world`. A fixture adds only its seat: `values` (as `./evals snapshot` takes them as flags) fill `meta.servedAliases`, so `role: docs` serves the world's `brief @docs` as the bare `brief`, and `reads` of its own win over the world's for the same argv (the workspace agent's bare `cast brief` fails, as it does in prod, because that session speaks for no role). A fixture's world is closed: its served dir's `frozen` is `*`, so any read the world does not hold fails `frozen-reads` with its argv named and never reaches the live workspace. The harness note is generated from that same `frozen` list, so it tells the agent which reads come from a record.
- Two fixture freezes each, one real freeze each, plus a 3-rep smoke on the real ones.
- A fixture's `label` can hold a turn to one mechanical property, read by `standingGates` (`roleWake/actions.ts`) from what the turn wrote or named: a write the guard refused (`REFUSED` in `calls.log`), or a command the harness note asked it to name in a code span of its message instead of running. `pause: {handle, own}` gates `pause-scope` (it pauses its own role or each of its own triggers, and writes no other trigger or role); `dmOnly: [handle]` gates `private-routing` (every message goes by direct message to those people, and one does); `placeholders: {answer, pass}` gates `pass-or-answer` (each ask's placeholder answered, each aside passed or left; a turn that names no command for its placeholder is read from its last message, the one the harness note asks it to end on); `rereads: [session]` gates `reread-before-status` (each of those sessions the brief or reply names was read with `cast read`). An anchor-brief fixture with turns is graded from its first turn after the opening, so the opening's own hello never counts.
- The first message both surfaces send is the production text followed by the harness note (`withHarnessNote`, `roleWake/world.ts`), and `describe` returns that same text, so the judge sees what the agent was shown: a command the agent names in place of running it is the instruction followed, not a failure to act.
- A world read may carry `prefix: true`: the served dir gets a `reads/<key>.prefix` marker, and the guard answers any longer argv with no capture of its own from it (`cast read <id> --full` or `--ask "…"` gets the transcript the world holds). It is an approximation for synthetic worlds only; captured snapshots never write the marker.
- The guard treats `cast decide show|ls` as reads (the needs-input frame tells a role to run `cast decide show`); any other `cast decide` still posts and is refused. A `--help` before any `--` is never frozen or refused: the guard runs the real CLI with only the leading command words (lowercase words up to the first flag or other text) and one standalone `--help` of its own, under a state directory of its own (`$RUN_DIR/.cast-help`) with auto update off, and logs `HELP <argv>`. Commander reads a `--help` that follows an option needing a value as that value, and one after `--` as an operand, so passing the agent's argv through would run the action (`task create T -d --help` creates a task); the rebuilt argv cannot, and the empty state directory means no help call can sign in or reach anyone. A `--help` after `--` is not help, and the argv is classified as usual.

Acceptance:
- smoke runs complete with `frozen-reads` passing
- deliberately deleting one `reads/*.out` makes `frozen-reads` fail with the argv named

### Wave 4

**U16: Docs and snippet**

Files: `AGENTS.md` (through `./evals snippet install`), new `docs/architecture/evals.md`, and `docs/architecture/org-eval.md`.

- Add the prompt dry run paragraph to `AGENTS.md`: `--model` is required, and `--call` and `--max-output-tokens` exist.
- `evals.md` covers the data homes, the ref grammar, gates vs checks, the separation rule, cadence, and the privacy rules.
- `org-eval.md` keeps its rubric. Its `~/.cache/org-eval` pointers become `./evals` and `EVALS_HOME`.

Acceptance:
- `./evals snippet status` reports installed
- `CLAUDE.md` is still a symlink (`test -L CLAUDE.md`)

As built (2026-10-01):
- The prompt dry run paragraph is the existing "Prompt dry runs" section of `AGENTS.md`, rewritten in place: `--model` required (exit 2 without it), `--call` with `--system`, `--max-output-tokens`, `args.json`, the served reads and the `calls.log` marks, and a pointer to `./evals`.
- `src/snippet.ts` stamps codecast's reference alone. The platform body is written for eaiden (`freeze create <messageId>`, iMessage channels, `sim`), and Phase 1 makes no upstream edits, so codecast does not stamp it: `REPO_NOTES` is the whole section, stating what holds here (a conversation is a session, a ref always names its surface, the loop runs through `check`) with a pointer to `evals.md`.
- `evals.md`'s cadence section follows 2.9 and the armed tr-1245 and tr-1246: budgets 8 and 5, `--max-runtime 120m`, `--notes nightly` and the drift rule, the background check with a foreground poll, and `--needs-attention` only for the cases 2.9 names.
- `org-eval.md`'s loop now runs through `snapshot`, `freeze create`, `check`, `capture` and `grade`, its ground truth lives in `EVALS_HOME/labels/org-review/<workspace>/`, and its "three samples" became the separation rule's 8. The rubric sections are unchanged, because `present.ts` reads "## Presentation rubric" at run time.

**U17: Org refresh** (ct-55703, operational, no repo files)

Steps:
1. `./evals snapshot org-review --team <union> --name union-base9` and the same for codecast (`codecast-base9`; snapshot names carry the workspace, and one name cannot hold two).
2. Hand-label every flagged record that is new since base8 into the private labels, following org-eval.md "Ground truth, built by reading", and commit in the labels repo.
3. Run 8 samples each on base8 and base9 at `AGENT_MODEL` for the new baseline.
4. Run presentation capture and grading on the best and the worst sample, attended.

Acceptance:
- every flagged record in base9 is in exactly one label set, or in `either`
- the baselines are recorded
- `no-wrong-close` passes, or the failure is filed on ct-55703

As built (2026-10-02):
- Step 1 names each snapshot `<workspace>-base9` (`union-base9`, `codecast-base9`): snapshot names carry the workspace, and one name cannot hold two.
- Union could not be captured at first: `cast org inputs --team Union` hit Convex's 100 MB read limit, because the analysis `org` slice called `roleActivity` once per role and each scoped role's `computeScopeFeed` ran `sessionsInScope` with no scan, repeating the whole 30-day session scan once per role. Fixed under ct-56046: `computeScopeFeed` and `roleActivity` take the caller's scan and the slice passes its own (`org.ts`, `orgHealth.ts`, `orgInit.ts`; regression test in `orgHealth.test.ts`). The read answers since, and union-base9 was captured 2026-10-02 03:18Z (freeze `e08df329`).
- Codecast's base8 is `codecast-base3`, its newest full-round base. The baselines are 8 reps each on `claude-sonnet-5-5`, read from each rep's stored `score.json`, and every stored score equals a mechanical regrade of the same rep on the labels as they stand:

  | freeze | batch | pass | mean | range | cost | failed gates |
  |---|---|---|---|---|---|---|
  | union-base8 `0bc4cd18` | 2026-10-02T06:33Z | 7/8 | 0.728 | 0.00-0.87 | $14.06 | seed1 no-wrong-close |
  | union-base9 `e08df329` | 2026-10-02T04:15Z | 2/8 | 0.350 | 0.00-0.71 | $19.36 | seeds 2, 5, 7 and 8 no-wrong-close |
  | codecast-base3 `0d6aa8ea` | 2026-10-01T21:02Z | 6/8 | 0.658 | 0.00-0.87 | $34.95 | seed4 no-wrong-close |
  | codecast-base9 `b4c3120d` | 2026-10-01T21:02Z | 5/8 | 0.594 | 0.00-0.93 | $31.70 | seeds 1 and 5 no-wrong-close |

  Which records each failing seed closed is in the private labels repo, beside the ground truth.

  An earlier union-base8 batch (2026-10-01T21:02Z, stored 6/8, mean 0.625) is superseded: its seed3 was zeroed by the guard bug below (a `REFUSED` invented subcommand, `cast org roles`), which is why union-base8 was rerun in full. union-base9's seed7 also hit a guard bug (59 `REFUSED` lines for `cast pl show` and `cast ct show`, commands that do not exist) and failed `no-unexpected-writes`; it scores 0 either way, because it also fails `no-wrong-close`.
- `no-wrong-close` fails in 8 of 32 reps, filed on ct-55703. Two of union-base9's reps close the record the plan's gate names, so the gate catches a real regression on the newer snapshot. The labels those failures rest on were read again on 2026-10-02 and still hold; the reading is in the private ground truth.
- Labels: every flagged record of both base9 snapshots sits in exactly one of `must_not_close`, `should_close`, `found_by_a_run` and `either`, checked mechanically (0 violations, 0 overlaps between the four). codecast-base9 flags 133 records: 85 were in no set and were read on their pages (51 should_close, 2 must_not_close, 32 either; labels repo 6f85a61). union-base9 flags 59: 32 were in no set and were read on their pages and against the workspace's own repository (13 should_close, 2 must_not_close, 17 either; `labels/org-review/union/base9-labels.json`, ground-truth section 5e, labels repo e5b7b55). The grader reads `found_by_a_run` as should_close (and reachable even when unflagged), so the 38 records that sat in both lists left `should_close`; two records sat in `found_by_a_run` and `either`, and a later read settled them as should close. None of this changes a grade: the grader never reads `either`, and the union of the two should-close lists is unchanged.
- The guard's read list missed reads the analyzer makes, and each miss zeroed a rep through `no-unexpected-writes`: `pr ls|show|events|threads`, `chat read|thread|channels|ls|search` and `trigger log|history` are now reads. A command the CLI does not have is not a write either, whether an invented subcommand under a pure command group (`cast org roles`, `cast task comments`) or an invented top-level command (`cast pl show`, `cast ct show`; the root answers any word it lacks with "unknown command" too). The guard resolves the leading words against the CLI's own tree, `cast agent-context --json`, read once per run under the help state directory. Each command there carries `runsBare`: true when it has an action of its own or a default subcommand, so a word it has no subcommand for still runs something (`cast sync <word>` uploads conversations, `cast hosts <word>` lists through its default `ls`). Only when the words leave the tree at the root or at a group whose `runsBare` is false does the guard print commander's `error: unknown command '<word>'`, exit 1 and log `UNKNOWN`; it never hands those words to the real CLI. Anything else stays `REFUSED`, and so does everything when jq is missing or the tree comes from a CLI without `runsBare`. A usage line cannot carry this, because `cast sync [options] [command]` reads the same as a pure group's.
- Presentation checks are written at weight 0 (U14). Capture grades only the reps a person picks, and a weighted line moved codecast-base9 seed6 from 0.933 to 0.722, a basis its seven siblings did not share. The two captured reps were re-merged at weight 0. The capture and grading ran attended on codecast-base9's best rep (seed6) and worst rep (seed5). Both read 2,2,1,2,1,2,2 on the rubric; the weakest lines are 3 (one word for one thing) and 5 (a static capture cannot show the conversation).
- A run spends a fixed setup token when `CODECAST_EVALS_ACCOUNT=<profile>` is set (`adapters/dryRun.ts` passes `--account`). On the machine login, two 7-minute reps died together on "OAuth token revoked" when another session refreshed the keychain token, so every baseline rep ran on a saved profile's setup token.
- Presentation capture hides the product's tour layer and Tours panel (`[data-tour-open]`, `[data-tours-panel]`) for the capture only: on `?preview=1` a tour is never recorded as seen, so one started on every navigation and the judge graded the overlay.
- Repo files touched despite "no repo files": the ct-56046 fix and its test (convex), the guard and its test (`prompt-dry-run-bin/cast`, `prompt-dry-run.guard.test.ts`), `adapters/dryRun.ts` (`--account`), and `orgReview/present.ts` with `grade.test.ts`.

**U18: Cadence and publishing** (ct-55704)

Steps:
1. Arm triggers A and B (2.9).
2. `cast trigger run` each once: with nothing stale, confirm a precheck skip. Then touch a declared source in a scratch commit on a worktree, not main, or simply commit U16's docs if they are declared, and confirm a run, a published URL and a correct summary.
3. Open the published page in a `cast browser` tab and read it before linking it anywhere.

Acceptance:
- both triggers show in `cast trigger ls`
- one skip and one run are in `cast trigger log`
- the page is email-gated: `cast publish ls` marks it (✉, `email_gate: true` in `--json`; `cast publish links` lists URLs only) and an anonymous request gets the "Enter your email to view" page

As built (2026-10-01):
- tr-1245 (A) and tr-1246 (B) are armed as in 2.9, under the plan's session jx70x2y. The budgets, runtime and prompts differ from the first draft for the measured reasons given there.
- `cast trigger run` is a manual firing, and a manual firing never runs the precheck. A's skip came from its first recurring firing (armed `--in 25m`): `./evals stale` exited 1 and the log reads `skipped … precheck exited 1`. A's manual run named org-review for a manual run once, recorded `lastNotifiedHash`, and published nothing, because nothing ran.
- The run that publishes is B's manual run. While the Phase 1 tree is uncommitted, every surface's own directory is untracked and so dirty, and `check --stale` skips them all; a scratch commit on a worktree would not move the main checkout's HEAD, which is where the triggers run.
- `cast trigger add` ignored `--in` beside `--every`; it now sets the first run, which anchors the daily grid at 03:00.
- `stale` stopped counting stale call surfaces whose sources are dirty (`staleness().due` and `.waiting`, shared with `check --stale`), so the precheck passes only when `check --stale` has something to do.

### Wave 5: validation (the reviewers the user asked for)

These run as independent subagents, each read-only on the others' work:
1. **Prod byte-identity.** Diff every convex request before and after, using the goldens and a re-derivation from `git show HEAD~:<file>`.
2. **Privacy audit.** Check every committed file under `packages/evals` and the goldens for real ids, names or content, beyond what the guard test catches. In particular, the goldens must use synthetic fixtures.
3. **Harness adversarial pass.** Look for guard escapes (a write verb that passes as a read), key mismatches, and `--call` hidden context.
4. **Operator walkthrough.** A fresh agent with only `AGENTS.md` creates a freeze, replays it, and reads the results. Any dead end becomes a fix.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `claude -p` cannot set temperature, so call-surface reps vary differently from prod (prod uses 0 for title, settle, ask and handoff) | The request bytes, model and max_tokens are identical to prod. The temperature gap is recorded per run. Reps are 5, with the separation rule. The API backend is a later swap of `ctx.call` (founder decision 2). |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` might be ignored or floored | The `prod-budget` gate reads `usage.output_tokens` and `stop_reason` either way. The U3 smoke records which case holds. |
| `--call` could carry hidden Claude Code context | The U3 input-token overhead check; a private config dir; no tools; `--setting-sources project` in an empty run dir. |
| Vendoring disturbs the drifted mirror | The overlay `PLATFORM_SRC` vendors evals only; acceptance requires `git status platform/` to show nothing else. |
| A new workspace package without `bun.lock` breaks Railway | U1 acceptance, and a note for whoever commits. |
| Prod refactors in U5-U8 change behaviour | Goldens are written before the refactor, byte-identity is asserted, and the wave 5 reviewer re-derives from HEAD. The deploy goes through `deploy.sh` before any push. |
| A committed file leaks private content (the repo is public) | Only synthetic content is committed, `freezes.guard.test.ts` runs in CI (allowlist, secrets, Convex-id pattern), the wave 5 privacy audit, and the resolver sets `private` for every non-fixture ref. |
| `/cli/read` rows differ from the DB rows the selectors expect | `toRows()` has a fixture test, and each selector is also fed DB-shaped fixtures in the convex tests. Where fields cannot be mapped, the surface records `snapshot-approximate` in meta and says so in `status`. |
| Agent replays read a partly live world | The cassette, `frozenVerbs`, the `frozen-reads` gate, and `LIVE` reads logged and reported. Role and anchor freezes are "now" captures, so the served reads and the frame share a moment. |
| Guard edits corrupt a live dry run | `pgrep` precondition in U3, and the guard lands before any trigger is armed. |
| An unattended trigger burns the subscription window | Upfront estimate and refusal, mid-run budget stop, crash-streak blocking, agent surfaces never unattended, and a HEAD-based precheck so half-saved edits never fire it. |
| `EVALS_HOME` is machine-local; labels could be lost, and cloud hosts lack it | `labels/` is a git repo pushed to a private GitHub remote after every write, so a lost laptop loses nothing and a cloud host can clone it. `doctor` reports missing snapshots and labels per freeze, and `check` skips them with one line instead of crashing. Agent surfaces are laptop-only in Phase 1 (keychain), or use `--account`. |
| The TS grade port drifts from `grade.py` | U14's exact regrade test on round 36, plus the round-35 negative case. |
| The CI files are being edited by Phase 0 | The U9 precondition hands the lines to the Phase 0 owner instead of editing concurrently. |
| The suggest provider in prod may be openai (`SUGGESTIONS_PROVIDER`) | The eval pins and records the anthropic branch. `status` notes that the openai branch is not evaluated in Phase 1. |
| Hand-written judge criteria could describe private content | Only synthetic freezes are committed, so real criteria never reach git. |

---

## 6. Decisions that need the founder

Item 2 is advisory: work proceeds on the default, which reverses cheaply.

1. **Decided (sd-319): private remote.** Real labels, including codecast's own id-only grade sets, live in `EVALS_HOME/labels`, a git repo pushed to the private GitHub repo `ashot/codecast-eval-labels` after every write. Nothing real enters the public repo.
2. **Call-surface fidelity.** The default follows pl-810: `claude -p --call`, with every knob except temperature matched. The alternative is an API backend with a dedicated eval key (not the prod key), used only by `ctx.call`. That buys exact temperature fidelity and costs a key on the laptop.

---

## 7. Facts that changed since the survey, and subtask mapping

- `~/src/platform/packages/evals` now has 3 files changed, +24/-3, not ~522 lines. U1 vendors from HEAD regardless.
- The mirror's auth and cli-kit contain files that platform HEAD lacks, for example `auth/src/web/authPrincipal.ts` and `cli-kit/src/update/signing.ts`. A full vendor from either source would break codecast, which is why U1 uses the overlay.
- There are 8 Haiku literals in 7 files: titleGeneration 106 and 177, sessionInsights 543, transcripts 1128, idleSummary 334, agentTasks 2624, composerSuggestions 733, storyMode 16.
- `out.json` carries `stop_reason`, `usage.output_tokens` and `modelUsage`, which is what makes the `prod-budget` and `model-as-pinned` gates buildable.
- `cliHttp.ts` has no imports, so it is safe to import directly.
- The union grade sets list ct-49328 under `must_not_close`.

**Subtask mapping:**

| Subtask | Units |
|---|---|
| ct-55698 | U1, U4 |
| ct-55700 | U3 |
| ct-55701 | U10, U11 (with U5, U7) |
| ct-55702 | U12, U13, U15 (with U6, U8) |
| ct-55699 | U14 |
| ct-55703 | U14 presentation, U17 |
| ct-55704 | U18 |

U2, U9, U16 and wave 5 are shared infrastructure.