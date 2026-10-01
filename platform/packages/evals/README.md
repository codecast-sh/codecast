# @platform/evals

Read conversations, freeze a moment, replay and simulate it, judge the
result. The terminal CLI, the on-disk run layout, and the pages that render a
multiplayer simulation, with the app's own data behind adapter seams.

Extracted from union-mobile's `xrun convo`, `xrun freeze`, `xrun evals` and
`xrun sim` (`~/src/union-mobile/outreach/backend/src/lib/{conversations,eval,sim}`)
and its `/admin/simulations` React viewer, and from eaiden's `packages/sim`
evidence layout and HTML report. First consumer: eaiden (`./xrun`).

```
src/model.ts        the model: Participant, Conversation, Freeze, RunSummary/RunDetail, Score, and the seams
                    ConvoSource, FreezeStore, FreezeResolver, Replayer, ReplyJudge, RunSource, SimLauncher
src/story.ts        who was in a run and the story of it, derived from events, sends and a roster
src/fs/             fsRunSource over a folder of runs; fsFreezeStore over JSON files
src/render/         pure terminal renderers: conversations, runs, freezes, scenarios
src/html/           self-contained pages: one run, a sweep, a conversation, a freeze
src/cli/            registerEvals(program, sources): convo, freeze, runs, sim on a commander program
src/snippet.ts      evalsSnippet({ name }): the one page an agent reads before using the CLI
src/fixture.ts      a three-person run in the on-disk layout, for tests and for proving a consumer's wiring
```

## The loop

`convo inbox` → pick a moment → `freeze create <messageId>` → `freeze judge <id> "…"`
→ `freeze replay <id> --reps 3` (the baseline) → edit the prompt → replay → `freeze results` / `freeze diff`.
A judged freeze is a regression guard; `runs` reads every simulation and replay
from one place; `sim` runs a scenario forward with simulated people.

Every view ends with the exact next commands. Every read takes `--json`. Colour
is off when stdout is not a terminal, so an agent reading through a pipe gets
plain text. Ids print as eight characters and any prefix is a handle, except
run ids, which are folder names and print whole.

## The on-disk run layout

A harness that writes this gets every view for free (`fsRunSource`):

```
<root>/<scenario>-seed<n>-<stamp>/
  result.json    counters: scenario, seed, endedBecause, steps, costUsd, virtualElapsedMs, realElapsedMs
  events.jsonl   one RunEvent per line: seq, virtualAt, realAt, kind, payload
  sends.json     RunSend[]: everything that would have reached somebody
  score.json     the Score, with scenario, title, hunts, seed on it
  captures.json  every call the boundary caught
  runs.json      the assistant's own runs inside the simulation (optional)
  steps.json     their tool calls (optional)
  roster.json    who was in the run (optional; derived from the events without one)
  run.json       replay bookkeeping: freezeId, notes, model (optional)
  report.html    the page (written by `runs html`)
```

Event kinds the story reads: `inbound_injected` (from, to, text, identity),
`send_captured` (label, detail.to, detail.text), `persona_scheduled`,
`persona_replied`, `persona_silent` (persona, reason, room), `scenario_step`
(label), `note`, `job_failed`, `boundary_blocked`, `roster`. Anything else is
shown in the event log and left out of the story.

## Multiplayer

Every message names a participant; participants have roles (owner, assistant,
paired, persona, third party); the terminal and the page colour by
participant, the assistant is always the accent, and a room is a participant
too, so a room of three reads as three voices and never as "in" and "out".

## Mounting it

```ts
import { Command } from 'commander';
import { registerEvals, runEvalsCli } from '@platform/evals/cli';
import { fsFreezeStore, fsRunSource } from '@platform/evals/fs';

const program = new Command().name('xrun');
registerEvals(program, {
  name: 'xrun',
  convo: myConvoSource,                       // the app's messages, as Conversation
  freezes: fsFreezeStore({ dir: '.sim/freezes' }),
  freezeResolver: myResolver,                 // a message id → a moment
  replayer: myReplayer,                       // runs the app from the moment, writes runs in the layout
  productionReply: myProductionReply,         // what the app actually said next
  judge: myReplyJudge,                        // grades a reply against the freeze's criteria
  runs: fsRunSource({ root: '.sim/runs' }),
  sims: myLauncher,                           // lists and runs scenarios
  htmlDir: '.sim/html',
});
await runEvalsCli(program);
```

A seam the app leaves unset fails with one sentence naming it. Eaiden's
adapters (`~/src/eaiden/tools/xrun/src/adapters`) are the worked example.

## Tests

`bun test` renders every view and page and drives every command against the
fixture run and in-memory sources. `bun run typecheck`.
