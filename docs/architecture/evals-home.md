# Phase 1 implementation spec: one eval home on @platform/evals (ct-55687, pl-810)

This spec was written read-only. It starts from the operator design (Design 2), which scored best. It adds Design 0's data split and its prompt-dry-run-only route, and Design 1's request builders and cassette guard. It avoids every fatal flaw the judges named. I re-checked every fact it depends on against the tree on 2026-09-30, and section 10 lists what changed since the survey.

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Where the home lives | A new workspace package `packages/evals` (`@codecast/evals`, private), run by a root launcher `./evals`. It is never mounted under `cast`. |
| Replay route | Every model call goes through `packages/cli/scripts/prompt-dry-run.ts`, as pl-810's rule requires. It gains a `--call` mode for single-call surfaces. The shared request builders make the prompt bytes identical to prod. `--max-output-tokens` plus the `prod-budget` and `model-as-pinned` gates recover most of the fidelity `claude -p` loses. Temperature is the one gap left, and it is recorded on every run. No prod API key is ever needed. |
| How a freeze picks its surface | A `<surface>@<ref>` prefix on the ref. `FreezeResolver.resolve` only ever sees `{messageRef, runRef}`, and tags are applied after it returns (`platform/.../cli/freeze.ts:56-57`). |
| One concept for cases | Every case is a freeze. Settle's 17 synthetic cases, org snapshots and real moments are all freezes. The `sim` seam stays unset. |
| What goes in git (the repo is PUBLIC) | Surface code, synthetic fixtures (with their labels inside), and freeze pointers for synthetic fixtures only. Every real freeze, snapshot, run, label and ground-truth file lives in `EVALS_HOME`. Codecast's own grade sets are kept private too. That is founder decision 1, with this as the default. |
| `EVALS_HOME` | `${CODECAST_EVALS_HOME:-~/.local/share/codecast/evals}`. This is a data dir, not a cache, because hand labels are precious. `labels/` is a local git repo. |
| Reads for freezes | Access-checked only. Session reads use `cliFetchRead` on `/cli/read` plus `readLocalConfig`, imported directly with no new `--json` flags. The inbox uses `cast sessions --json`, calls use `cast call <id> --json`, and triggers use `cast trigger show <tr> --json`. No `run.sh`, no system-table reader, no `npx convex run`. The one new server read is a self-only `/cli/suggestion-profile` route. |
| Agent replays | Reads are served from a cassette keyed by an argv hash, with UNSERVED logging and a `frozen-reads` gate. There is no generic `<w1>.txt` fallback. `cast org review` without `--spawn` becomes a permitted read. |
| Precheck | `./evals stale` hashes the declared sources at HEAD with `git rev-parse HEAD:<path>` and never reads the disk. A surface is blocked after 2 crashes on the same hash. `check --stale` skips a surface whose sources are dirty in the checkout. |
| Model pins | Call surfaces use `CHEAP_MODEL`, imported from `convex/lib/anthropic.ts`. `JUDGE_MODEL` and `AGENT_MODEL` are `claude-sonnet-5-5`. The role and anchor surfaces pin the production session's model when the resolver can read it. `prompt-dry-run.ts --model` is required. |
| Vendoring | Only evals is vendored, through a `PLATFORM_SRC` overlay (section 4, U1). The other eight mirrored packages stay byte-identical. The existing drift is out of scope. |
| Samples | Call surfaces run 5 reps. Agent surfaces run 3 as a smoke test and 8 for any comparison. "Better" means a one-sided Mann-Whitney at p ≤ 0.05. A gate is zero tolerance per sample. |
| Cadence | Trigger A: every 2h, with a stale precheck; call surfaces run, agent surfaces get a needs-attention notice. Trigger B: nightly, call surfaces only. Both use `--spawn`, not `--safe`, and `--max-runtime 45m`, with a `--budget` stop. |
| Publishing | `./evals publish` always passes `--email-gate --task ct-55687` and republishes one fixed dir. |
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
2. Every Phase 1 surface has at least 3 freezes. Each has a 5-rep baseline (8 for org-review) recorded under a pinned model with `model-as-pinned` passing.
3. The TS org grader matches `grade.py` on three saved round-36 samples. It fails round-35's samples on `no-wrong-close` (ct-49328).
4. `settle-eval.ts` and `suggest-eval.ts` are deleted. `~/.cache/org-eval` is an untouched archive.
5. Both triggers are armed. Each has been fired once and shown to skip when nothing changed and to run and publish when something did.
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
- `index.ts` builds a commander program named `evals` and calls `registerEvals(program, sources)` and `runEvalsCli`, as eaiden does in `~/src/eaiden/tools/xrun/src/index.ts`.
- The network-backed seams (`convo`, `freezeResolver`, `productionReply`) sit behind eaiden's lazy Proxy (lines 34-41), so `runs` and `freeze list` work with no auth.
- The codecast commands are listed below. Each is one file in `src/commands/`.

| Command | Behaviour |
|---|---|
| `./evals` / `status` | One row per surface: route, pinned model, freezes (public/private/snapshot missing here), last run age, pass rate of the last 5 runs, stale or blocked mark, estimated cost of a default `check`. Ends with the next command. |
| `check [surface…] [--stale] [--route call\|agent] [--freeze id…] [--reps n] [--model id] [--budget usd] [--dry] [--publish]` | Replays every freeze of each chosen surface. It estimates the cost first and refuses when the estimate exceeds `--budget`, and it stops mid-run with `endedBecause:'budget'`. It prints a verdict table per surface against that surface's previous run set: pass rate, mean score, min to max, flips, cost, model. It adds `separated` or `not separated` (see 2.8) and ends with `runs diff` / `freeze results` hints. Exit 1 on any gate failure or a separated regression. With `--stale`, the list comes from `stale`; an empty list prints "nothing changed" and exits 0. A surface whose sources are dirty in the checkout is skipped with one line. |
| `stale [--route r] [--list]` | The precheck. Exit 0 when some surface is stale, exit 1 otherwise. No imports beyond `registry.ts` and `state.ts`. Uses git only. Well under 1 s. |
| `snapshot <surface> <args>` | Captures the served world for an agent surface into `EVALS_HOME/snapshots/…` and makes it read-only. Replaces `snapshot.sh`. |
| `grade <surface> <dir>` | Grades an existing output dir with the surface's gates and checks. Used for regrading old org rounds. |
| `capture <surface> <runDir>` | Presentation capture, attended only. org-review is the only surface in Phase 1. |
| `doctor [--init]` | Uses `@platform/cli-kit` doctor, as eaiden's `commands/doctor.ts` does. Checks: the mirror resolves; cast auth (`readLocalConfig` has an api_token); `claude` on PATH; the keychain login, or a note that `--account` is needed on Linux; `EVALS_HOME` exists and `labels/` is a git repo (`--init` creates both); snapshot and label presence per freeze; that `prompt-dry-run.ts` without `--model` exits 2; that `models.ts` pins equal the prod constants; snippet status. |
| `snippet install\|show\|status\|remove` | Copies eaiden's `src/snippet.ts`. It calls `installSectionToFile` from `@platform/snippets` against `AGENTS.md` (the real file, not the `CLAUDE.md` symlink), with `evalsSnippet({name: 'evals', repoNotes})`. The name is `evals`, not `./evals`, because the snippet already prepends `./`. |
| `publish [--since 24h]` | Writes `EVALS_HOME/html/site/{index.html, report.html, matrix.html}` through the platform's `runs report` and `runs matrix --html` renderers. Then runs `cast publish EVALS_HOME/html/site --email-gate --task ct-55687 --title "Codecast evals"`. There is no ungated path. |

### 2.2 Vocabulary

- **Surface.** One production prompt with one call site. Each surface is a directory `src/surfaces/<id>/` that holds:
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
  maxTokens?: number;                // call route: prod max_tokens
  prodTemperature?: number | 'api-default';
  sources: string[];                 // repo paths hashed by `stale` (always add this surface's dir and packages/cli/scripts/prompt-dry-run.ts)
  reps: { check: number; smoke?: number };
  maxUsdPerRep: number;              // fallback cost estimate before any real run
  frozenReads?: string[][];          // agent route: argv templates captured by `snapshot`, e.g. [['brief'], ['org','inputs','--team','{team}','--json']]
  frozenVerbs?: string[];            // agent route: first words (or "w1 w2") that must be served, never live
}
```

The `index.ts` interface:

```ts
export interface SurfaceImpl {
  refForms: string;                                             // one line for the UsageError
  capture(ref: string, ctx: CaptureCtx): Promise<Captured>;     // snapshot + subject + asOf + anchor + visibility
  replay(snap: any, ctx: ReplayCtx): Promise<ReplayOutput>;     // uses ctx.call(req) and/or ctx.agent(opts); may call more than once (ask)
  gates(snap: any, out: ReplayOutput, label?: any): GateResult[];
  checks?(snap: any, out: ReplayOutput, label?: any): CheckResult[];
  describe(snap: any): ConvoMessage[];                          // what the judge and convo views show
  productionReply?(snap: any): ProductionReply | null;
  grade?(dir: string, label: any): Score;                       // org only in Phase 1
  capturePresentation?(runDir: string): Promise<void>;          // org only
}
```

`ReplayCtx` works like this:

- `call(req: SurfaceRequest, opts?)` returns `{text, outputTokens, stopReason, modelUsage, costUsd, isError}`.
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
- a `judge` longer than 1000 characters, or any other string longer than 300 characters

Snapshots of real moments pass through `redactSecrets` (`secretRedaction.ts:143`) before they are written. They are content-addressed: sha256 of the canonical JSON, file named by the first 12 hex characters. A replay recomputes the hash and fails gate `snapshot` on a mismatch.

### 2.4 Freeze creation

The ref grammar is `<surface>@<ref>`. The resolver splits on the first `@`. An unknown or missing surface raises a one-line `UsageError` that lists every surface's `refForms`, for example: `title@ needs a session and line, like title@jx7c6zk:142`. `--run` is refused with a pointer to the prefix form.

| Ref form | Surfaces | asOf |
|---|---|---|
| `fixture:<case>` | all | fixture's `asOf` |
| `<session7>:<line>`, `<messageId>`, share URL with `#msg-` | title, insight, settle, suggest, ask, handoff | that message's timestamp |
| `<callId>` | call-summary | call end |
| `<trigger tr-N>` | role-wake (the "now" form: frame built with `now = capture time`, reads captured now) | capture time |
| `<session7>` | anchor-brief (the standing session's first user message is the production opening; reads captured now) | capture time |
| `<snapshotName>` | org-review (for example `union-base8`, a dir already in `EVALS_HOME/snapshots/org-review/`) | snapshot's `captured_at` |

**ConvoSource** (`adapters/convo.ts`):
- `inbox` spawns `cast sessions --json`.
- `load` and `message`: when the subject has a freeze snapshot, they return the snapshot's messages. Otherwise they page `/cli/read` via `cliFetchRead(`${siteUrl}/cli/read`, …)` with `{api_token, conversation_id, start_line, end_line, full_content: true}`. `siteUrl` and `api_token` come from `readLocalConfig()` (`packages/cli/src/config/readLocalConfig.ts`).
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
- `run.json` records `temperatureProd` and `temperatureReplay: 'cli-default'`. That gap is the known fidelity limit (founder decision 2).

**Agent route** (org-review, role-wake, anchor-brief). `ctx.agent` runs:
```
prompt-dry-run.ts --run <runDir>/agent --prompt prompt.md --model <pin> --serve <snapshotDir> [--max-turns N] [--tools …] [--then …]
```
Then `layout.ts` folds its outputs into the platform layout:
- `said.txt` becomes `sends.json` and `send_captured` events.
- Each `calls.log` line becomes a `cast_call` event.
- `out.json` cost and turns go to `result.json`.
- `err.txt` goes to `run.log`, so the platform's crash view shows the last 12 lines.

Gates:
- `model-as-pinned`
- `ok`
- `frozen-reads`: no `UNSERVED` line in `calls.log`. The evidence names the argv and the fix: "add it to meta.frozenReads and re-run `./evals snapshot`".
- `no-unexpected-writes`: no `REFUSED` line except the patterns the surface's harness note allows.

**Replayer** (`adapters/replay.ts`). For each rep, capped at 25:
1. Load the snapshot and check its hash.
2. Run `surface.replay`.
3. Run the gates and checks.
4. Run the judge when `freeze.judge` is set.
5. Write the run folder through `layout.ts`. It writes the same files and field names as the platform's `writeFixtureRun` (`platform/packages/evals/src/fixture.ts`): `result.json` (`endedBecause`, `costUsd`, elapsed from `took.txt`), `events.jsonl`, `sends.json`, `captures.json` (the request and raw reply), `score.json`, and `run.json`. `run.json` holds `{freezeId, notes, model, route, sourceHash, promptSha, judgeModel, budgetUsd, gitHead, dirty, temperatureProd, temperatureReplay}`.

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
2. Keep the three existing org cases (`org inputs|health|ls` from `org-inputs.json`, `org-health.json`, `org-ls.json`) and `org proposals`. Old `served/` dirs keep working unchanged.
3. When `SERVE` is set: compute `key = sha256` of the bytes of each argument followed by `\x1f` (`printf '%s\x1f' "$@" | shasum -a 256`, with `sha256sum` as the fallback). If `$SERVE/reads/$key.out` exists, print it, log `SERVED <argv>`, and exit with the contents of `$SERVE/reads/$key.exit`, or 0 when that file is missing.
4. When `SERVE` is set and `$SERVE/frozen` lists `$1` or `"$1 $2"`, refuse with `dry run: 'cast <argv>' is frozen for this replay and was not captured`, log `UNSERVED <argv>`, and exit 1.
5. The existing live read dispatch. Add `review` to the org read verbs only when no argument is `--spawn`. `cast org review` without `--spawn` prints the review prompt (`orgInit.ts:102`).
6. Every existing refusal also logs `REFUSED <argv>`.

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

**`state.json` per surface:** `lastRunHash`, `lastNotifiedHash`, `crash {hash, count}`, `lastCostPerRep`.

**`stale` rules:**
- `hash = sha256(join(git rev-parse HEAD:<p> for p in meta.sources))`.
- A call surface is stale when `hash ≠ lastRunHash`.
- An agent surface is stale when `hash ∉ {lastRunHash, lastNotifiedHash}`.
- It is blocked, and not counted as stale, when `crash.hash === hash && crash.count >= 2`.

**Trigger A**, "Evals: prompts changed":
```
cast trigger add - --every 2h --spawn --max-runtime 45m --precheck './evals stale' --title "Evals: prompts changed"
```
The prompt tells the run to:
1. Run `./evals check --stale --budget 3 --publish`.
2. For each agent surface the output names as "manual run needed", run nothing. `check` has already set `lastNotifiedHash`.
3. Complete with `cast trigger complete <id> --summary "<table + URL>"`. Add `--needs-attention` only on a gate failure, a separated regression, or a manual-run notice.

**Trigger B**, "Evals: nightly drift":
```
cast trigger add - --in <hours until 03:00> --every 24h --spawn --max-runtime 45m
```
It runs `./evals check --route call --reps 3 --budget 5 --publish`. Drift means a surface's pass rate falls outside its trailing 7-night min to max, computed from `runs history`.

Agent surfaces never run unattended. Presentation capture is attended only.

---

## 3. Surfaces

The table has one row per surface. The route, model and max_tokens (m_t) come first, then the ref and snapshot, the gates beyond the route gates, and the default judge criteria. The call-summary max_tokens is read from the code during U6; it is not repeated here.

| id | Route / model / m_t | Ref and snapshot | Gates beyond the route gates | Default judge criteria |
|---|---|---|---|---|
| settle | call / CHEAP_MODEL / as prod (`idleSummary.ts:333-337`) | fixture or session line. The snapshot is the `shapeSettleTail` input rows. | `parse`: `parseSettleReply` is non-null. `label-match`: the parsed state equals the label. | none (labels decide) |
| title | call / CHEAP_MODEL / 400 (title), short-title as prod | session line. The snapshot is the rows `selectTitleInput` reads, cut at `asOf`, plus `currentTitle` only if it was LLM-set before `asOf`. | `parse`: `extractTitleJson`. `clean`: `cleanShortTitle` is non-empty. `no-refusal`: `isRefusalProse` is false. | "names what the session is actually doing at this point, specific enough to find it later" |
| insight | call / CHEAP_MODEL / 1200, prod temp api-default | session line. The snapshot is `selectInsightContext` input (first 8 + last 10). | `parse`: the fields the prompt asks for parse with prod's parser. | "goal, blockers and next action are supported by the transcript" |
| call-summary | call / CHEAP_MODEL / as prod, prod temp api-default | callId. The snapshot is `cast call <id> --json` segments and kind. | `skip-honored`: under 40 words means no call is made and the replay is an empty pass. `tail-rule`: sources over 60k characters keep the tail. `parse` as prod. | "action items are real commitments from the transcript, with owners where stated" |
| ask | call ×2 / CHEAP_MODEL / 200 then 1500 with `ASK_SYSTEM_PROMPT` | session line (the question and its context). The snapshot is `selectAskContext` input. | `parse`: `parseTermsReply`. `citations-real`: every citation is in `citationTargets`. | "answers the question from the sessions, says so when it cannot" |
| handoff | call / CHEAP_MODEL / 1200 | session line. The snapshot is the `shapeHandoffTranscript` input. | `non-empty`, `no-refusal` | "a cold reader can continue: decisions, state, next steps" |
| suggest | call / CHEAP_MODEL (anthropic provider pinned) / as prod | session line where the next user turn is typed. The snapshot is the context rows, the profile (self-only route), and `truth` (the real next message, excluded from the prompt, as `scrubTruth` does today). | `pipeline-ok`: no `provider_failed` or `invalid_json`. | Checks, not criteria: hit / partial / miss / silent / nudge graded as in `suggest-eval.ts`, judged on JUDGE_MODEL. |
| org-review | agent / AGENT_MODEL / max-turns 200 | snapshotName. The served dir holds legacy files, `reads/` and `frozen` (`org`). | `spec-parses` on each `proposals/op-*.json`. `no-wrong-close` (`must_not_close`, which includes ct-49328). `no-never-name`. `no-phantom-handle` (pool = labels plus every snapshot's roster). `frozen-reads`. | Checks ported from `grade.py` with the same numbers: records 3/2/1 at recall 70%/40%, sessions, roles_named, coverage, repeats, summary_words. Presentation checks from `capture`, attended only. |
| role-wake | agent / production session model else AGENT_MODEL / max-turns 80 | `tr-N`. The frame comes from `buildTriggerFrame(trigger, now)`. Frozen reads: `brief`, `org inputs/health/ls --team T --json`, `sessions --json`, `org review --team T`. `frozenVerbs: brief, org, sessions`. | `brief-parses`: the brief the harness note asks for, written to `<runDir>/brief.md`, passes `parseStandingSection`. `no-stale-lines`: `standingLineStale` is false for every line. `frozen-reads`. `no-unexpected-writes`. | "asks a person only what needs them; each line names evidence" |
| anchor-brief | agent / as role-wake | standing session short id. The prompt is the production first user message (replays test agent and model changes). A second freeze kind, `fixture:`, renders `bootstrapMessage` / `roleOpeningMessage` over synthetic facts so builder edits are tested. | `frozen-reads`, `no-unexpected-writes` | "the opening turn orients the role to its scope and does no writes" |

The org-review harness note is `mkrun.ts`'s note. It tells the agent to write `proposals/op-<n>.json` and check it with `bun packages/evals/src/surfaces/orgReview/checkProposal.ts <file>`, the port of `check.ts`. `assemble.ts` merges the proposal files, as `assemble-proposals.py` did, and drops asks.

---

## 4. Work units

Units in the same wave touch disjoint files and can run in parallel in the shared checkout. Before editing, every unit runs `git status --short -- <its files>`. If another session has uncommitted edits in one of its files, it stops and coordinates rather than overwriting. Typecheck with `cast check <name>`, never `tsc`. Run tests per file or per package, never the whole suite. Changes stay in the working tree.

### Wave 1

**U1: Vendor @platform/evals** (ct-55698)

Files:
- `packages/evals/package.json`, final: name, private, `type: module`, deps from 2.1, `scripts.test: "bun test src/"`
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
- `git diff bun.lock` only adds `@codecast/evals` and `@platform/evals` entries, plus `commander` if it is new.
- The commit of `packages/evals/package.json` must include `bun.lock` (Railway frozen lockfile). Note this for whoever commits.

**U2: One home for the Anthropic request body**

Files:
- `packages/convex/convex/lib/anthropic.ts`
- its test: extend `lib/anthropic.test.ts` if it exists, or create it

Changes:
- Export `type SurfaceRequest = {model: string; system?: string; prompt: string; max_tokens: number; temperature?: number}`.
- Export `anthropicBody(req)`. It returns the exact JSON object prod posts: `{model, max_tokens, ...(temperature !== undefined ? {temperature} : {}), ...(system ? {system} : {}), messages: [{role:'user', content: prompt}]}`, with the key order matching today's fetch bodies. Read them first; if the literal bodies differ in key order, keep the order `JSON.stringify` produces today per site by letting each site pass its own order. Byte-identity is the test, not this sketch.
- `callModel` builds its body through `anthropicBody`, and its default temperature of 0 is unchanged.

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
  - `--tools ""` in place of `--allowedTools`
  - `--max-turns 1`
  - `--system-prompt-file <--system file>`, or a one-line neutral system `Follow the user's instructions.`
  - no guard or serve needed, but keep all the isolation
  - `--then` is refused
- New `--max-output-tokens N`, which sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS=N` in the child's env only.
- Fix line 26: `prompt-dry-run-cast.sh` becomes `prompt-dry-run-bin/cast`, and describe the served reads.

Guard changes: as in 2.6.

The test runs the guard as a subprocess with a temp `RUN_DIR` and `DRY_RUN_SERVE_DIR`, and a fake real `cast` earlier on PATH that echoes `LIVE $*`. It asserts:
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
- `packages/evals/tsconfig.json`: model it on `packages/cli/tsconfig.typecheck.json`, include `src/**` plus the convex, shared and cli source files the surfaces import, no `rootDir`, `noEmit`
- `packages/evals/src/{index,paths,models,surface,registry,layout,stats,served,state,snippet}.ts`
- `src/adapters/{convo,freezes,resolver,replay,judge,runs,dryRun}.ts`
- `src/commands/{status,check,stale,snapshot,grade,capture,doctor,snippetCmd,publish}.ts`
- `src/testSurface.ts`: an `echo` surface used only by tests
- `src/surfaces/<id>/meta.ts` for all 10 surfaces, values from section 3
- `src/surfaces/<id>/index.ts` stubs that throw `"<id> is not implemented yet"`
- `src/{cli,freezes.guard,served,stats,state}.test.ts`
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
  - `snippet show` equals `evalsSnippet({name:'evals', repoNotes})`
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
- new golden files under `packages/convex/convex/__golden__/`, one per surface

Changes:
- Export `titleRequest(input)` and `shortTitleRequest(input)`, plus a pure `selectTitleInput(rows, conversation)` extracted from `getConversationForTitle` (362). The query fetches the same rows and calls the selector.
- Export `settleRequest(tail)` around `buildSettlePrompt`.
- Each fetch posts `JSON.stringify(anthropicBody(req))`.
- `agentTasks.ts:2624` and `storyMode.ts:16` use `CHEAP_MODEL`; that is a literal swap only.
- Order of work: first write golden JSON of today's request bodies for 3 fixtures per site from the current code; then refactor; then assert equality.

Acceptance:
- goldens are equal
- `grep -rn 'claude-haiku-4-5-20251001' packages/convex/convex --include=*.ts | grep -v test` leaves only `lib/anthropic.ts:7` and the U6/U7 sites
- `cast check convex`
- `bun test packages/convex/convex/titleGeneration.test.ts packages/convex/convex/idleSummary.test.ts`

**U6: Insight and call summary on shared requests**

Files:
- `packages/convex/convex/sessionInsights.ts`
- `transcripts.ts`
- `transcripts.test.ts`
- new `sessionInsights.request.test.ts`
- goldens

Changes:
- Extract `selectInsightContext(rows)` (from 119: first 8 + last 10) and `insightRequest(ctx)` (from 486-546), with `toLocaleTimeString(…, {timeZone: 'UTC'})` at 466 and `temperature` left undefined so the API default of 1 is preserved.
- Extract `callSummarySource(segments, kind)` (the 40-word skip at 918 and the 60,000-character tail at 921) and `callSummaryRequest(source, kind)` (1116-1142), with temperature undefined.
- Both handlers post `anthropicBody(req)` with `CHEAP_MODEL`.
- Goldens are generated under `TZ=UTC` before the refactor.
- Record, but do not fix, that the insight parser reads `key_changes` and `timeline` fields the prompt never asks for. File it as a finding on ct-55702.

Acceptance: goldens are equal, `cast check convex`, and both test files are green.

**U7: Suggest pipeline seams**

Files:
- `packages/convex/convex/composerSuggestions.ts`
- `composerSuggestions.test.ts`
- `packages/convex/convex/http.ts`: one appended route

Changes:
- `predictSuggestions(context, profile, provider, complete = llmComplete)`.
- Export `suggestRequest` for the Haiku branch at about 733, with `CHEAP_MODEL`.
- Extract `contextFromRows(rows, …)` from `getSuggestionContext` (65).
- New `POST /cli/suggestion-profile`: `{api_token}` resolves to that user's id, then `getSuggestionProfile` runs for that user only. There is no `user_id` parameter. It returns the profile or null.

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

Change: move `buildPrompt`'s body (595 on) into `export function buildTriggerFrame(task, now: number)`. Its imports stay light: `formatTimeAgo` from wherever `taskScheduler` imports it, and `triggerLifecycleInstructions`. `Date.now()` becomes `now`. The private `buildPrompt(task)` returns `buildTriggerFrame(task, Date.now())`.

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

Precondition: Phase 0 (ct-52537) is actively editing CI. If any of these files has uncommitted edits, do not touch them. Send the owning session the exact lines below with `cast send`, and wait for them to land.

Changes:
- Add `"packages/evals/"` to the `cli` entry of `AREA_PREFIXES`, so `test-cli` runs. Leave the pre-existing duplicate keys alone; they are Phase 0's.
- In `ci.yml`'s `test-cli` job, add a step "Unit tests (evals package)" with `working-directory: packages/evals`, running `bun test src/`.

Acceptance:
- `bun test scripts/ci/` is green
- a scope test asserts that `packages/evals/src/x.ts` sets `run_test_cli` and does not force every job

**After wave 2:** run `packages/convex/deploy.sh` once from a tree that is a superset of origin/main. This deploys U5-U7 and the new route. It must happen before any push that includes them.

### Wave 3 (after wave 2, parallel; each unit owns only `packages/evals/src/surfaces/<its ids>/` and `packages/evals/fixtures/<its ids>/`, plus the files named)

**U10: settle** (ct-55701). Also deletes `packages/convex/scripts/settle-eval.ts`.

Steps:
- Move the 17 inline cases (22-164) into `fixtures/settle/<case>.json` with the label inline.
- Create 17 public freezes: `./evals freeze create settle@fixture:<case>`.
- Before deleting the old script, add a test that for all 17 cases the surface's rendered prompt equals `buildSettlePrompt` over the same tail. That proves the move is lossless.
- Run `./evals check settle --reps 5`.
- Freeze 3 of the founder's own moments privately, with labels in `EVALS_HOME/labels/settle/`.

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

**U12: title, insight, call-summary** (ct-55702)

For each surface:
- 1 or more synthetic fixtures (public), plus 3 private freezes from the founder's own sessions and calls, with hand-written criteria reviewed for privacy
- `productionReply`:
  - title: current `conversation.title` from `/cli/read`, labelled "current, may postdate the moment"
  - call-summary: the stored summary from `cast call --json`
  - insight: null

Acceptance: `./evals check title insight call-summary --reps 5` completes, and every freeze has a recorded baseline.

**U13: ask, handoff** (ct-55702)

- ask: two sequential `ctx.call`s, terms then answer.
- The judge sees the question and the selected context. `productionReply` is null.
- handoff: `productionReply` is the child session's first message when the ref anchors a real handoff (resolved from `/cli/read` of the child). Otherwise null.

Acceptance: the same baseline as U12.

**U14: org-review** (ct-55699, part of ct-55703)

Files: `src/surfaces/orgReview/{meta,index,build,checkProposal,assemble,grade,present}.ts` and `grade.test.ts`.

Port:
- `build.ts`: `mkrun.ts`. Import `buildOrgAnalyzerPrompt` and `summarizeInputs` from `packages/cli/src/orgInitRun.ts` by relative path. Keep the harness note, and point it at `checkProposal.ts`. Keep the hashes that `hashes.json` recorded in `run.json.promptSha`.
- `checkProposal.ts`: `check.ts`.
- `assemble.ts`: `assemble-proposals.py`.
- `grade.ts`: `grade.py`, with the same sets, bands and pools. The workspace comes from `freeze.meta.workspace`, not the path.
- `present.ts`: `capture.sh`, `capture-raw.ts` and `chart-fit.ts`, same behaviour. It needs `localhost:3200` and the founder's Chrome, and refuses with one line when either is missing. The presentation grading run goes through `ctx.agent` on `JUDGE_MODEL` with `--tools Read` and max-turns 10. It reads the rubric from `docs/architecture/org-eval.md` "Presentation rubric" at run time, so the rubric has one home, and writes `presentation:<line>` checks.

Data migration, copy only (`~/.cache/org-eval` stays untouched):
- `{union,codecast}/{grade-sets.json, ground-truth.md, sample30-labels.*, extra-labels.json, final-fixes.md}` go to `EVALS_HOME/labels/org-review/<ws>/`, followed by a git commit in the labels repo.
- `union/served/base8` and codecast's latest served dir go to `EVALS_HOME/snapshots/org-review/<ws>-<name>/`.
- Create the private freezes `org-review@union-base8` and `org-review@codecast-<name>`, with `meta.workspace`.

`grade.test.ts`, which reads `~/.cache/org-eval` and skips when it is absent (so CI skips it):
- copy `union/round-36/s{1,2,3}` to `/tmp`
- run `python3 ~/.cache/org-eval/bin/grade.py` on the copies, reading `grade.py` first to see where it writes
- run `./evals grade org-review <copy>`
- every field must be equal
- `round-35/s{1,2,3}` must fail `no-wrong-close`, with ct-49328 in the evidence

Acceptance: the regrade matches exactly, and round 35 fails the gate.

**U15: role-wake, anchor-brief** (ct-55702)

Steps:
- Snapshots use `./evals snapshot role-wake --trigger tr-N --team T`.
- The frame is `buildTriggerFrame(trigger, capturedAt)`, followed by the harness note: "write the brief you would save to `brief.md` in the current directory".
- anchor-brief takes the production opening from `/cli/read`.
- The `fixture:` freezes render `bootstrapMessage` and `roleOpeningMessage` (anchors.ts 166, 115) over synthetic facts.
- Two freezes each, plus a 3-rep smoke.

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

**U17: Org refresh** (ct-55703, operational, no repo files)

Steps:
1. `./evals snapshot org-review --team <union> --name base9` and the same for codecast.
2. Hand-label every flagged record that is new since base8 into the private labels, following org-eval.md "Ground truth, built by reading", and commit in the labels repo.
3. Run 8 samples each on base8 and base9 at `AGENT_MODEL` for the new baseline.
4. Run presentation capture and grading on the best and the worst sample, attended.

Acceptance:
- every flagged record in base9 is in exactly one label set, or in `either`
- the baselines are recorded
- `no-wrong-close` passes, or the failure is filed on ct-55703

**U18: Cadence and publishing** (ct-55704)

Steps:
1. Arm triggers A and B (2.9).
2. `cast trigger run` each once: with nothing stale, confirm a precheck skip. Then touch a declared source in a scratch commit on a worktree, not main, or simply commit U16's docs if they are declared, and confirm a run, a published URL and a correct summary.
3. Open the published page in a `cast browser` tab and read it before linking it anywhere.

Acceptance:
- both triggers show in `cast trigger ls`
- one skip and one run are in `cast trigger log`
- the page is email-gated: `cast publish links` shows the gate

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
| `EVALS_HOME` is machine-local; labels could be lost, and cloud hosts lack it | `labels/` is a git repo. `doctor` reports missing snapshots and labels per freeze, and `check` skips them with one line instead of crashing. Agent surfaces are laptop-only in Phase 1 (keychain), or use `--account`. |
| The TS grade port drifts from `grade.py` | U14's exact regrade test on round 36, plus the round-35 negative case. |
| The CI files are being edited by Phase 0 | The U9 precondition hands the lines to the Phase 0 owner instead of editing concurrently. |
| The suggest provider in prod may be openai (`SUGGESTIONS_PROVIDER`) | The eval pins and records the anthropic branch. `status` notes that the openai branch is not evaluated in Phase 1. |
| Hand-written judge criteria could describe private content | Only synthetic freezes are committed, so real criteria never reach git. |

---

## 6. Decisions that need the founder

Both are advisory. Work proceeds on the defaults, and each reverses cheaply.

1. **Real-world labels in the public repo.** The default keeps every real label private in `EVALS_HOME/labels`, which is a local git repo with no remote. That includes codecast's own id-only grade sets, even though ct-55699's title says to commit them. Options:
   - (a) keep them private, which is the default
   - (b) commit codecast's own id-only sets
   - (c) push `EVALS_HOME/labels` to a private remote for backup and sharing
2. **Call-surface fidelity.** The default follows pl-810: `claude -p --call`, with every knob except temperature matched. The alternative is an API backend with a dedicated eval key (not the prod key), used only by `ctx.call`. That buys exact temperature fidelity and costs a key on the laptop.

---

## 7. Facts that changed since the survey, and subtask mapping

- `~/src/platform/packages/evals` now has 3 files changed, +24/-3, not ~522 lines. U1 vendors from HEAD regardless.
- The mirror's auth and cli-kit contain files that platform HEAD lacks, for example `auth/src/web/authPrincipal.ts` and `cli-kit/src/update/signing.ts`. A full vendor from either source would break codecast, which is why U1 uses the overlay.
- There are 8 Haiku literals in 7 files: titleGeneration 106 and 177, sessionInsights 543, transcripts 1128, idleSummary 334, agentTasks 2624, composerSuggestions 733, storyMode 16.
- `out.json` carries `stop_reason`, `usage.output_tokens` and `modelUsage`, which is what makes the `prod-budget` and `model-as-pinned` gates buildable.
- `cliHttp.ts` has no imports, so it is safe to import directly.
- `evalsSnippet` prepends `./`, so the name must be `evals`.
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