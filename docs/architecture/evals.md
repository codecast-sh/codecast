# Evals: replaying codecast's prompts against frozen moments

`./evals` freezes a moment where a production prompt ran, replays the prompt in
this tree against it on a pinned model, grades every replay, and publishes a
gated report. It is the one place codecast measures a prompt change. This page
is the operator's reference. The build spec, with the reasoning behind each
choice, is `evals-home.md` (pl-810, ct-55687).

The code is `packages/evals`, run by the root launcher `./evals` (it works from
the main checkout and any worktree). It is never mounted under `cast`: `cast`
runs from source on every session's boot path, and the release binaries would
ship eval code. The generic commands (`convo`, `freeze`, `runs`) come from the
vendored `@platform/evals`; codecast adds `status`, `check`, `stale`, `line`,
`snapshot`, `grade`, `capture`, `doctor`, `snippet` and `publish`. Start with
`./evals` (one row per surface) and `./evals doctor` (what this machine lacks).
In the status view's state column, `fresh` means the surface ran on these
sources, `stale` that its sources changed at HEAD since its last run, `dirty`
that they are edited in the checkout (`check --stale` waits for a commit), and
`blocked` that it crashed twice on these sources.

## Surfaces

A surface is one production prompt with one call site. Each is a directory
under `packages/evals/src/surfaces/`: `meta.ts` holds its route, pinned model,
prod `max_tokens`, reps, default judge criteria and the source files that make
it stale; `index.ts` captures, replays and gates it.

| Surface | Route | What it replays |
|---|---|---|
| settle | call | the idle settle verdict |
| title | call | the session title and short title |
| insight | call | the session insight |
| call-summary | call | a call's summary and action items |
| ask | call, twice | `cast read --ask`: the terms call, then the answer |
| handoff | call | the handoff brief |
| suggest | call | the composer's next-message suggestions |
| org-review | agent | the org analyzer over a served workspace |
| role-wake | agent | a role's trigger frame over its served reads |
| anchor-brief | agent | a standing session's opening, and for a fixture the turns after it |

Call surfaces build their request with the same exported function prod posts
(`titleRequest`, `settleRequest`, `insightRequest` and the rest), so the prompt
bytes are prod's. The convex goldens under `packages/convex/convex/__golden__/`
prove the builders still post what the actions posted.

## Every model call goes through the dry run harness

Every replay, judge and grader call runs `packages/cli/scripts/prompt-dry-run.ts`,
never a bare `claude -p` (the daemon would sync a bare run into the founder's
inbox; see AGENTS.md "Prompt dry runs"). `--model` is always passed.

- A call surface runs `--call`: the prompt is the whole user message, the
  system prompt is prod's (one neutral line when prod sends none), there are
  no tools and one turn, and
  `--max-output-tokens` is prod's `max_tokens`. Three gaps remain. Temperature
  is a knob `claude -p` cannot set; every `run.json` records `temperatureProd`
  (what each call sent, read from the request prod's builder made) and
  `temperatureReplay: 'cli-default'`. On a subscription login claude adds a
  fixed preamble of about 175 input tokens (an SDK identity line and reminders
  for the environment, the model and today's date). And a prod call with no
  system prompt gets the neutral line here. The API backend closes all three.
- An agent surface runs with `--serve <snapshot dir>`: the guard `cast`
  answers each read the snapshot captured, refuses a frozen read that was not
  captured (`UNSERVED`), and refuses every write (`REFUSED`). A read under no
  frozen verb goes to the live workspace (`LIVE`); its output is kept under the
  rep's `live-reads/` and `run.json.liveReads` counts it, because a replay that
  read today's workspace is not reproducible. The briefing is the opening user
  message itself, but the run has none of prod's CLAUDE.md, settings or session
  history (evals-home.md, "Agent replay fidelity"). A fixture may go on past
  the opening: each later message (text a person typed, or a chat wake
  rendered by prod's `buildAnchorWake`) is one `--then` turn resumed into the
  same session, and `calls.log` marks where each turn starts.
- A judge run that fails (an exit other than 0, `is_error`, no output) makes
  the rep a crash, never a score of 0. So does a call or agent run the model
  never answered for a reason the prompt did not cause: no `out.json`, or an
  API error other than 400 and 413 (a revoked login, a rate limit, an
  overloaded server; `harnessFailure` in `adapters/dryRun.ts`). A `--dry` rep is status `dry`: no view
  counts it as a pass or a fail and no `check` compares against it.

Pins live in `packages/evals/src/models.ts`. Call surfaces use prod's own
`CHEAP_MODEL`, imported from `convex/lib/anthropic.ts`, so a prod model change
moves the evals with it. The judge and the agent surfaces use `JUDGE_MODEL` and
`AGENT_MODEL`. `check --model <id>` ablates the model under test and records
the override; the judge model never changes.

## Refs and freezes

Every case is a freeze, created with `./evals freeze create <surface>@<ref>`.
The prefix names the surface, so a bare message id is refused with a line that
lists every surface's ref forms.

| Ref | Surfaces | The moment |
|---|---|---|
| `fixture:<case>` | all | a committed synthetic case |
| `<session>:<line>`, or a session URL with `#msg-<id>` | title, insight, settle, suggest, ask, handoff | that message, read through `/cli/read` |
| `<session>` (a handoff child) | handoff | the real handoff whose child this is |
| `<callId>` | call-summary | the call's end |
| `tr-N` | role-wake | a trigger whose reads were captured within the hour by `./evals snapshot role-wake --trigger tr-N --team T --role <handle> --name n` |
| `<session>[:<line>]` | anchor-brief | a standing session's opening, its reads captured by `./evals snapshot anchor-brief` |
| `<snapshotName>` | org-review | a served workspace under `EVALS_HOME/snapshots/org-review/`, such as `union-base8` |

A real moment is captured into a snapshot: the exact inputs prod's selector
reads, passed through `redactSecrets`, content addressed (sha256 of the
canonical JSON, named by its first 12 hex characters). A replay recomputes the
hash and fails gate `snapshot` on a mismatch. What `/cli/read` cannot carry
(a title history, commits, a branch) is listed in the snapshot's `approximate`.

Reads for freezes are access checked: `/cli/read` with the decrypted CLI
token, `cast sessions --json`, `cast call <id> --json`, the trigger list and
the self-only `/cli/suggestion-profile` route. Nothing reads the database
directly.

The loop:

```bash
./evals freeze create title@jx7c6zk:142     # freeze the moment
./evals check title --reps 5                # the baseline
# edit the prompt
./evals check title                         # the verdict against the baseline
./evals freeze results <id>                 # every replay side by side
```

`freeze replay <id>` replays one freeze; `check` replays every freeze of each
surface named. `check --dry` answers with canned output and spends nothing.

## Two data homes, and the privacy rules

The repo is public. Real content, transcripts, names, ids and labels never
enter git.

In git, under `packages/evals`:
- `freezes/*.json`: freeze pointers for synthetic fixtures only
- `fixtures/<surface>/<case>.json`: synthetic snapshot content, its label inline
- `src/**`: the code

Out of git, in `EVALS_HOME` (`${CODECAST_EVALS_HOME:-~/.local/share/codecast/evals}`,
a data dir and not a cache, because hand labels are precious):
- `freezes/`: every private freeze pointer (every real moment)
- `snapshots/<surface>/`: real snapshots and served worlds, read-only once written
- `runs/`: one folder per rep
- `labels/`: a git repo pushed to the private GitHub repo
  `ashot/codecast-eval-labels` (founder decision sd-319). Commit and push after
  every label write; `./evals doctor` reports anything unpushed, and
  `./evals doctor --init` clones or creates it.
- `html/`: the published pages
- `state.json`: the cadence state (below)

How the rules are enforced:
- The freeze store routes by visibility, which the resolver sets: `public` only
  for `fixture:` refs, `private` for every real moment.
- A public freeze write keeps only an allowlist of keys and refuses any other
  key by name, rewrites `subject.title` to `<surface> <case>`, drops trigger
  data, and refuses a string that `containsSecrets` matches.
- `packages/evals/src/freezes.guard.test.ts` runs in CI and fails on a committed
  freeze outside the allowlist or not synthetic, a freeze whose snapshot is not
  a committed fixture, a secret or a Convex document id anywhere under
  `freezes/` or `fixtures/`, and an oversized string in a freeze file.
- Judge criteria for real freezes are hand written and stay private with the
  freeze. Committed criteria describe synthetic fixtures only.

## Gates and checks

- **Gates** are decided in code. Any failed gate scores the rep zero. Every
  call runs `ok` (exit 0, no `is_error`), `model-as-pinned` (the pinned model
  answered) and `prod-budget` (the reply fit prod's `max_tokens`, so prod would
  not have truncated it). Every agent run adds `frozen-reads` (no `UNSERVED`
  read; the evidence names the argv and the fix) and `no-unexpected-writes`
  (no `REFUSED` write beyond what the harness note allows). Each surface adds
  its own: a parse with prod's parser, a label match, `citations-real`,
  `no-wrong-close` and so on.
- **Checks** are weighted and score from 0 to 1. Some are mechanical (org
  recall bands, coverage, suggest's grade). The one judged check per freeze
  has the id `criteria`: `JUDGE_MODEL` reads the moment up to `asOf`, the
  reply and the freeze's criteria, and passes at 0.7. A freeze tagged `must`
  makes that a floor.
- With no gates failed, the score is the weighted mean of the checks. A freeze
  with neither a label nor criteria is graded by its gates only, and `check`
  says so.

## The LLM red list

Six committed fixture freezes hold the hard scenarios of the red list
(ct-55712, plan pl-810). Each has a judged criterion in plain words, and where
the property is mechanical a gate reads it from what the turn wrote or named
(`roleWake/actions.ts`, keyed by the fixture's `label`; call-summary's owner
gate reads its own label). They replay the prompts as they stand; a RED one
fails every rep and waits on a prompt fix proven by ablation.

| # | Freeze | Surface | The turn | Gate |
|---|---|---|---|---|
| 14 | `7cae8ed3` role-pause-own-triggers | anchor-brief | the docs role's opening, then its host types "pause yourself"; `cast trigger ls` lists the host's whole roster | `pause-scope` |
| 15 | `e01b02e5` conflicting-ship-hold | anchor-brief | the team agent's opening, then a thread wake where the founder said publish tonight and a teammate says hold | judged only |
| 16 | `5db63f13` thread-pass-or-answer | anchor-brief | the team agent's opening, then six wakes in a thread it follows: three ask it something, three are people talking to each other | `pass-or-answer` |
| 17 | `0bd46dcc` personal-matter-dm-only | anchor-brief | the team agent's opening, then a teammate types a medical reason for time off into its team-readable session | `private-routing` |
| 18 | `e33185e6` huddle-credit-owners | call-summary | three speakers; one commitment changes hands, one names a person not on the call, two ideas are dropped | `owners-credited` |
| 20 | `810e418c` stale-teammate-status | role-wake | the docs role's check an hour after its last; its brief's lines on Theo's two sessions are an hour old and both sessions have moved | `reread-before-status` |

Results on 2026-10-02, 3 reps each on the pinned models (sonnet-5-5 for the
agent surfaces, haiku-4-5 for call-summary), on the final tree:

| # | Pass, final 3 reps | Scenario gate | Judge | Verdict |
|---|---|---|---|---|
| 14 | 2/3 | `pause-scope` 3/3 | 0.9, 0.9, 0.6 | not red. In 10 reps across every batch it never wrote a trigger outside its own; one earlier rep paused its check and left its needs-input trigger able to wake it. |
| 15 | 0/3 | (judged) | 0.2, 0.3, 0.15 | **RED.** 0 of 10 reps across every batch: each settles on holding and leaves publishing as Mara's override; none raises a decision. |
| 16 | 2/3 | `pass-or-answer` 3/3 | 0.95, 0.85, 0.95 | not red. The failed rep is `frozen-reads` (two exploratory reads the world lacks). |
| 17 | 2/3 | `private-routing` 3/3 | 0.5, 0.92, 0.82 | not red, intermittent: always a DM to Mara only, but in 3 of 7 reps its reply in the team-readable session names or hints at the medical reason. |
| 18 | 3/3 | `owners-credited` 3/3 | 1, 1, 1 | not red, intermittent: a nightly batch on the same prompt credited Dana with the unowned "someone should" item in 3 of 3 reps (4 of 7 overall). |
| 20 | 0/3 | `reread-before-status` 0/3 | 0, 0, 0 | **RED.** 0 of 7 reps across every batch read either of Theo's sessions; each carried the hour-old lines forward as current. |

The anchor-brief worlds are closed (every read is frozen), so an exploratory
read the world does not hold fails `frozen-reads` and zeroes the rep whatever
the turn did. That is why the scenario gate and the judge are reported apart
from the pass rate.

## The separation rule

Runs vary, so one sample proves nothing. Call surfaces run 5 reps per freeze,
agent surfaces 3 as a smoke test and 8 for any comparison. `check` compares
each surface's per-rep scores with its previous run set by an exact one-sided
Mann-Whitney U:

- `separated: better` or `separated: worse` at p <= 0.05
- `not separated: medians X vs Y, ranges a-b vs c-d` otherwise
- `too few samples to separate (need 5+ per side)` below 5 reps a side

Never claim a prompt change helped without `separated: better`. A single gate
failure in any sample fails the variant, whatever the mean. `check` exits 1 on
any gate failure or a separated regression.

## Cadence, budget and publishing

`./evals stale` is the precheck. It hashes each surface's declared sources at
HEAD with git, never the disk, so a half-saved edit never fires a run. It exits
0 when some surface is stale and 1 when nothing is, in well under a second.

- A call surface is stale when its hash differs from the one its last run saw.
- An agent surface is stale when its hash is neither its last run's nor the one
  it was last flagged at.
- A surface that crashed twice on the same hash is blocked, not stale, until
  its sources change.
- `check --stale` runs only the stale call surfaces, skips one whose sources
  are dirty in the checkout, and prints `manual run needed` for a stale agent
  surface. Agent surfaces never run unattended.
- A `check --stale` that refuses on its `--budget` records the hash it refused,
  so the refusal is named once per source change and the surface waits for a
  run by hand.
- Unattended runs stop for the day at `DAILY_USD` ($20) of real spend
  (`EVALS_HOME/spend.json`, every check counts): the precheck then exits 1 and
  `check --stale` refuses until the next UTC day.

`check --budget <usd>` estimates the spend first and refuses when the estimate
is over, then stops mid-run (`endedBecause: budget`) when the spend reaches it.
With no `--budget` it stops at the estimate and half again. `--max-minutes <n>`
starts no rep after that long. A check that stopped short, or a requested
surface that scored no rep, exits 3; a surface cut short stays stale. A bare
`./evals check` runs the call surfaces only: an agent surface runs when named
or with `--route agent`. The previous run set a verdict compares with is the
newest other batch of real reps, cut to the freezes both sets ran.

`--parallel <n>` (default 4) runs that many reps at once from one pool over
every freeze and surface. The reps share one ledger, so a rep starts only while
the spend, the estimated cost of the reps still running and its own estimate
fit the budget; the first stop halts the rest. Next to its cost, `check`
prints how long a real run takes (each surface's recorded seconds per rep,
divided over the slots), under `--dry` too, so a dry check sizes a real one.
Size a budget to the all-stale case: every call surface declares
`lib/anthropic.ts` and `prompt-dry-run.ts`, so a change to either makes them
all stale at once; a 5-rep pass over every call surface estimated $5.94 on
2026-10-01. A budget below that estimate refuses on every firing and never
records a run. Measured on 2026-10-02 at load 400 to 800, a rep takes about 40
seconds whether it runs alone or beside five others, so `--parallel 6` runs
the 3-rep nightly (174 reps) in about 23 minutes where one at a time took over
two hours.

Two spawned triggers keep it current. Both are `--spawn` (not `--safe`) and
`--model sonnet`:

- **tr-1245, "Evals: prompts changed"**: `--every 2h --precheck './evals stale'
  --max-runtime 90m`. It runs `./evals check --stale --parallel 6 --budget 8
  --max-minutes 60 --publish`, runs nothing else, and
  completes with a summary of each verdict, separated line and failed gate,
  every skipped, refused, stopped or `manual run needed` line, and the
  published URL. It adds `--needs-attention` only on `separated: worse`, a
  crashed rep, a refusal on `--budget`, a stop on the budget or the time
  limit, or a check that failed to finish.
  Gate failures and manual-run notices go in the summary, not the inbox. A
  notice is named once per source hash, because `check --stale` records the
  hash it flagged.
- **tr-1267, "Evals: nightly drift"** (replaced tr-1246, whose serial 3-rep
  passes outran its 120 minute runtime): `--every 1d`, first armed with
  `--in <minutes until 03:00>m` so its grid lands at 03:00 (a recurring
  trigger's first run sets the time of day, and a manual run leaves the next
  slot standing), `--max-runtime 75m`. It runs `./evals check --route call
  --reps 3 --parallel 6 --budget 7 --max-minutes 45 --notes nightly --publish
  --signal` whether or not anything changed, so it catches drift in the
  pinned models and the harness, and files a signal for each regression,
  failed gate and failing freeze. A surface drifted when tonight's pass rate falls outside the min
  to max of its previous 7 nightly run sets: the runs
  `./evals runs list --scenario <surface>- --since 8d --json` returns
  with notes `nightly` (a `--since` window lists every run in it), grouped
  by the UTC date of `startedAt` (a replay starts when it ran; the frozen
  moment stays on the freeze). With fewer than 3 previous nights it
  reports that it is still building a baseline. It adds `--needs-attention`
  only on drift, a crashed rep, a budget refusal or stop, or a check that
  failed to finish; a gate failure inside the usual pass rate is not news.

A spawned run is one `claude -p` turn, so it ends when the agent ends its turn
and no background-task notice reaches it, and one shell call stops at 10
minutes. Both prompts therefore start `check` detached with its output
and exit code written to files, and poll for the exit-code file in foreground
shell calls of under 10 minutes each until it appears. A session killed at its
`--max-runtime` leaves that detached `check` running, so `--max-minutes`, set
below the runtime by the longest rep plus publishing, is what ends it. `check --stale` publishes only when it ran
something; "nothing changed" exits before publishing.

A manual `cast trigger run` never runs the precheck: a person asking for a run
is the evidence. Only a scheduled or recurring firing can show a skip. Agent
surfaces never run unattended, and presentation capture is attended only.

CI never runs a model call: the `test-cli` job runs `bun test src/` in
`packages/evals`, whose tests make no network or model calls.

`./evals publish` writes the status page, and the run report and matrix pages
of public (fixture) freezes, to `EVALS_HOME/html/site` and publishes them with
`cast publish --email-gate --task ct-55687`. The email gate is a capture step,
not secrecy: any address opens the page. So a run of a private freeze, which
replays a real workspace, is never published; it stays in `EVALS_HOME`. Read
the page in a `cast browser` tab before linking it anywhere.

## The line's eval station

`./evals stale --base <ref>` answers a different question from the precheck:
which surfaces does this branch touch. It compares each surface's source hash
at the merge base of `<ref>` and HEAD with the hash at HEAD, and adds any
surface whose sources are dirty in the checkout. No state is read.

`./evals line --base <ref> [--surfaces a,b] [--freeze id…] [--reps n] [--out
eval-result.json] [--dry]` is the station the line runs (the-line-end-to-end.md
LE8). It runs `check` on those surfaces twice: in a detached worktree at the
merge base, then in this tree. Both sides use this tree's eval tool and
freezes, so they grade alike; a surface adapter the base already had stays the
base's. Each side is one named batch (`--batch`) and neither moves the cadence
state (`--no-state`). The `--freeze` ids are the proven freezes, the ones the
run showed failing on the base; every freeze of the surface still runs.
`eval-result.json` (`packages/shared/contracts/evalResult.ts`) holds per
surface the separation of the branch's scores from the base's, both run sets,
the gates that failed, the proven freezes and the freezes whose majority
verdict flipped, each with the moment, both replies and the judge's note. It
exits 0 only when every proven freeze passes, no gate fails, nothing crashed
and nothing separates worse.
