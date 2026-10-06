# @platform/evals

Read conversations, freeze a moment, replay and simulate it, judge the
result. The terminal CLI, the on-disk run layout, the pages that render a
multiplayer simulation, and the shared Evals views (the wall, a surface, a
run, a freeze, compare and bisect) over one verdict implementation, with the
app's own data behind adapter seams.

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
src/contract/       ./contract: the neutral wire types (RunRowCore and its validator, the route table, matchRoute, the bridge protocol); zero deps
src/analysis/       ./analysis: the one run-set verdict (separation, flips, footing), stats, epochs, attribution, bisect math, evalResult
src/query/          ./query: createEvalsHandler(sources, policy), one isomorphic handler for every view route
src/client/         ./client: transports, the memory-only resource cache, polling, liveness, evalsPaths(basePath), view models
src/react/          ./react: EvalsProvider, EvalsApp, the hooks and every view, plus react/styles.css and react/tokens.css
```

The five subpaths are layers, in that order: each imports only the layers
above it. `contract`, `analysis`, `query` and `client` are pure (no node,
bun, React, commander or DOM, through any file they reach), and `react`
reaches nothing node-side. `src/layers.test.ts` enforces both rules.

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
process.exitCode = await runEvalsCli(program);
```

`runEvalsCli` returns the run's exit code and leaves `process.exitCode` as it
found it, so only the bin entry decides how the process exits. A seam the app
leaves unset fails with one sentence naming it. Eaiden's
adapters (`~/src/eaiden/tools/xrun/src/adapters`) are the worked example.

## Mounting the views

A product serves its rows through one handler and mounts the views over a
transport and a cache:

```tsx
import '@platform/evals/react/tokens.css';
import '@platform/evals/react/styles.css';
import { localTransport, memoryResourceCache } from '@platform/evals/client';
import { createEvalsHandler } from '@platform/evals/query';
import { EvalsApp, EvalsProvider } from '@platform/evals/react';

const handler = createEvalsHandler(mySources, myPolicy);   // rows, surfaces, and any of run, freezes, prompts, git, bisects, changes
const transport = localTransport(handler);                 // in the page; httpTransport(baseUrl) for a server that runs the handler

<EvalsProvider transport={transport} cache={memoryResourceCache()} host={myHost}>
  <EvalsApp path={pathname} />
</EvalsProvider>
```

- **Sources.** What a product leaves out turns its capability off (`/health`
  says which), and the views hide what it cannot fill rather than draw it empty.
- **Policy.** `passed` and `ruler` say whether a rep passed and which judge
  graded it; the verdict functions are bound to them once (`makeVerdict`).
- **Cache.** Memory only by contract: get, set, list, follow and drop, with
  no way to persist. A product may back it with its own store (codecast's
  evalsStore).
- **Host.** Every slot is optional: the router (`useNavigate`, search params),
  the base path, primitives (KeyCap, Sheet, tooltip), key bindings, formatters,
  the product's word for a case (`caseNoun`), its own nav sections and run
  panels. `resolveEvalsHost` fills the rest with plain defaults.
- **Styles.** Components import no CSS. Import `tokens.css` and `styles.css`
  once at the mount root. The views read only `--ev-*` tokens, which resolve
  against the host's `--sol-*` and fall back to codecast's light look.

## Tests

`bun test` renders every view and page and drives every command against the
fixture run and in-memory sources, mounts the shared views in happy-dom over a
real handler, and checks the layer and className guards. `bun run typecheck`.
