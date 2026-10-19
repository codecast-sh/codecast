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
own step the same way. They're measured and shown on the map, with their
results traceable, and versioned whenever the side that runs them names a
version (Union's AgentWatch judges send none yet).

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
produced it when that step has one: codecast's judges and extractors by their
file's blob sha, expectations by their document's number.

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
(`roleAutonomy.lineStartsOn`). The sweep runs every two minutes (`orgLine.sweep`) and starts
ready problems up to the free slots, counting a role's in-flight runs by the
role they carry. A line that is off starts nothing. The switch sits in the
line workspace header and on the project's Line tab, and says what turning it
on starts and at what pace before it changes anything.

**Customer words.** A product's findings may quote its customers. Codecast
keeps them as the product sent them, with no retention limit (decision
sd-555), and shows them wherever the finding, its problem and its runs show.
Reports published as pages go behind a password.

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

   Union's line no longer keeps a second work record, with one part left:
   - `line/agentwatch.cast` reads the issue from the problem's key and claims nothing; the bind, stamp, finish, rule and release commands are gone from `backend/scripts/line.ts`;
   - the planner's starts, claims, campaign switch and its routes are gone;
   - the admin page reads work, runs and cards from codecast and shows codecast's start switch;
   - attempt records remain: `createAttempt` (`backend/src/lib/agentWatch/remediations.ts`) still has two callers, an agent tool (`lib/agent/tools/issueTools.ts`) and the clusters route, and the regression triage still requeues attempts.

   Codecast's start switch decides when problems start (LL3). A finding marked wrong opens a problem against the AgentWatch judge or the builder of its input (LL11), fixed by a codecast session in Union's repo.
2. **One judge moves to moments, in shadow.** Union's repo holds the comms judge's codecast twin (`union-mobile/.codecast/judges/comms.md`, `mode: shadow`) and its extractor (`union-mobile/.codecast/moments/contact-conversation.ts`). The comparison runs on the host (`~/.local/share/codecast/moments-shadow/union-comms-shadow/`): it replays contacts through the extractor and the judge, compares the findings with AgentWatch's, files nothing and writes nothing to Union. Union's backend posts no moment events yet.
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
  being extracted opens the next moment. Events join by their own times: an
  event joins a waiting moment only when it falls within the quiet window of
  that moment's events, so a replay of history or a late batch keeps apart
  what happened apart (`packages/cli/scripts/agentwatch-replay.ts` replays
  Union's judged history this way, `refs.as_of` set to when AgentWatch read
  it).
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
  --moment-storage codecast`). Then the body goes to R2 beside replays and
  the row points at it. How long it stays is the source's retention
  (`--moment-retention`): 30d by default, under `moments-30d/` where the
  bucket's 30 day rule deletes it, or keep, under `moments/`, which no rule
  touches, so a finding's evidence lasts as long as the finding (sd-555).
  Setting keep also lifts the expiry of the source's bodies already under
  `moments/`; a body already under `moments-30d/` still goes at 30 days,
  and going back to 30d applies to bodies stored from then on. Either
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
  how stale the moment's facts may be (an extractor that read as of an
  earlier time says so in its `at`, and the clock is then that time), each project's active expectations at
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
  cites, carrying its judge, version, severity and moment. Its key is its
  evidence (the moment's subject, the expectation, the quote): a conversation
  is judged again each time it moves and still holds its old messages, so the
  same words breaking the same line file once, and a later moment's repeat
  stays on its judge run only (`findingKey`).
- **What a finding stands on.** One message shows in several moments (a
  contact's conversation and each match of it), and each is judged on its
  own. A finding records the moments whose newest run of its judge files it
  (`signals.held_by`); a run that finds an existing finding again, at its
  judge's current version, lists it on the run (`judge_runs.held_ids`) without
  filing it again. A run that lets one of its moment's earlier findings go
  drops that moment, and the finding leaves its problem only when no moment
  is left (`judgeRetire.settleRun`, where every live run lands: publish,
  `retry --again`, `rejudge`). `judgeRetire:sweepStanding` (run.sh) checks
  every live finding against its moments' newest runs and retires the ones
  none of them files.
- **A resample is not news.** A judge is a sampled model call. When the same
  judge version reads the same messages of a moment again, one read that
  differs from the others moves nothing in either direction: a finding it
  misses stays until 2 of the last 3 reads miss it (`judgeRetire.ABSENT_OF`),
  and a finding only it made waits on its run (`judge_runs.waiting`) until 2
  of the last 3 reads make it (`judgeRetire.newOnResample`), so a held finding
  is not replaced by another line's reading of the same words on one sample.
  A read is the judge's answer at once when what decides it changed: the
  judge's version, the line's words, the messages, or the facts of the lines a
  re-read names (`--lines`).
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
because it said what that problem's findings said. Near ones (0.45 and up;
two findings of one plain miss score 0.41 to 0.89 because each tells one
person's story)
go to the attach judge, which decides as it does for any signal. None opens a
new problem, when the judge's source is declared to open them. The
thresholds are `GROUPING` in `convex/findingGroups.ts`.

A finding a newer judge withdrew keeps its embedding and still speaks for the
problem it was on (`retired.task_id`), as long as that problem is open: a
problem in review whose findings were all withdrawn keeps its card, and what
reads the same joins it rather than opening a problem beside it. Most of an
expectation's findings end up withdrawn over a few re-judges, so the search
reads 64 nearest findings, not a handful. `signals:regroupProbe` (run.sh)
shows where grouping would put findings already filed, without moving them.

Before any of that, a finding that quotes a written message joins the
problem already holding that message under another expectation
(`signals.ts messageCause`, attach `message`). One email is one template's
output, so every rule it broke belongs with the problem whose fix rewrites
that template. A call holds many answers, so call findings never group this
way. Only a sibling that still stands counts: one withdrawn, merged, marked
wrong, or filed by an older version of its judge (about to judge the moment
again, which may withdraw it) never pulls a finding in.

A problem a line dissolved still takes the findings its reason answers:
those from before the fix it named went live (`cause.dissolved.fixed_at`,
which `cast line dissolve` reads from the newest named commit on main, or
`--fixed-at`), else from before the close. A finding from after the fix
reopens the problem with its date as the evidence the fix did not hold,
whether grouping, a move or a merge brought it there. A closed problem never
holds a finding its reason does not answer.

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

A source can move its judges off the budget: `cast sources set <source>
--judge-on subscription`. Its judge calls then run on the Claude Code login
of the machine that hands the moment in (`cli/src/subscriptionCall.ts`: the
same system prompt, user message and model, no tools, one turn, under a
private config dir so no transcript reaches the inbox). The server builds
each request as before and hands them back with the moment
(`JudgeHandoff`); the daemon runs them and posts the replies to
`/cli/moments/judged`, which records them through the same path an API reply
takes (`momentJudging.settleJudge`), with `backend: "subscription"` on the run.
`cast line moments rejudge`, `cast line judges try` and the judge-fix A/B
(`base`, `ab`) follow the source's setting, or `--on api|subscription`.

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
  under a key of its own, the part and the finding
  (`judge:<home>:<judge>:<sg>`, `judge-input:<home>:<judge>:<sg>`,
  `extractor:<source>:<kind>:<sg>`), and opens a problem titled with the
  part and the line it ruled on. Grouping then folds that problem into the
  open case problem with the same fix (`judgeReview.groupCase`): the attach
  judge reads the new case by what hid its fact (its part and the why
  under the fact) against each candidate's cases (moment, part, line, fact,
  why), and only problems whose cases all fault the same kind of part
  (prompt, input, extractor) are candidates. Neither the part nor the line
  is the fix: keyed by part, one problem held a truncated email, a timing
  gap and an apology ruling; keyed by line, one problem held a prompt rule,
  two history folds and a missing operator note, while one misread fee lane
  opened a problem per line (pl-882, 2026-10-12). Measured on the 18 live
  cases filed in order (`judgeReview.simulateCaseGrouping`, 8 runs): the
  prompt, history-fold and operator-note groups form 8/8, two cases of one
  match-extractor call fold join 8/8 (1/8 when the case was titled by the
  finding the judge got wrong), one email's fee lane ruled on two lines
  joins 7/8, and five pairs that need different fixes stay apart 8/8.
- **That problem runs the judge route, never the product's change line.**
  A problem is a judge problem when every key it gathers is a case key
  (`isJudgeProblem`, shared/contracts/judgeReview.ts). Its fix is a judge's
  prompt, the extractor of its moment, or the expectation it grades against;
  nothing in the product changes, no repro test enters the product's suite,
  and it is never closed as "the judge was wrong", which is what it is about
  (`cast line dissolve --kind judge_defect` refuses it). The route
  (the trial's `outreach/line/agentwatch-trial-judge.cast` in Union):
  `cast line judges arm` lays out the cases and an edited copy of
  `.codecast` (judges and moments copied, the rest of the checkout linked so
  an extractor's relative reads resolve); a session decides where the fix
  belongs and edits the copy, or names the expectation proposal it waits on,
  the open judge problem it merges into, or the records that show the
  findings hold. Before any of that, `cast line judges base` judges each
  ruled case with what is published, five times: a case filed again at most
  once in five is a draw the judge does not repeat, and no fix can separate
  from it, so it leaves the cases; when every case is one, the problem
  closes dropped (`cast line dissolve --kind draw`, the counts as its note)
  with no fix and no card. `cast line judges ab` judges every ruled case and ten
  moments with live findings of the same judge on both sides, five times
  each, on the team's budget (a changed extractor re-extracts both sides
  from the product's data). A ruled case is one message under one line,
  however many moments show it (the others ride on it as twins), and a run
  counts as still finding it only when it files that line on that message.
  It passes only when the ruled cases separate
  (one-sided Fisher, p <= 0.05) and the kept findings do not drop. Its card
  (`judge_fix`, shared/contracts/judgeFix.ts: the change, the two before and
  after rates, the edited lines, the cases the edit moves and those it does
  not) goes to the project's reviewer,
  in the trial page's tooling lane, never the executive queue. Publish puts
  the copy's files into `.codecast`, runs `cast line moments publish`,
  judges the ruled moments again and closes the problem with when the fix
  went live, so a later finding reopens it.

## LL12. Trial projects

A trial runs the whole flow for real beside the live one, and stops at the
decision card (`convex/lineTrial.ts`).

- **The project.** `projects.line_trial` (`cast line trial on --project <ref>
  --graph <file>`) makes a project a trial and names the graph its runs start
  and the checkout they start from. Its expectations are seeded by copying
  another project's lines: a proposal whose every line is word for word a line
  another project in the workspace holds now, citing that line's id, applies
  on its own, since that project's person already applied those words.
- **Two routes.** `--judge-graph <file>` names the graph a problem of cases
  against a judge starts instead (`line_trial.judge`, with the graph's name).
  `cast line trial run` and the dispatcher pick the route from the problem
  (`lineTrial.routeOf`); the dispatcher copies the newest run of that route's
  graph, and a problem whose last run took the other route is due again.
- **A gate is its station's decision, in the trial's stack.** A trial run
  asks a person once, at the end: the run's Present station (`card_write`,
  Union's `agentwatch-trial/card.md`) reads what the run made and, as its last
  act, posts the decision itself with `cast decide`: its own question; a
  context that is the sweet spot (its answer and why, what changes for
  contacts, one real conversation before and after in the words actually
  sent, with a `union:conversation/<contact>@<time>` view beside the quote,
  the behavior change in plain words, proof in a line, risk); the full
  proposal as `--report`; and the answers it judges right. The gate names the
  station (`asker=`; the judge route's review page likewise). An answer that
  starts with Ship or Drop records it; any other answer, a typed note
  included, goes back to the build as the person's note (the gate's
  `outcome = success` edge). A station of a trial run (a session nested under the
  run's primary conversation) is noticed by the decision rail
  (`lib/trialDecision.ts`): its decision is flagged `trial`, bound to the run's
  task, filed in the trial's one stack (`line_trial.stack_id`), and reaches no
  queue, inbox row, ladder, digest or learned decision. `pauseAtGateCore`
  hands a trial run's gate to `lineTrial.askTrialGate`, which adopts that
  decision and maps its options onto the gate's edges by the gate's own words
  (`lib/gateChoices`), or, when the station posted none, asks from its session
  (else the run's) on the same terms; an earlier post on the problem the run
  moved past is withdrawn. A `trial_cards` row (`tc-N`) indexes the decision
  by run, node and task (`decision_id`) and holds the facts the line checked
  (the change, proposal or judge-fix card), which the review page (`/trial`,
  `components/trial/TrialReviewPage.tsx`) shows as a compact strip
  (`TrialFactsStrip`) beside the session's page; the question, options, page
  and answer are read from the decision, and the session is one click away to
  talk it over. Its answer, from the page, the stack, the session's thread or
  `cast line trial answer`, rides the decision rail to the run. An agent
  session may answer an earlier gate from the CLI, recorded as a stand-in, so a
  run can reach its card; the change card is a person's answer only.
  `cast line trial rerun --reask` asks such a gate again from its station,
  which writes its decision anew. Cards from before keep their own question,
  options and answer.
- **An expectation proposal is a station's trial decision too.** A station
  that runs `cast expectations propose` in a trial project (the judge route's
  Fix, when the fix is the expectation line) asks the proposal itself, with
  `cast decide --proposal xp-N` (its own question, answers and page, the-line-model.md
  LM5), on the same rail: flagged `trial`, bound to the
  run's task, routed as that run's other decisions are (the judge route's
  decider, else the trial owner's practice answer), and filed as a
  `trial_cards` row on the station's node (also when another session re-asks
  it: it routes and files as the station that proposed it), so it is in For you with the run's
  other trial decisions and on the review page under Our tooling. It was
  asked off any gate: no later gate of the run closes it, and its answer
  applies or drops the proposal without moving the run
  (`lineTrial.answerTrialDecision`). The run can wait on it as on any
  decision (`cast task dep --blocked-by sd-N`). A trial proposal from a
  session that is no station of a run in that trial asks nobody and waits on
  the review page's Our tooling lane.
- **Nothing ships.** The trial graph has no push, merge or watch station, its
  card's answers end at nodes that record them, `orgLineMerge.check` refuses a
  trial run's merge whatever graph it runs, and the role sweep never starts a
  trial problem (`cast line trial run <ct-N>`, at most ten running:
  `TRIAL_RUNNING_CAP`).
- **Every run proves against unfixed code.** The line names a task's
  worktree, branch and run directory after the graph and the task, so a
  second run on a problem would land on the first run's branch, fix and all,
  and red would pass. Before a trial run starts, the earlier branch, the work
  its worktree left uncommitted and its run directory are set aside under
  `<slug>-before-<stamp>`, and a new worktree starts from origin/main
  (`cli/src/lineTrialBranch.ts`).
- **A failed run is a row of its own.** `lineTrial.runs` (store key
  `trialRuns`) is each trial problem's latest run; the page's Failed list
  shows the station it stopped at and why, with a rerun that queues the same
  graph on the machine that ran it (`lineTrial.rerun`), flagged
  `fresh_branch` so its runner sets the earlier branch aside first. A run
  that died waiting at its own card (its gate ended with no answer, so the
  runner found no edge out: `lineTrial.gateLossOf`) is not rerun from main:
  the same run picks up at that gate from its checkpoint, the card is asked
  again from the proposal and proof it already made, and a station the graph
  file has since put before the gate is made first (cli `runResume.ts`
  `unmadeBefore`). The dispatcher picks such runs up before it starts any,
  and a pick-up spends no run of `max_runs`. Every rerun, from the page or
  `cast line trial rerun`, goes through the dispatcher's own check
  (`trialRoom`): ten running at most, the spend cap, and the run limit for
  a new run.
- **A waiting run continues on current stations.** A runner holds the graph
  it parsed (every `@file` prompt inlined) and its own code for as long as its
  gate waits. When the gate is answered and either changed on disk since the
  runner started (`runResume.ts runnerStamp`), it hands the run to a fresh
  `cast workflow run-daemon`, which resumes at the answered gate and reads the
  graph file again (`daemonGraph.ts`, on any resume). `cast line trial
  restart` stops the runners already waiting on older code; the daemon's
  sweep resumes each at the same card (a waiting trial card counts as an open
  gate, `gate_card`), and `cast line trial rerun <ct-N> --reask` asks a
  waiting card again on current stations.
- **What it costs.** `lineTrial.spend` (`cast line trial`, the page's header)
  reports two kinds that never add. Billed money: the team's model budget by
  purpose since the trial began, the money billed outside codecast (`cast
  line trial spend add --billed-by <key>`, grouped by that key; the same
  amount and words within an hour is refused as a repeat unless `--force`,
  and `spend rm <at>` takes an entry back), and any line-run session on a
  metered provider key. Subscription use: the line runs' Claude Code and Codex
  sessions, which run on the machine's logins and bill nothing; their tokens,
  their API list price as an equivalent only, and the quota of the accounts
  they run on (the usage snapshots each machine reports, the source `cast
  usage` reads). The dispatcher's `cap_usd` limits billed money; quota at the
  `cast usage` warning line (85%) holds runs (`lineTrial.trialRoom`).

## LL13. Closing a problem without a fix

Most problems dissolve, and how a dissolution closes is what the record says
happened. `cast line dissolve <ct-N> --kind <k> [--into <ref>] -m <note>`
(`signals.dissolveForCli`) closes by what the station argued, never `done`
whatever the reason:

- `judge_defect`: dropped. The station filed the judge's defects (LL11);
  nothing in the product was fixed. Refused on a problem of cases against a
  judge: that problem fixes the judge (LL11's judge route).
- `known_cause --into ct-N`: merged into that open problem. Its reports move
  there, it is dropped as the duplicate, and what waited on it waits on the
  survivor (the same fold an issue merge does, LL3).
- `in_flight --into ct-N`: stays open, blocked by the task that owns the fix,
  and is released when that task closes. A fix that has not landed is not a
  fix.
- `already_fixed` and `historical`: done, when the change they name (a commit
  or a `codecast/...` branch) is on origin/main in the run's repository. A
  named change that is not there waits on its task like `in_flight`.

A closed problem takes no reports: `cast signal move --to` a done or dropped
problem opens a new problem instead and says so. A run's moves on one problem
fold into one note with a count per problem (`lib/moveTally.ts`), not one
note per report.

A close retires what the problem holds (`findingGroups.retireOnClose`), with
the outcome as each finding's fate: evidence from before the fix is history,
a coaching close hands it to the coaching role, a drop closes it. A finding a
closed problem absorbs later (LL9) is retired the same way on arrival. Each
keeps the problem in `retired.task_id`, so grouping still reads it as that
problem's evidence and a re-judge that finds the same message again files no
copy (`judgeRetire.refound`); counts, the dispatcher and the trial lanes read
only live findings on open problems.

A merge carries the folded problem's argued cause to the survivor as a note
(its newest trial proposal's cause line and where it lives), and the folded
problem's trial card reads closed, superseded by the survivor's newest card
(`lineTrial.supersedeMerged`), never a live "Same rule as" sibling of it.

## LL14. Measuring a station before it changes

A station's prompt is changed on evidence, and the evidence is the station
run again on past cases with and without the change, never a new run's yield.
`cast line replay <graph> <station> [runs...]` (`cli/src/lineReplay.ts`), run
from the directory the graph's runs start in, replays one station on runs this
machine holds a checkpoint of, on two arms: the graph's files at a revision
(`--base`, HEAD by default, or `disk`) and as they are on disk, or with edited
copies laid over them (`--try <dir>`), so an edit is measured before any run
reads it.

- **The brief is the one the run would get now.** It is rendered from the
  run's checkpoint as a resumed run renders it: the arm's graph and prompt
  files, every `refresh` command station the run made run again in the arm's
  tree (so `_shared.md` is read as that arm has it), then `stationBrief`.
- **Nothing reaches the world.** Each replay runs through the dry-run harness
  with `--read-only`: cast writes refused and logged, no connection but the
  model's, no file written outside its run directory. A station that worked
  in a worktree works in a clone of the run's branch as the run left it, made
  inside that directory, so it can write and commit there. Records go under
  `~/.local/share/codecast/line-replay/`, outside every repository, since a
  brief can hold a customer's words.
- **A case passes on what it asks.** A line's frozen cases sit beside its
  graph (`<graph>/cases.json`, by station): a past run, the pinned fields that
  pass (`expect`), or a yes/no question (`grade`) a model answers from the
  replay's messages and commands, never told which arm it reads. Arms
  alternate within each case.
- **The verdict is a test.** Each arm's passes, misses, replays that did not
  run, and dollars; a one-sided Fisher test of the edited arm against the
  other. An edit lands when it separates and its controls hold.

What a replay cannot see: Union's database and Union's own models (the
sandbox refuses both, so a station that would measure says it could not), and
codecast state that moved since the run (reads are live).

