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

**On the map.** `web/lib/line/loopSteps.ts` builds the loop's front half from
the record: expectations, observe (codecast extractors), judge (codecast
judges, and one product-supplied step per judge a product's findings name),
problems (grouping), and the line. Each step carries its kind, where it runs,
its version, its health and its decisions (findings, judge runs, grouping
choices). The line workspace draws them as the Find band above the Graph
(`components/line/workspace/FindBand.tsx`): expectations first, then the
judges under a header for where they run ("In Union", "Here") and the
reports people file, then "grouped in codecast", and a footer naming the fix
line each waiting problem goes to. A step's card shows where it runs, its
version, its health and its recent decisions, each opening what it judged.

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

**How bring findings is built.** A finding filed with an issue key (`cast
signal add --issue <key>`, or `issue` on `/cli/signal/add`) reaches only the
problem whose `cause.issue_key` is that key, following merges, and opens it
when there is none. `cast signal merge --issue A --into B` makes A an alias of
B and folds A's open problem into B's; `cast signal split --from A` opens the
new issue's problem and notes the split on both. The problem page lists its
findings by judge, each with a link back to where the product shows it.

**When problems start.** Codecast's start switch, one per project: the role
that leads the project carries it (`caps.line_on`) and its slot count
(`caps.cards`), and it counts only while that role's own switch is on
(`roleAutonomy.lineStartsOn`). The sweep runs every few minutes and starts
ready problems up to the free slots, counting a role's in-flight runs by the
role they carry. A line that is off starts nothing. The switch sits in the
line workspace header and on the project's Line tab, and says what turning it
on starts and at what pace before it changes anything.

**Customer words.** A product's findings may quote its customers. Until a
person decides how that text may live in codecast (decision sd-555), a problem
whose findings come from a product shows each finding by its judge and its
link back, hides the problem's description with a link to read it in the
product, and shows each line run comment as its plain outcome
(`loopSteps.problemQuotesCustomers`, `heldCommentWords`). The text is stored
as the product sent it.

## LL4. Codecast can write the product's parts

The product-specific pieces are judges, moment extractors and event calls.
Whichever side runs them, codecast's coding sessions can write and improve
them, with full access to the product's repo, its read-only data and its tools:

- **Set up judging.** For a new project, one session drafts the expectations, judges and (for moments) extractors. It runs them on yesterday's data and brings one card: here's what it would have found, here's what it costs.
- **Improve a judge.** When a finding is marked wrong, a short diagnosis asks one question: was the needed fact missing from what the judge saw, or present and misread? That opens a problem against the judge or the extractor. The line fixes it like any change: the wrong cases become its test, it runs evals before and after, and you get one card.

In "bring findings" mode the judge lives in the product's repo, and the change
is an ordinary product change made by a codecast session. In "bring moments"
mode it lives in codecast. Either way, the loop improves its own senses.

**How it is built.** Both start one session from the line workspace, through
`startJudgingSetup` (`web/lib/line/setupJudging.ts`): "Set up judging" sits in
the workspace header and where the judges would be in the Find band when a
project has none; "Improve this judge" sits on a judge's card in the Find
band and carries the findings people marked wrong, and turns primary once one
is marked. Each button says what the session will do before it starts. The session starts in the checkout and on
the machine that published the project's line profile, through the web's one
spawn route. Its pass is one prompt, `cli/src/judgingSetup.md`, which `cast
line judging [--judge <name>]` prints for the project, so the session reads
the same words wherever it was started. The pass decides which way the
product plugs in from the record, proposes missing expectations through the
expectations path, drafts or reviews, and tries its drafts on real recent
data. `cast line judges try <judge> <moment.json>...` runs a draft judge
exactly as LL8 builds the call, on the team's budget, and, when the budget is
off, names the most one call can cost. The pass ends with one card that says
what turning on does. It never copies a customer's words into the report or
the card.

## LL5. Phases for Union

1. **Union brings findings.** AgentWatch keeps judging and grouping. Each AgentWatch issue is one codecast problem, by its key `union:cluster:<id>`, filed with the finding's own judge and its severity (`backend/src/lib/agentWatch/clusterSignal.ts`). A cluster seeded by an evicted finding files with `cast signal split --from` the issue it left; a merge (`mergeClusters`, or a dissolve that empties its source) queues `cast signal merge`.

   Union no longer keeps a second work record:
   - `line/agentwatch.cast` reads the issue from the problem's key and claims nothing; the bind, stamp, finish, rule and release commands are gone from `backend/scripts/line.ts`;
   - the planner's starts, claims, campaign switch and its routes are gone;
   - the admin page reads work, runs and cards from codecast and shows codecast's start switch;
   - attempt records remain only for attempts parked before the line, and nothing writes new ones.

   Codecast's start switch decides when problems start (LL3). A finding marked wrong opens a problem against the AgentWatch judge or the builder of its input (LL11), fixed by a codecast session in Union's repo.
2. **One judge moves to moments, in shadow.** Union's repo holds the comms judge's codecast twin (`.codecast/judges/comms.md`, `mode: shadow`) and its extractor (`.codecast/moments/contact-conversation.ts`). The comparison runs on the host (`~/.local/share/codecast/moments-shadow/union-comms-shadow/`): it replays contacts through the extractor and the judge, compares the findings with AgentWatch's, files nothing and writes nothing to Union. Union's backend posts no moment events yet.
3. **Judges move one at a time.** When a judge's shadow run matches or beats it, its file turns `mode: live` (LL8), and Union deletes its version of that judge.

## LL6. The words people see

Expectation, finding, problem, change, decision, outcome. "Signal", "cause",
"cluster" and "fingerprint" are plumbing and never appear in the product.

How it is built: the data keeps its names (the `signals` table, `task.cause`,
the `causes` and `signals` map node ids, `cast signal` and its `--fingerprint`
flag, the `cause_reopened` notification type), and every word a person reads
maps onto the vocabulary. A signal is a finding (a report, when counted on a
problem), a cause task is a problem, a fingerprint is a finding's key ("groups
by" in line settings), and the investigation's mechanism is "why it happens".
This covers web copy, toasts and errors, task notes the line writes, push and
inbox notifications, the change card page, gate options, the card writer's
facts, CLI help and output, and Union's admin page, where an AgentWatch issue
reads as a problem. Ordinary English stays ("what causes it", "root cause" in
marketing), as does a product's own key name shown from its settings
(`aw:<cluster>` reads "Aw cluster").

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

## LL11. Improving a judge

LL4's "improve a judge", as built (`convex/judgeReview.ts`,
`shared/contracts/judgeReview.ts`, the shipped `judge-review` graph).

- **A finding is marked wrong** in one of two ways. A person presses "Mark
  wrong" on it, on the problem page or on its judge's card in the Find band;
  that label is the workspace's own (`labelDecision`, line-workspace.md LW3),
  and its write (`judgeReview.labelFinding`) calls `findingLabeled`. Or a line
  run's proof finds the system behaved well and the judge scored it as a
  break: prove writes `judge-defects.json` (each finding by its signal id, and
  one sentence saying what a correct judgment of that moment does), and the
  dissolve station hands it to `cast signal judge-defects`. The finding stays
  on the problem it was filed on and gains a `judge_review`: who or what
  found it wrong, their words, and where its diagnosis stands.
- **A short diagnosis answers one question.** The line that leads the
  finding's project runs the `judge-review` graph for it, with the finding as
  its goal: one session (`line/diagnose.md`) reads the finding, what the
  judge was shown (the moment a codecast judge read, or the input a product
  recorded for its own judge, reached from the finding's link and the
  product's read tools) and the product's records of the event, and answers
  whether the fact a correct judgment needed was **missing** from what the
  judge saw or **present and misread**. It may also answer **upheld**, when
  the records show the finding was right after all; then no case is filed
  and the finding's problem hears why. The answer, the fact and the evidence
  are kept on the finding. The diagnosis is a hand of that role, so it
  starts only while the line's start switch is on and its hands last; until
  then the finding says what it waits on, and a sweep every five minutes
  starts it, retrying a run that ended without an answer up to three times.
- **The answer files a case.** misread files against the judge's prompt;
  missing files against what fed the judge: the extractor of the moment's
  kind (bring moments) or the product's builder of the judge's input (bring
  findings). The case is a signal of its own (`case_of` names the finding)
  under one issue key per part (`judge:<home>:<judge>`,
  `judge-input:<home>:<judge>`, `extractor:<source>:<kind>`), so every case
  against one part gathers into one problem, titled for that part, in the
  finding's project.
- **That problem runs on the project's line like any change.** Its cases are
  its misses, each with the sentence a correct judgment meets: prove shows
  them failing today, the builder edits the judge's prompt, its input
  builder or the extractor in the product's repo, eval compares the judge's
  case set before and after through the project's eval command, and a person
  gets one card.
