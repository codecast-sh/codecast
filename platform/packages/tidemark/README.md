# tidemark

A runtime for agents that live among many people over long stretches of time.

Most agent memory is built for one person and one conversation: a transcript that grows until it is cut, or a folder of markdown notes on one machine. That breaks down when one agent serves a group chat, a team, or hundreds of people at once for months. It needs to keep each person's and each group's history apart, to read a year of history without a year of tokens, to show different people different things, and to run as many processes against one database rather than one process against one folder.

tidemark is the layer that keeps that history. Your app appends what happens (messages, calls, tool results, anything) to a log, a background pass summarizes the old parts into a tree, and every time an agent runs it reads one bounded page: recent events word for word, older stretches as summaries that get coarser the further back they go, all the way to the first day. When a summary is not enough, the agent zooms into it, down to the original events.

```
past ◀────────────────────────────────────────────────────────────────▶ now

 ┌──────────────────────┬────────────┬──────┬────┬──┬──┬──────────────────┐
 │ one line: 6 weeks    │ 3 weeks    │ 10 d │ 5d │2d│2d│ 09:51 Mei asked… │
 │ (32 leaves merged)   │ (8 leaves) │ (4)  │(2) │  │  │ 09:52 you said…  │
 └──────────────────────┴────────────┴──────┴────┴──┴──┴──────────────────┘
   coarse summaries ··························· fine summaries   raw events

 open(block)    → the two blocks it was written from, down to raw events
 zoomOut(block) → its parent
 focus(from,to) → any stretch at any resolution, under the same line budget
```

What makes it different:

- **Scopes.** Every event lands in an append-only log keyed by a scope: a person, a group chat, a channel, a team, the global scope. The host registers its scope types and how each behaves. Every row also carries a partition, a wall no read crosses.
- **History that zooms.** Old stretches of a scope's log are summarized into leaves, and leaves are merged pairwise into a tree. Every read renders a fixed number of lines: verbatim near now, coarser in the past, and it never drops the beginning. Which blocks merge follows Taelin's rollback push: the most due pair of sibling blocks merges first, due by how long ago the pair ended in its own size, so old lines stay put as history grows and the change sits at the recent end. Any block opens into the two it was written from, down to the raw entries; any block zooms out to its parent; any stretch can be read at any resolution.
- **Everything is rows.** Activities, summaries and memories live in your database (Postgres reference store, in-memory store for tests), so they are queryable, replayable at any past instant, and shared by every process that runs the agent.
- **Group awareness on the read side.** A message belongs to the run it woke, so other runs see a count line instead of an unanswered-looking ask. Machine noise folds into one counted line per kind, each with a handle that reopens it.

The core is TypeScript with no dependencies and no Node built-ins (it bundles for Node, Bun, edge runtimes and the browser). The bridge to an agent loop is the `./agent` subpath only; it runs on the agent harness `@platform/agent`, a soft fork of pi-mono. MIT licensed.

## Install

```bash
npm install @platform/tidemark
# only for the ./agent bridge:
npm install @mariozechner/pi-ai@0.73.1 @mariozechner/pi-agent-core@0.73.1
```

## Quickstart

```ts
import { createHistory, promptSummarizer, scopedViewer } from '@platform/tidemark';
import { memoryStore } from '@platform/tidemark/stores/memory';

const store = memoryStore();
const history = createHistory({
  store,
  scopes: [{ type: 'person' }, { type: 'group' }, { type: 'ticket', compress: false, inGlobalFeed: false }],
  summarizer: promptSummarizer((system, user) => callYourModel(system, user)),
});

const group = { type: 'group', id: 'garden-club' };
await store.append({ scope: group, partition: 'default', kind: 'message_in', summary: 'Ines asked who can water the north beds' });

// On a schedule (hourly is plenty): leaves and merges share the window until the deadline.
await history.compressOnce({ deadlineAt: Date.now() + 45 * 60_000 });

// What an agent reads.
const viewer = scopedViewer('gardener', group);
const view = await history.view({ select: { scope: group }, viewer });
console.log(view.text);
```

With an agent loop:

```ts
import { historySection, historyTools, memorySection, runScopedAgent } from '@platform/tidemark/agent';

const run = { runId, agentId: 'gardener', scope: group, partition: 'default', reason: 'weekly_digest' };
await runScopedAgent({
  run, runs, model: 'claude-sonnet-5-5', ceilingUsd: 0.5, deadlineMs: 120_000,
  profile: { id: 'gardener', history: { coverLines: 16 } },
  sections: [identity, memorySection(store, { clock }), historySection(history, { viewer })],
  tools: [...historyTools(history, { run, viewer }), ...yourTools],
  input: 'Write this week’s digest.',
});
```

## The zoom API

| Call | What it returns |
|---|---|
| `view({ select, viewer, budget? })` | The cover: raw lines from right after the newest summary that ended before the raw window, then summary blocks back to the first leaf. Nothing older than the window is lost for want of a summary (a leaf still straddling the window's edge, a tail too short to summarize, a scope type that is never summarized): it shows raw, bounded by the token budget. A single scope reads its tree; a multi-scope selection (the feed) reads leaves only, beginning exactly where its oldest kept raw line ends. |
| `open(handle)` | One level finer. A merged block becomes the two blocks it was written from (an unbuilt half opens further, so the span stays whole); a leaf becomes its raw entries; a story becomes its events (in its own scope when a one-scope read printed it); an entry renders in full. |
| `zoomOut(handle, { build? })` | One level coarser. The parent block if it exists; otherwise the halves side by side under a "not yet merged" note, or, with `build: true` and a summarizer, the parent written on demand with one merge call. |
| `focus({ select, from, to, budget })` | Any stretch at any resolution: the leaves in `[from, to)` tiled in at most `coverLines` blocks, finest at the stretch's end, continued as raw entries past the last summary. |
| `search({ select, query })` | Keyword search over raw entries, newest first. It finds what a read folded or withheld. Kind filters run before the limit, and reads page past rows the viewer may not read, so other scopes never starve a result. |

`open` and `zoomOut` are the same primitive as `focus` with fixed arguments (a block's span at two lines, its parent's span at one), so the verbs cannot disagree.

Every handle is checked against the reader's `Viewer` and partition before it opens. A handle into a scope the viewer cannot read returns the same message as a handle that does not exist. Under `asOf`, a handle to anything that had not happened yet does not exist either, and a zoom out never writes.

The model reaches all of it through one tool, `read_history`: no arguments for the cover, `item` to open, `item` with `zoom: "out"` to go coarser, `from`/`to` to focus, `query` to search, `lines` to choose the resolution. A read that cannot be served returns a steering message as the result, never an error.

## Budgets

A budget is per read. It falls back field by field to the agent's profile, then the runtime default.

```ts
interface ReadBudget {
  coverLines?: number;     // blocks the compressed part renders. Default 32.
  maxCoverLines?: number;  // the most any read may render; larger requests are cut to it. Default 96; raise it explicitly.
  tokens?: number;         // ceiling for the whole read. Default 100,000.
  split?: { raw: number; recent: number; older: number };  // percent. Default 50/30/20.
  rawWindow?: { kind: 'age'; ms: number } | { kind: 'tokens' };  // scoped default: 14 days; feed: by tokens
}
```

Raw lines fill from the newest end, by each line's newest event (a story line counts at its last event): when they are over, the oldest drop, never the newest. Summaries keep the beginning instead: a cover over its token budget first renders coarser (fewer, larger blocks, `stats.coarsenedTo`), and only when even the coarsest tiling does not fit are blocks cut, from the middle, oldest after the first, first (`stats.droppedBlocks`, and a note naming the stretch cut). The first block is never cut; when it alone is larger than the budget it renders clipped, keeping its handle and the start of its summary. `view.truncated` says what was cut: `raw`, `older` (summary blocks) or `firstClipped`. A different line budget changes the resolution, not the reach: every cover still starts at the first leaf. Aligned blocks cannot tile every stretch in every count (65 leaves cannot be one block), so below a stretch's minimal tiling the minimal tiling renders and `stats.overLines` says by how much. Nonsense values (NaN, negative, a split over 100) never widen a read.

Invariants, each with a test (`test/history.test.ts`):

1. The cover never drops the first leaf; a missing merge opens into its halves and the span stays whole.
2. Raw and compressed are one continuous timeline: blocks cover exactly what ended before the raw part begins.
3. The feed reads leaves only; merged blocks belong to one scope.
4. Raw lines fill from the newest end and drop oldest first; summaries coarsen, then drop from the middle, and the first block always renders, clipped if it must be.
5. A lens read (`kinds`) includes no blocks: summaries were written over every kind and cannot be re-filtered.
6. The note beside blocks says they are AI-written summaries and that a load-bearing specific must be confirmed by opening down to raw entries.

## Compression

`compressOnce` is safe to stop anywhere and to run twice at once. A leaf covers at most 50 activities older than two hours, never ends inside a run of activities sharing one timestamp, and lands only at the position the run read as next. A merged block lands only in an empty slot and only while both children exist. By default a pass builds every complete block over the leaves that ended before the raw window (`merges: 'complete'`, under one merge per leaf over a scope's life), so any budget and any stretch renders at the resolution asked; `merges: 'cover'` builds only what the default cover needs. Leaves and merges share each pass: merges keep `mergeShare` of its capacity (default 25%: that share of the slots, or the window's last quarter when the concurrency is too small to split), so a leaf backlog cannot starve them; they go oldest incomplete parent first, a few per scope per turn (`mergesPerTurn`), and either side takes what the other leaves unused. `CompressReport.phases` gives each side's time, count and whether its share ran out. A summary call may return `{ text, truncated }`: one that stopped at the model's output limit is a failed call, like an error or an empty reply, so nothing is written and a later pass tries the stretch again; a host whose model reports a stop reason should say so, and count it toward any breaker it keeps. Each summary call also gets `context`: the history before the block being written, as `[days] summary` lines rendered from blocks that already exist (a cover of the scope up to the block's start, at most `contextLines` lines and `contextChars` characters, newest kept first), so the model can resolve references; it is never content to add. A leaf call also gets the window's `activities`, for a host that renders fuller lines than `kind: summary`. The default prompts ask for up to `SUMMARY_LIMIT_CHARS` characters spent by value (people's own words first, then lasting effects and failures, then findings and replies, machine steps last), names and numbers copied exactly, quotes credited to who said them, nothing made to look further along than it was, and nothing the input does not say, because a summary becomes standing context and an invented specific gets repeated to a person later. Hosts pass their own prompts; `leafInput` and `mergeInput` frame a call's user turn.

## Stores

A store implements `HistoryStore` (and optionally `MemoryStore`). Cursors are store-native strings, never JavaScript `Date`s: a Postgres timestamp has microseconds, a `Date` has milliseconds, and a bound read back through a `Date` sits just before the row it came from, so the next window re-reads that row forever. Core code only hands cursors back to the store that minted them.

- `@platform/tidemark/stores/memory`: arrays in memory, for tests and examples.
- `@platform/tidemark/stores/postgres`: `postgresStore(sql, { tablePrefix })`, where `sql` is any `{ query(text, params) }` function (postgres.js, Bun.sql and pg all fit), so the package imports no driver. Every statement is a single statement with no session state, so it is safe behind a transaction-pooling proxy. The DDL ships as `src/stores/postgres.sql` (or `postgresSchema(prefix)`); apply it with your own migrator.
- `@platform/tidemark/stores/convex`: three parts, because only a query or mutation touches the database. `convexTables(prefix)` goes into your `defineSchema`; `convexStore(ctx.db)` is the store inside one function, where a mutation's serializability is what keeps a leaf position or a block slot single; `remoteStore(transport)` is the store from an action, forwarding each call as `(op, JSON args)` to one internal query and one internal mutation you register with `serveStoreOp`. Keep both internal: viewer checks run in the reader, in your action. Needs `convex` (an optional peer).
- `@platform/tidemark/stores/contract`: `storeContract(make)` returns runner-neutral cases every store must pass: appends racing for one leaf position, block inserts only with both children, one block per slot under a race, tie-aware windows, sub-millisecond cursor bounds, as-of bounds, partition walls, legacy numbering, search, memory expiry.

As-of reads are strict everywhere: activities, blocks and memories are visible only if stamped strictly before the instant. A block is stamped twice, by the end of what it summarizes and by when it was written, and needs both before the instant: a summary written afterwards, even over a stretch that had ended, is something the reader did not know yet, so the read shows the finer blocks or raw entries that existed instead. A live memory read uses the next millisecond, so a memory written now is read now.

```ts
for (const c of storeContract(async () => ({ store: myStore() }))) test(c.name, c.run);
```

### Writing a store

A store is any object that implements `HistoryStore` from the package root (and `MemoryStore` if your agents keep memories). Start from `src/stores/memory.ts`, the shortest complete implementation, and `src/stores/postgres.ts` for the SQL. The methods fall into three groups:

- **The log:** `append`, `activities`, `activity`, optional `search`, and `cursorAt(ms)`, which turns an instant into your cursor format.
- **Compression writes:** `backlog`, `leafTip`, `appendLeaf`, `putBlock`, `scopesNeedingMerges`. These two writes carry the concurrency guarantees: `appendLeaf` lands only while the scope's last leaf index is still the one the caller read, and `putBlock` lands only while both children exist and the slot is empty. Do each as one conditional statement or one transaction; two compressors racing must leave exactly one winner.
- **Tree reads:** `treeIndex`, `blocks`, `block`, `blockAt`, `leaves`, `leafHolding`, `activitiesIn`.

Three rules the contract checks hardest: cursors are opaque strings at your storage's full precision (never round-tripped through a JavaScript `Date`); every read honours `asOf` strictly (stamped before the instant, never at it); and nothing crosses a partition. When `storeContract` passes, the history engine works on your store unchanged.

## Example: a group chat

`bun examples/group-chat/main.ts` seeds about two hundred days of a community garden's group chat and private messages, compresses them through pi-ai's faux provider (a scripted stand-in for a model, so no network and no API key), and prints each read. Run it with `bun run example`. Excerpts of its output:

```
# Seeded 3742 activities over 200 days in 6 scopes.
# Compressed: 77 leaves from 3742 activities, 64 merged blocks, 0 failures.

==== 1. The cover of the group chat (12 summary lines; raw lines since the newest summary)
(18 raw lines, 12 blocks, ~1162 tokens)
## Recent Activity
(Lines tagged "(xN) … [story: <handle>]" aggregate routine events; …)
[2026-09-14 08:51] message_in: Mei proposed moving the work day to Sunday
[2026-09-14 08:52] message_out: assistant replied to Mei in the group
[2026-09-14 08:53-08:53] reaction (x3): Mei reacted | Wren reacted [story: s@group%3Agarden-club:reaction|1789375986345|1789375988345]
… 12 more raw lines …
[2026-09-16 10:51] message_in: Tomas asked whether the compost is ready to spread
[2026-09-16 10:52] message_out: assistant replied to Tomas in the group
[2026-09-16 10:53-10:53] reaction (x3): Mei reacted | Kofi reacted | Wren reacted [story: s@group%3Agarden-club:reaction|1789556010280|1789556012280]

## Earlier History (compressed)
(These blocks are AI-written summaries … open it down to the raw entries and confirm it there.)
[block:b:0.66@group:garden-club | 2026-09-02 to 2026-09-06]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Kofi asked whether the compost is ready to spread.
[/block:b:0.66@group:garden-club]

[block:b:0.67@group:garden-club | 2026-09-06 to 2026-09-08]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Ines asked who can water the north beds this weekend.
[/block:b:0.67@group:garden-club]

[block:b:0.68@group:garden-club | 2026-09-08 to 2026-09-11]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Kofi posted a photo of the first beans.
[/block:b:0.68@group:garden-club]

[block:b:0.69@group:garden-club | 2026-09-11 to 2026-09-13]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Mei offered spare basil seedlings.
[/block:b:0.69@group:garden-club]

## Older History (summary)
[block:b:4.0@group:garden-club | 2026-03-01 to 2026-04-15]
From 2026-03-01 to 2026-04-15, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:4.0@group:garden-club]

[block:b:4.1@group:garden-club | 2026-04-15 to 2026-05-30]
From 2026-04-15 to 2026-05-30, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:4.1@group:garden-club]

[block:b:3.4@group:garden-club | 2026-05-30 to 2026-06-21]
From 2026-05-30 to 2026-06-21, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:3.4@group:garden-club]

[block:b:3.5@group:garden-club | 2026-06-21 to 2026-07-14]
From 2026-06-21 to 2026-07-14, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:3.5@group:garden-club]

[block:b:3.6@group:garden-club | 2026-07-14 to 2026-08-07]
From 2026-07-14 to 2026-08-07, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:3.6@group:garden-club]

[block:b:2.14@group:garden-club | 2026-08-07 to 2026-08-17]
From 2026-08-07 to 2026-08-17, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:2.14@group:garden-club]

[block:b:2.15@group:garden-club | 2026-08-18 to 2026-08-28]
From 2026-08-18 to 2026-08-28, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:2.15@group:garden-club]

[block:b:1.32@group:garden-club | 2026-08-28 to 2026-09-02]
From 2026-08-28 to 2026-09-02, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:1.32@group:garden-club]
```

Zoom in, then zoom out from a leaf (the parent is written on demand), then one month at six lines:

```
==== 2. Zoom in: open b:4.0@group:garden-club
(0 raw lines, 2 blocks, ~219 tokens)
## block b:4.0@group:garden-club opened: the blocks it was written from
(These blocks are AI-written summaries … open it down to the raw entries and confirm it there.)
[block:b:3.0@group:garden-club | 2026-03-01 to 2026-03-21]
From 2026-03-01 to 2026-03-21, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:3.0@group:garden-club]

[block:b:3.1@group:garden-club | 2026-03-22 to 2026-04-15]
From 2026-03-22 to 2026-04-15, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:3.1@group:garden-club]

==== 3. Zoom out from the leaf b:0.66@group:garden-club
(0 raw lines, 1 blocks, ~169 tokens)
## block b:0.66@group:garden-club zoomed out
(These blocks are AI-written summaries … open it down to the raw entries and confirm it there.)
[block:b:1.33@group:garden-club | 2026-09-02 to 2026-09-08]
From 2026-09-02 to 2026-09-08, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:1.33@group:garden-club]

==== 4. Focus on May 2026 at 6 lines
(0 raw lines, 6 blocks, ~401 tokens)
## Focus 2026-05-01 to 2026-05-31: summaries
(These blocks are AI-written summaries … open it down to the raw entries and confirm it there.)
[block:b:0.21@group:garden-club | 2026-04-30 to 2026-05-02]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Wren posted a photo of the first basil.
[/block:b:0.21@group:garden-club]

[block:b:1.11@group:garden-club | 2026-05-02 to 2026-05-08]
From 2026-05-02 to 2026-05-08, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:1.11@group:garden-club]

[block:b:2.6@group:garden-club | 2026-05-08 to 2026-05-19]
From 2026-05-08 to 2026-05-19, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:2.6@group:garden-club]

[block:b:1.14@group:garden-club | 2026-05-20 to 2026-05-25]
From 2026-05-20 to 2026-05-25, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:1.14@group:garden-club]

[block:b:1.15@group:garden-club | 2026-05-25 to 2026-05-30]
From 2026-05-25 to 2026-05-30, Ines, Tomas, Wren, Kofi, Mei kept the garden going.
[/block:b:1.15@group:garden-club]

[block:b:0.32@group:garden-club | 2026-05-30 to 2026-06-02]
50 messages; Ines, Tomas, Wren, Kofi, Mei took part. It began when Mei reported aphids on the beans.
[/block:b:0.32@group:garden-club]
```

Two budgets over the same history, both reaching day one:

```
==== 5. Budget of 24 lines: 24 blocks (~1127 tokens of summaries), reaching back to 2026-03-01
leaves per block, oldest to newest: 8 8 8 4 4 4 4 4 2 2 2 2 2 2 1 1 1 1 1 1 1 1 1 1

==== 5. Budget of 4 lines: 4 blocks (~191 tokens of summaries), reaching back to 2026-03-01
leaves per block, oldest to newest: 32 32 1 1
```

An agent run where the model zooms by itself:

```
==== 6. An agent run that zooms by itself
context sections (tokens): {"identity":12,"memory":25,"history":1162}
assistant: Checking the oldest stretch first.
assistant calls read_history({"item":"b:4.0@group:garden-club"})
tool result: ## block b:4.0@group:garden-club opened: the blocks it was written from …
assistant: Digest: the group has been active since March; the opened stretch shows 2 summaries.
run recorded: 3 rows, ended done
```

## Roadmap

- **v0.2, durable work.** Tasks with due dates and recurrence, waits that wake their agent, wake reasons with dedup and coalescing, a scheduler port (pg-boss and Convex adapters), run liveness and superseding silent runs, the working set, guards that shape the toolset and steer rather than refuse.
- **v0.3, channels and audience.** A channel adapter contract (normalize inbound, send through a counted guard chain, report a conversation's members), leases so one inbound dispatches once, and audience rules: a private fact is provided only in a one-to-one conversation, and a read error counts as a group.
- Later: offline memory distillation, a Convex store.
