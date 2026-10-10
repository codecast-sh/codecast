# The learning loop

How a product learns from what happens to it. One model, any product, with the
product doing as much or as little of it as it wants. Sections are LL1 onward.

## LL1. The loop is one graph

```
expectations ─► observe ─► judge ─► problem ─► fix ─► decide ─► ship ─► watch
     ▲                                                                   │
     └──────────────── what the loop learns about itself ◄───────────────┘
```

Each step is a node in a codecast graph, the same engine the line already
runs on. A node is one of three kinds:

- **an agent session**, which reads and writes code and data;
- **a model call**, one prompt and one answer, cheap enough to run thousands of times a day;
- **a script**.

A step can also be **supplied by the product**: the product does that step
itself and hands codecast its result. Codecast treats a supplied step and its
own step the same way. They're versioned, measured and shown on the map, with
their results traceable.

## LL2. The objects

| Object | What it is |
|---|---|
| **Expectation** | One sentence about how the product should behave, quoted from where a person said it. Versioned. |
| **Moment** | One thing that happened, frozen with what's needed to judge it. Optional: only when codecast judges. |
| **Finding** | Something that broke an expectation: what, how bad, a quote, a link to where it happened, and which judge (and version) said so. |
| **Problem** | Findings with one root cause. The only unit of work. |
| **Change** | One attempt to fix a problem, with proof that it failed before and passes after. |
| **Decision** | A question to a person, with an owner they can talk to. |
| **Outcome** | After ship: the problem stayed fixed, or came back. |

Every object has one home, and every result names the version of the step that
produced it.

## LL3. Two ways to plug in a product

**Bring findings.** The product watches itself: it runs its own judges and
groups findings into issues. It sends codecast one problem per issue, with the
issue's findings, and keeps the issue's id as the problem's key. From there,
codecast runs everything else: admission, the fix, your decision, ship, watch.

**Bring moments.** The product sends a one-line event when something worth
judging happens. Codecast pulls the moment, judges it and groups the findings
itself. The product only gives access: its repo, a read-only copy of its data,
and its commands.

Both modes end in the same problems, the same line and the same map. A product
can start with findings and move one judge at a time to moments.

## LL4. Codecast can write the product's parts

The product-specific pieces are judges, moment extractors and event calls.
Whichever side runs them, codecast's coding sessions can write and improve
them, with full access to the product's repo, its read-only data and its tools:

- **Set up judging.** For a new project, one session drafts the expectations, judges and (for moments) extractors. It runs them on yesterday's data and brings one card: here's what it would have found, here's what it costs.
- **Improve a judge.** When a finding is marked wrong, a short diagnosis asks one question: was the needed fact missing from what the judge saw, or present and misread? That opens a problem against the judge or the extractor. The line fixes it like any change: the wrong cases become its test, it runs evals before and after, and you get one card.

In "bring findings" mode the judge lives in the product's repo, and the change
is an ordinary product change made by a codecast session. In "bring moments"
mode it lives in codecast. Either way, the loop improves its own senses.

## LL5. Phases for Union

1. **Union brings findings.** AgentWatch keeps judging and grouping. Each AgentWatch issue is one codecast problem, by its id. When Union merges or splits issues, codecast follows.

   Union deletes everything that duplicated the work record:
   - attempts and claims;
   - the planner and campaign switch;
   - the bind, stamp, finish, rule and release scripts.

   Codecast's start switch decides when problems start, per project. Wrong findings open problems against the AgentWatch judge, fixed by codecast sessions in Union's repo.
2. **One judge moves to moments, in shadow.** Union emits events next to its comms judge. Codecast extracts, judges and compares, without filing anything, until it matches or beats AgentWatch.
3. **Judges move one at a time.** When a judge's shadow run matches or beats it, codecast's version takes over, and Union deletes its version of that judge.

## LL6. The words people see

Expectation, finding, problem, change, decision, outcome. "Signal", "cause",
"cluster" and "fingerprint" are plumbing and never appear in the product.

## LL7. Moments: event, extractor, storage

A product that brings moments posts one line through its ingest source (the
same door errors and deploys use, `POST /cli/ingest/<key>`):

```json
{ "type": "moment", "kind": "conversation", "subject": "thread_81", "at": "2026-10-09T14:00:00Z", "refs": { "message": "m_9" } }
```

- **Kept and coalesced.** Each event lands on the one waiting moment of its
  kind and subject (`moments`, `mo-N`), which waits for the kind's quiet
  window after its newest event. A burst of messages in one conversation is
  judged once, on its newest state. An event that arrives while its moment is
  being extracted opens the next moment.
- **The extractor is the product's code.** `.codecast/moments/<kind>.ts` in
  the product's repo reads the product's own read-only data and prints one
  moment as JSON: blocks (a message with its direction, channel, time,
  sender, body and delivery state; facts as label and value; free text) and
  refs back to the product's rows. Its opening comment lines set its quiet
  window and timeout (`// quiet: 10m`, `// timeout: 90s`). The shape and the
  checks are `shared/contracts/moments.ts`.
- **It runs where it was published.** `cast line moments publish --source
  <name>` sends a checkout's extractors and judges, each at its file's git
  blob sha, and names this machine as the one that runs them. Its daemon
  claims due moments every minute (`/cli/moments/claim`), runs each extractor
  in the checkout the way a line station runs a script (its own process, the
  checkout as working directory, the event on stdin, a timeout), and hands
  the output back (`/cli/moments/complete`). The moment records the
  extractor's version and the gap between its last event and the extraction,
  which the judge is told.
- **Storage is a person's choice.** A moment can carry customer
  conversations, so its body stays on the extractor's machine
  (`~/.local/share/codecast/moments-shadow/`, 30 days) unless a person sets
  the source's moment storage to codecast (`cast sources set <name>
  --moment-storage codecast`). Then the body is kept 30 days in R2, beside
  replays and under the same lifecycle rule, and the row points at it. Either
  way the row holds only what indexes it, and a host-kept body reaches the
  server only in hand, to be judged, and is never written there.

## LL8. Judges and the call node

A codecast judge is a model call step: one prompt, one answer, no tools.

- **The file.** `.codecast/judges/<name>.md`, a header between two `---`
  lines, then the prompt. `moment` names the kind it reads, `projects` the
  projects whose expectations it grades against; `model` (the cheap model),
  `max_tokens` (2000) and `mode` (`shadow`) have defaults. Parser:
  `shared/contracts/judges.ts`.
- **One run.** For each moment of its kind, the judge reads the clock and
  how stale the moment's facts may be, each project's active expectations at
  their current version, and the moment's blocks, fenced as data. Codecast
  appends the output contract to its prompt, so every judge answers the same
  way: deviations, each with the expectation id it breaks, a severity from 1
  to 10, what happened, the quote that shows it, and markers. A deviation
  citing an id the brief does not list is set aside, not filed.
- **Its decision.** Every run is a `judge_runs` row: the judge, its version,
  the moment, the expectations versions, the findings, the cost, and why it
  failed or was skipped. That row is the judge step's decision, which the
  line workspace labels right or wrong. A `shadow` judge stops there. A
  `live` judge also files each finding through the signal door, as the
  person who set the source up, into the project holding the expectation it
  cites, carrying its judge, version, severity and moment.
- **The same call, everywhere.** `convex/modelCalls.ts` is the one place a
  model call is made for a product's loop: a judge, grouping, and a graph's
  **call node** (`shape=note` in a `.cast` graph, with `prompt`, `model`,
  `max_tokens`, `system` and `output`). A call node's prompt is its own words
  with `$vars` expanded and nothing appended; its answer lands under
  `<node>.output` and `<node>.json` and its cost on the run's node. The
  session node (`shape=tab` and `box`) still runs a full Claude Code session.
  No call starts a session, so thousands a day stay cheap.

## LL9. Grouping by what happened

A finding from a codecast judge says in words what happened, against which
expectation. Grouping embeds those words (`lib/embeddings.ts`) and searches
the findings of the same expectation in the same workspace (`signal_vectors`,
a Convex vector index) for the open problems they reached. One close enough
(cosine at or above 0.86) joins it outright, and the finding reads as joined
because it said what that problem's findings said. Near ones (0.6 and up)
go to the attach judge, which decides as it does for any signal. None opens a
new problem, when the judge's source is declared to open them. The
thresholds are `GROUPING` in `convex/findingGroups.ts`.

A product that brings findings keeps its own issue keys, and an issue is
exactly one problem (LL3); grouping never touches it.

## LL10. The team's model budget

Judging, grouping and call nodes draw from one monthly budget per team, set
in the team's settings (or `cast line budget --set <usd>`) by a team admin.
Each call reserves its worst case first and settles what it cost after, by
purpose. At $0, the default, nothing that needs it runs: a judge's run is
recorded as skipped, grouping falls back to the finding's key, and a call
node fails with the reason. The team settings show the month's spend against
the cap, where it went, how many calls were skipped, and earlier months.
