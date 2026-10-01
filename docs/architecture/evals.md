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
vendored `@platform/evals`; codecast adds `status`, `check`, `stale`,
`snapshot`, `grade`, `capture`, `doctor`, `snippet` and `publish`. Start with
`./evals` (one row per surface) and `./evals doctor` (what this machine lacks).

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
| anchor-brief | agent | a standing session's opening |

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
  `--max-output-tokens` is prod's `max_tokens`. Temperature is the one knob
  `claude -p` cannot set; every `run.json` records `temperatureProd` and
  `temperatureReplay: 'cli-default'`.
- An agent surface runs with `--serve <snapshot dir>`: the guard `cast`
  answers each read the snapshot captured, refuses a frozen read that was not
  captured (`UNSERVED`), and refuses every write (`REFUSED`).

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

`check --budget <usd>` estimates the spend first and refuses when the estimate
is over, then stops mid-run (`endedBecause: budget`) when the spend reaches it.

Two spawned triggers keep it current:
- "Evals: prompts changed", every 2h with `--precheck './evals stale'`, runs
  `./evals check --stale --budget 3 --publish` and completes with
  `--needs-attention` only on a gate failure, a separated regression or a
  manual-run notice.
- "Evals: nightly drift", every 24h at 03:00, runs
  `./evals check --route call --reps 3 --budget 5 --publish`.

Both run with `--spawn --max-runtime 45m`. CI never runs a model call: the
`test-cli` job runs `bun test src/` in `packages/evals`, whose tests make no
network or model calls.

`./evals publish` writes the status, run report and matrix pages to
`EVALS_HOME/html/site` and publishes them with `cast publish --email-gate
--task ct-55687`. There is no ungated path. Read the page in a `cast browser`
tab before linking it anywhere.
