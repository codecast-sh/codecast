# /line journeys

What a person comes to /line to do, the page each job finishes on, and what every page holds. This is the build spec for plan pl-889. It replaces the page list in `line-workspace.md` LW1 where the two disagree; the model (LW2), widgets (LW3) and actions (LW4) stand.

The standard for every page: it has one job a person came to do, lets them finish it there, and shows the real thing. A page is judged by whether the tester's task in LJ12 can be completed on it, never by how it looks.

## LJ1. Who comes here

**The founder (first).** Owns the product, does not read the pipeline. Arrives from a notification or a daily habit with a few minutes. Wants to clear what only he can answer and to know whether the product is getting better.

**The operator (second).** The same person in a different hour, later an engineer. Tunes the line itself: a step that keeps failing, a judge that is wrong, a prompt that needs changing.

When the two compete for build time, the founder's pages win. The operator's step page ships in a first cut (LJ8.6) that reuses today's panels.

## LJ2. The jobs

| # | Job, in their words | Who | Finishes on |
|---|---|---|---|
| J1 | "What needs me? Let me clear it." | founder | For you |
| J2 | "Should this fix ship? Show me the change and the proof, then let me say yes or no." | founder | Wherever the decision is named |
| J3 | "What is wrong with my product right now, and is it getting better?" | founder | Problems |
| J4 | "Is this problem real? Show me the actual conversation or call." | founder | Problem page, a finding opened in place |
| J5 | "What is being done about this one, and if nothing, why not?" | founder | Problem page |
| J6 | "Did the fix work?" | founder | Problem page |
| J7 | "Is this step working? If not, let me fix it." | operator | Step page |
| J8 | "Can I trust this judge? Let me correct it." | operator | Step page of a finder |

Nobody comes to browse every run, read the line as a document, look at stat cells or chat with a graph. Those get no page.

## LJ3. Rules

1. **A waiting thing is never named without the thing.** Any text that says something waits renders `WaitingItem` or is a link that lands on one already open.
2. **One count.** "For you N" counts a need only if the viewer can answer it right now, in the reader, with no run started. It is summed across every process and shown in one place, the nav entry. A count anywhere else is a filter onto exactly the rows it counts.
3. **A finding opens the real thing in place.** Never a quote that opens nothing.
4. **No control without a backend.** LJ9 lists every act and whether its mutation exists. An act whose backend is missing is not drawn; it never ships as a button that does nothing.
5. **One act per state.** A problem, a run and a step each show at most one primary act, chosen by state.
6. **State the cost on the control.** A control that starts a run says so in its label ("Start again, about 4h"). A second step (the `ConsequentialSwitch` review) is used only where the spend is a full line run or more: turning a line on, Start again, Ask me again, Rerun from main. Test this edit and the first message to an agent state the cost on the button and fire on one click.
7. **Every filter, sort, window and open item is in the URL** and pushes history. Back returns to the same list, filter and scroll.
8. **Text is never clipped mid-word.** Titles and questions wrap. Text stored cut is fixed at the writer (LJ10 step 0), not hidden.
9. **Words.** One vocabulary (LJ11). Pipeline words do not appear outside the Line page.

## LJ4. Page map

```
For you   (landing)   J1 J2      what waits on me, read and answered here
Problems              J3         what is wrong: one sentence, trend, list
  └ Problem page      J4 J5 J6   one problem: act, findings, work   (+ J2 when a decision waits)
      └ Run page                 one run of that problem, step by step (operator depth)
Line                  J7 J8      starting, and every step and finder: is it working
  └ Step page                    one step: its work, its instructions
```

Three nav entries, keys <KeyCap>1</KeyCap> <KeyCap>2</KeyCap> <KeyCap>3</KeyCap>. `/trial` stays its own page for the trial's budget and history (LJ8.7).

### What is deleted

| Today | Verdict | Where its job goes |
|---|---|---|
| Landing on Problems | Change | Lands on For you. |
| Nav: Inbox | Rename, narrow | For you: only what a person can answer. |
| Nav: Sources | Delete as a page | The Find lane of the Line table; a source opens as a step page. |
| Nav: Runs list | Delete as a page | Waiting on me: For you. Failed and why: Line. Shipped: Problems filter. Retried without progress: the status phrase "Failed at Prove (3 tries)". Running now: Problems `status=running`. |
| Run detail | Keep, move | Under its problem: Problems › ct-N › Run 3. |
| Nav: Process, Graph, Notebook | Merge | Line, with a Table / Map toggle. Notebook goes: its outline is the table, its open step is the step page. |
| Nav: Chat | Delete as a page | "Ask an agent to change it" on the step page. `?view=chat` redirects there. |
| Nav badges, header "N for you" chip | Delete | Only the For you nav entry carries a number. |
| Header Auto-start chip, both popovers | Delete | Line › Starting, plus the Problems "Not started" group header and the For you footer. |
| Inbox groups Pipeline health, Silent runs | Move | Line, as step failures. |
| Inbox groups Not starting, Watching | Delete | Problems statuses. |
| Inbox row buttons and chips | Delete | Acts live in the reader, next to the full text. |
| Problems "fixes to decide" band, "Line off" strip, four tiles | Delete | For you; the Not started group; the sentence in LJ8.2. |
| Problems columns Ref, Source, Convos, Back, Fix, row sparkline, second Decide pill, verdict chip | Delete | Four columns remain. |
| Problem page pill row, "Came from", five tiles, big chart with range switch and legend | Delete | One stage track, one act band, a 64px strip. |
| Run card: step chips, legend, "Brief for the next run", static Card panel | Delete | Five-stage track and the real decision. |
| Findings dividers, tags, "Expectation check", sg ids | Delete | One divider: "Fix shipped Oct 10". |
| Step drawer, its meta line, "edited" pill, route pill rows | Replace | Step page. Routes are drawn on the Map. |
| A/B/C answer rows with KeyCaps on a step definition | Delete as controls | A plain definition list under Instructions. A KeyCap appears only on something that takes the key. |
| Outcome filter pills | Collapse | Waiting, Failed, Passed. |
| Graph legend, lane captions, node subtitles, runs popover, judge chip strip | Delete | A node is a name and at most two counts. |

## LJ5. Shell and URL

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [AgentWatch ▾]  [All projects ▾]                                 [⚙]    │
├───────────┬─────────────────────────────────────────────────────────────┤
│ For you 9 │                                                             │
│ Problems  │                         page                                │
│ Line      │                                                             │
└───────────┴─────────────────────────────────────────────────────────────┘
```

- **Process picker** scopes Problems and Line. It is not drawn on For you, which always covers every process; each row there names its process. One control, one behaviour.
- **Project filter** is set only by the person and shows as a removable chip. No navigation sets it as a side effect.
- **Keys.** <KeyCap>1</KeyCap> <KeyCap>2</KeyCap> <KeyCap>3</KeyCap> switch pages and <KeyCap>J</KeyCap> <KeyCap>K</KeyCap> move in a list. All are ignored while a text field has focus. Answer keys belong to `LineDecision`; the shell binds none that it uses.

`lib/line/lineWorkspaceUrl.ts`: `LINE_VIEWS = ["foryou", "problems", "line"]`, `DEFAULT_LINE_VIEW = "foryou"`, `LINE_MODES = ["table", "map"]`.

Kept keys: `project`, `graph`, `case`, `run`, `step`, `steptab` (`work | instructions`), `source`, `finding`, `decision`, `card`, `ask`.

New keys: `need` (the open For you item), `status` (`you | running | notstarted | watching | shipped | closed`), `q`, `sort`, `win` (`24h | 7d | 30d`), `show` (`waiting | failed | passed`).

Legacy names resolve through `LEGACY_VIEWS`: `inbox` to `foryou`; `runs` with a run to `problems` with `case` and `run`, without one to `problems`; `sources` to `line` with `source`; `process` and `graph` to `line` with `mode=map`; `notebook`, `replay`, `timeline` as today's targets renamed; `chat` to `line` with the step kept and `steptab=instructions`.

## LJ6. Shared pieces

Each is built once and embedded everywhere.

### LJ6.1 `lineNeeds` (`lib/line/lineNeeds.ts`)

A selector over the store's existing inbox rows; it replaces `isProblemRow` and `inboxCount`. No new stored copy. The feeder covers every process the viewer has, not only the drawn graph.

| Need | From today's kind | Counted | Reader shows |
|---|---|---|---|
| `decision` | `decide`, a live trial card | yes | `<LineDecision>` |
| `question` | `question` | yes | Ask block |
| `confirm` | `confirm` | yes | Ask block with the first finding open |
| `lapsed` | `unapproved` | **no**, until LJ9 item 1 lands | the stored decision, read only, and one act: Ask me again |
| `reask` | `proposal` with a question, a held trial card | **no**, until LJ9 item 4 lands | the question in full and one act: Ask me again |

- Each need carries process, project, problem, holder and since.
- A need held by someone else is listed under their name, uncounted, still answerable.
- `lapsed` and `reask` are listed in their own uncounted group, "Needs a new ask", because clearing them starts a run. When their backend lands they move into the counted groups and the group disappears. The count never includes something that cannot be cleared in the reader.
- Never a need: failed and silent runs, watching, a project whose line is off.

### LJ6.2 `WaitingItem`

The one reader for a need. Props: the need, `evidence` (whether to list the cited findings; on the problem page the Findings section is directly below, so it is off there), `onAnswered`.

- `decision`: `<LineDecision id onProblem onRun />`, embedded whole and untouched.
- `question`, `confirm`: the Ask block. The full question; the one line of why it matters; the cited findings as `FindingReader` rows with the first open (when `evidence`); the answer box with `Answer` and `Not a problem`. A confirm whose text is a question requires an answer.
- The Ask button says what happens next, from the admission ledger: "Answer and start, about 4h" when the project's line is on; "Answer" with "starts when Callers is turned on" and `<LineStartControl>` beside it when it is off.
- `lapsed`: `<LineDecision>` on the stored decision (read only today), then one bar: "Asked Oct 10, no answer in 3h 11m. The fix is still on its branch." with `Ask me again, about 4h` (the `ReaskRun` path, through the review step).
- `reask`: the question in full, then the same bar and act.

Embedded in: the For you reader, the problem page act band, the run page's person step, the step page's Waiting rows.

### LJ6.3 `FindingReader`

One finding, opened in place.

- **Row:** who raised it under one name ("Comms judge", "Call judge", "Akash", "Escalation"), when, the objection in full, wrapping.
- **Open,** in this order of preference:
  1. `<ProductView viewRef fallback>`: Union's own conversation, call or person screen at the moment. Drawn only when the finding resolves to a full uuid (LJ10 step 0).
  2. `MomentView`: codecast's own text of the moment with the judged words marked. Marking is MomentView's; ProductView is not asked to highlight.
  3. The full `detail_md`, with machine boilerplate stripped.
- Under it: `Judge is wrong`, and `Open in Union` last. `Not this problem` appears only once its mutation exists (LJ9).
- At most three ProductView frames per page: opening a fourth folds the oldest back to its row.
- No "Not loaded": rows draw from the store's signals at once and the body loads inside the open row.

### LJ6.4 `StageTrack`

Five dots: Investigate, Prove, Build, Verify, Present. Each is done, current, failed or not reached, and links to the run page at that stage's last step. One line beside it states the state in plain words: "Waiting on you since Oct 10", "Failed at Analyze after 2s", "No progress for 2h at Build", "Shipped Oct 10, not yet in production".

### LJ6.5 `<LineStartControl>`

From `components/consequential/lineStart.tsx`. The only way a line turns on. Its ready and held numbers are the only "waiting" numbers shown for a project.

## LJ7. Click paths

**J1 clear what waits on me.** Open /line: For you, first item open in the reader. Answer in the reader. The next item opens. Repeat until "Nothing waits on you". Zero navigation clicks.

**J2 "I click Decide and what?"** Line › Map, click the Decide node or its "5 waiting" count. The step page opens on Work with `show=waiting` and the first of the five expanded as the real decision. Answer; the row leaves and the next expands. The same decision opens answerable from the For you row, the problem page (act band, no click), the run page's Decide step and a Problems row (one click). No path ends on text.

**J3 what is wrong, is it getting better.** Press <KeyCap>2</KeyCap>: the sentence states it; the trend shows it. Click a legend row: the table narrows. Click the row: the problem page.

**J4 is this real.** On the problem page the first finding is already open on the real thread or call. Click another row to open it in place. `Judge is wrong` on the finding if it is.

**J5 what is being done, or why nothing.** The StageTrack line says where it is. Not started: the band says the line is off, with ready and held and the start control. Failed: the band names the step and the reason, with `Start again` and `Open the step`. Work › newest run is open: Found, Change, Proof, Outcome.

**J6 did the fix work.** Problem page, Findings: the divider "Fix shipped Oct 10". Rows above it are findings since; none means it held.

**J7 a step is failing.** Press <KeyCap>3</KeyCap>: the Steps table, Failed column "Implement 37 · typecheck red 3 times". Click the count: step page, Failed, grouped by cause. Open a row: what it was given, what it concluded, the output. Then `Start again`, or Instructions › Edit › `Test this edit` › `Save`.

**J8 can I trust this judge.** Press <KeyCap>3</KeyCap>, Find lane, Comms judge. Work: its findings. Open one: the conversation. `Judge is wrong` on the wrong ones; the head's wrong rate moves. Instructions: what it looks for.

## LJ8. Pages

### LJ8.1 For you (landing)

**Job:** clear what waits on me (J1, J2). **Primary action:** answer the open item.

```
┌ list 420px ───────────────────────────┬ reader ────────────────────────────────┐
│ FIXES TO DECIDE  5                    │ ct-59338 Missed-call follow-ups…  ‹ ›  │
│ ▌Missed-call follow-ups open with a   │                                        │
│  line the contact never said          │   <WaitingItem>                        │
│  AgentWatch · Callers · 3h            │                                        │
│ QUESTIONS  1                          │                                        │
│  Has Quinn left, or is Riley wrong?   │                                        │
│  Codecast's line · Broker · 1d        │                                        │
│ NEW: IS THIS REAL?  3                 │                                        │
│ ───────────────────────────────────── │                                        │
│ Needs a new ask  8                  ▸ │                                        │
│ Held by Cam  1                      ▸ │                                        │
│ ───────────────────────────────────── │                                        │
│ 87 problems not started: 6 lines off ›│                                        │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**List.** Always two columns from first paint; the list never changes width.
- Groups are named for the act: Fixes to decide (`decision`), Questions (`question`), New: is this real? (`confirm`). Inside a group, oldest first.
- A row is what is being asked (the decision's question or the problem's question, else the title) on up to two wrapped lines, then one meta line: process, project, age. No chips, buttons, source or ids.
- The first row is selected on arrival. <KeyCap>J</KeyCap> <KeyCap>K</KeyCap> move.
- Two folded, uncounted groups at the foot: "Needs a new ask" (`lapsed`, `reask`) and "Held by Cam". Their rows open the same reader.
- One footer line, shown only when lines are off: "87 problems not started: 6 lines off", a link to Problems `status=notstarted`. It is not a need and not counted, but the founder's largest lever is visible where he lands.

**Reader.** One line above (the problem ref and title as a link, prev and next), then `WaitingItem` with `evidence` on, full height, own scroll. After an answer the row leaves the list and the next opens; the count drops.

**Empty.** "Nothing waits on you." Then the Problems sentence (LJ8.2) as a link, and the footer line when lines are off.

**Removed.** Pipeline health, Silent runs, Not starting, Watching, all row buttons and chips, the shrinking list, "Get a new card", "card", "Re-ask", "Runs to ask again", "Not shipped: no answer".

### LJ8.2 Problems

**Job:** see what is wrong and whether it is getting better, and pick one (J3). **Primary action:** open a problem.

```
212 findings this week, down 18% from last. 5 fixes shipped, 4 held.
┌ Trend ───────────────────────────────────────────────── [24h][7d][30d] ┐
│ findings per day, stacked: top 5 problems in colour, rest one thin band│
│ ■ ct-59561 Missed-call follow-ups say "we tried you" but nobody…   41  │
├ [All 109] [Waiting on you 6] [Running 9] [Not started 87] [Watching 4] │
│ [Shipped 5] [Closed]                                       search…     │
├ Problem                               Findings 7d   Status         Last┤
│ WAITING ON YOU  6                                                      │
│ Missed-call follow-ups open with…        41 ↑       Fix to decide    2h│
│  ct-59338 · Callers                                                    │
│ NOT STARTED  87                                                      ▸ │
└────────────────────────────────────────────────────────────────────────┘
```

- **Sentence.** The answer to "is it getting better", stated: findings in the window against the previous window, fixes shipped, and how many held (no on-topic finding since). The chart backs it; the person does not have to read the chart to know.
- **Trend.** Stacked bars per day; the five largest problems in colour, the rest one thin neutral band. Legend rows carry the full title and count, and filter the table. Fix markers sit on the axis as marks with a tooltip, not controls. Under about 10 findings in the window the chart is a 48px strip. No brushing.
- **Filters.** Status chips with counts are the only chips; each count is the number of rows it shows.
- **Table.** Four columns: Problem (full title, up to two lines; ref and project beneath, quiet), Findings 7d (number and an arrow against the previous window), Status, Last.
- **Status** is one phrase from a fixed list, never a verb that looks like a button: "Fix to decide", "Question for you", "Waiting on Cam", "Needs a new ask", "Investigating", "Proving", "Building", "Verifying", "No progress for 2h", "Failed at Prove (3 tries)", "Line off", "Queued", "Watching", "Shipped", "Closed".
- The whole row opens the problem page; when it has a need, the need is open at the top.
- Grouped by status in chip order. **Not started is folded by default**, so 87 rows do not bury the 6. Open, it is sub-grouped by project: project name, `27 ready · 20 held`, `<LineStartControl>`, then the problems that would start. Held rows say what holds them ("in review", "an earlier run owns it").

**Removed.** Tiles, the for-you band, the Line off strip, six columns, the clipped legend, per-row sparklines, three controls per row, "Not met:" title prefixes.

### LJ8.3 Problem page

**Job:** understand one problem and move it forward (J4, J5, J6; J2 when a decision waits). **Primary action:** the one act its state calls for, in the act band.

```
← Problems   ct-58282 · Infrastructure                              ‹  ›
Every line run's Eval gate fails before running any test because the
line spawns run-full-suite.sh without L3_DATABASE_URL
● Investigate  ● Prove  ● Build  ● Verify  ◉ Present    Asked Oct 10, no answer
┌ ACT ───────────────────────────────────────────────────────────────────┐
│ <WaitingItem evidence={false}>                                         │
└────────────────────────────────────────────────────────────────────────┘
FINDINGS 3   ▁▁▂▂▁▁▁▂|▁▁   Oct 8 to Oct 10
  ▾ Aivery · Oct 10 3:40 PM   run-full-suite.sh exited 2 before any test…
      [ the real session or conversation ]
      Judge is wrong · Open in Union
  ▸ Aivery · Oct 8 …
WORK 3
  ▾ Run 3 · Oct 10 · 4h   Let code fixes reach the automated tests again
      Found     Reproduced the missing layer-3 database on the base…
      Change    5 files +175 −8                                   [Open diff]
      Proof     new test failed before, 4 of 4 pass after         [Open test]
      Outcome   Asked you Oct 10 3:51 PM, no answer in 3h 11m
  ▸ Run 2 · Oct 9 · 3h   Stopped at Ship: …
```

**Head.** Crumb, ref, project, full title, `StageTrack` for the newest run with its one state line. Prev and next walk the list the person came from (the filter is in the URL). No pills.

**Act band.** Always rendered when the problem has a need, with or without `?decision=`.

| State | The band holds | Example |
|---|---|---|
| Decision waiting | `<LineDecision>`; "Waiting on Cam" in the state line when he holds it | ct-59561, sd-615 |
| Lapsed | The stored decision and "Ask me again, about 4h" | ct-58282, sd-557 |
| Question or confirm | The Ask block; the findings it cites are the first rows of Findings, just below, already open | ct-58311, ct-58683 |
| Not started, line off | "Not started: Callers' line is off. 27 ready, 20 held." and `<LineStartControl>` | |
| Failed | "Failed at Analyze after 2s: ended with no result." with `Start again, about 4h` and `Open the step` | |
| Stuck | "No progress for 2h at Build." with `Open the step` | |
| Closed | "Dropped Oct 9 by Ashot: <reason>" and `Reopen` (who, why and Reopen only once LJ9 item 7 lands; until then "Closed Oct 9") | ct-57442 |
| Watching | "Merged Oct 10, not yet in production. Watching until Oct 17: 1 finding since, about something else." | ct-57509 |
| Running | No band. The page's job is then J4 and J5: the open finding and the open run. | |

**Findings (J4).** Header: the count and a 64px strip of findings per bucket with a marker where each fix shipped. No range switch; the window is the problem's life. Rows are `FindingReader`, newest first, the first open on arrival. After a shipped fix, one divider, "Fix shipped Oct 10", between before and after: that is the whole of J6. The count is this problem's findings; the upstream cluster size is not shown beside it.

**Work (J5).** One row per run, newest first, newest open. Collapsed: run number, date, duration, the headline of what it proposed, and the outcome from a fixed list ("Shipped", "Asked you, no answer", "Dropped by you", "Failed at Prove", "Stopped at Ship: <reason>"). Open: four labelled lines.
- **Found:** full text.
- **Change:** the files stat. `Open diff` appears when the run's diff is readable (LJ9 item 6); otherwise the PR link when one exists; otherwise the stat alone, as text.
- **Proof:** the before and after result. `Open test` on the same condition.
- **Outcome:** who answered what and when; it links to the decision record and never repeats a decision open in the band.
- `Open run` goes to the run page. An outcome is derived from the failing step's own reason, so a run cannot read "Failed at Review: Review approved".

**Removed.** Came from, tiles, pill row, the big chart and its controls, step chips and legend, the static Card panel, the brief, dividers, tags, duplicate state words.

### LJ8.4 Run page

**Job:** see what one run did, step by step, and act on the step it stopped at. **Primary action:** the stopped step's act (the same act as the problem page's band).

Route `view=problems&case&run[&step]`. Crumb: Problems › ct-N › Run 3. Left, the step trace as focusable buttons. Right, the selected step.

- **Head:** StageTrack and the true stop ("Failed at Analyze after 2s", not "Prove gave no result").
- **Agent step:** what it was told (folded), what it concluded (its last message), tool calls, a link to the session.
- **Person step:** `WaitingItem` for that step's decision. An answered one shows the decision with the answer marked, who and when. No inert Ship / Revise / Drop chips, no IN / RAN / OUT headings.
- **Script step:** the expanded command and its real output; the template behind a disclosure.
- **Parked step:** the reason in full and the Ask block.

**Removed.** Stats strip, "other paths", template fold, prompt hash, report fields, the source band (one link: "9 findings").

### LJ8.5 Line

**Job:** see whether the line is working and where it is not (J7, J8). **Primary action:** open the failing step.

```
STARTING                              Ready  Held  Running  Per day
 Callers & Call Management   ○ off      27    20      0        6     [Start…]
 Infrastructure              ● on       25     0      2        6     [Stop…]
STEPS                                              [Table] [Map]
 Lane         Step                     Through 7d   Failed                        Waiting
 Find         Comms judge                   28      2 marked wrong
              Escalation                    53      39 ungrouped
 Investigate  Analyze                      100      7 · ended with no result
 Prove        Prove                         68      17 · could not write a test
 Build        Implement                     68      37 · typecheck red 3 times
 Present      Decide                         9      1                                5
```

- **Starting.** The one home of the start switch: one row per project with a lead, numbers from the admission ledger, `<LineStartControl>` and nothing else. Ready and Held open Problems `status=notstarted&project=`.
- **Steps, Table (default).** Grouped by lane; Find holds the sources and judges. A script between agent steps folds into the step it checks. Failed is a count and the top cause in plain words, and opens the step page with `show=failed`. Waiting opens it with `show=waiting`, first item open. A row opens the step page.
- **Steps, Map.** Today's graph, stripped: a node is a name, a waiting count and a failed count; both counts open the same places as the table. It exists to show shape.
- Runs waiting at a step the line no longer has are listed under Present as "7 waiting at a removed step" and open as `reask` needs. No ghost node, no raw node id.

**Removed.** Notebook, Chat, Sources page, Runs list, legend, the chip strip, Changes and Trace popovers.

### LJ8.6 Step page

Replaces the step drawer, the notebook's open step and Sources' source detail.

**Job:** is this step working, and fix it (J7, J8). **Primary action:** open the failing or waiting work. Second: change the instructions.

Route `view=line&step=<id>&steptab=work|instructions`, or `&source=<key>` for a finder. Full width. Crumb: Line › Prove.

**Head.** Name, one line of purpose, three counts that are the only filters (`show=`): Waiting, Failed, Passed.

**Work (default).**
- Rows are this step's visits, grouped Waiting, Failed, Passed. Failed is sub-grouped by cause, the cause as the heading with a count. Row: full problem title, ref, age.
- **Person step:** Waiting rows open into `WaitingItem`, the real decision, answerable here. Passed rows show what was answered, by whom.
- **Agent step:** an open row shows Given, Concluded (its last message, never a raw JSON block) and the artifact. Labels are words a person uses ("Test level", "Command", "Test output", "Why"); machine paths are hidden. A failed row always shows a reason; when the step recorded none, the reason is a link to the upstream step that failed. Acts: `Start again, about 4h`, `Open the run`, `Mark right` / `Mark wrong` (visible, not hover only).
- **Finder:** rows are its findings, open is `FindingReader`. Groups: Ungrouped, Filed (to which problem, a link), Marked wrong. The head shows the wrong rate from marks. Acts on an ungrouped row appear only once LJ9 item 9 lands.

**Instructions.** First cut: today's panels moved here unchanged in behaviour (`PromptView` with Read / Edit, Try as "Test this edit", Ask as "Ask an agent to change it"), with three fixes: a disabled button states why; a person step shows the question filled from the newest real decision and its answers as a plain definition list; a finder lists what it looks for. Version diff and Restore come after the founder pages (LJ10 step 6).

**Removed.** The drawer, route pill rows, the "edited" pill, the meta line, outcome pills, source chips per row, hash pills, raw result keys, "station / round / visit / handed on / red / mechanism / dissolved".

### LJ8.7 /trial

Not in the nav and not rebuilt. Three corrections keep the journeys whole: waiting cards are For you rows (`decision`, tagged Trial once at the top of the reader) read through `TrialCardPanel` as the shell; "the problem" and "the run" link to /line's pages; `Rerun from main` goes through the review step. Held cards are `reask` needs.

## LJ9. Backend ledger

Each line is an act or a fact the pages name, whether its backend exists, and what the page shows until it does. Rule 4: nothing here ships as a dead control.

| # | Needed | Exists | Until it does |
|---|---|---|---|
| 1 | Answer a lapsed fix decision from its stored content; the answer resumes the run at Ship from the saved branch | no | `lapsed` is uncounted; the act is Ask me again (ReaskRun). jx7d8av confirms `LineDecision` takes an answer slot for it. |
| 2 | A view ref on a finding (`union:<view>/<uuid>[@iso]`) | partly: the fingerprint `evidence:<table>/<id>:…` (`findingConversation`) may hold the id | Step 0 verifies it on real signals. Where it resolves, ProductView; elsewhere MomentView, then full text. The filing step then stamps `view_ref` for judge, escalation and person findings. |
| 3 | Titles and `readiness_note` stored whole | no: cut at the ground step's writer | Step 0 fixes the writer and backfills open problems. No view work depends on it. |
| 4 | Store an answer for a `reask` need and hand it to the run when asked again | no | Uncounted; Ask me again. |
| 5 | The for-you feed across every process, with holder | partly | Widen the feeder into the existing home; `lineNeeds` selects. |
| 6 | Read a run's branch diff and test output | no | Change and Proof show the stat and the PR link, as text. |
| 7 | Who closed a problem, when, why; reopen | no | "Closed Oct 9", no Reopen. |
| 8 | Failure reason at the first step that failed | no: reports the step that received nothing | The engine string, behind a disclosure, and a link to the earlier step. |
| 9 | Finding acts: Not this problem, Make this a problem, Add to a problem, Dismiss | no | Not drawn. `Judge is wrong` exists (the label the line records). |
| 10 | The need's kind (confirm or question) written by the ground step | no | `askParts` as today. |
| 11 | `onAnswered` from `LineDecision`, and its layout in a 600px reader | ask jx7d8av once, at step 1 | The list advances on the store's row leaving, which needs no prop. |

## LJ10. Build order

Each step leaves /line better than it found it and names the plan task it belongs to.

0. **Truth first** (ct-59700). On real signals of ct-58311 and ct-59561, check whether the fingerprint id is the full uuid ProductView needs and whether a frame mints from localhost; record the result in the log. Fix the title and `readiness_note` writers and backfill. Nothing else in "show the real thing" is promised until this is known.
1. **Decide where you are** (ct-59699). `lineNeeds`, `WaitingItem`, the URL model with legacy redirects, For you as the landing page, and `WaitingItem` mounted on the step's Waiting rows, the graph count, the run page's person step and the problem page band. This closes "I click decide and what?" from every entry.
2. **See the real thing** (ct-59700). `FindingReader`; the problem page: head with `StageTrack`, act band, Findings, Work. Delete Came from, tiles, pills, the big chart.
3. **Pages cut to their job** (ct-59701). Problems: sentence, four columns, status groups, Not started with `LineStartControl`. Nav to three entries; Runs list, Sources, Chat, Notebook and the header chips deleted behind redirects.
4. **Line and step page, first cut** (ct-59701). Starting, Steps table, stripped Map, step page Work with failures by cause; Instructions as moved panels.
5. **Backend that turns fallbacks into answers.** Ledger items 1, 4, 6, 7, 8, in that order. As each lands its row in LJ9 flips and the uncounted group shrinks.
6. **Operator depth.** Version diff and Restore, finder acts (item 9), marked rows as attachments.

Answer paths that cannot be exercised on real data (answering, starting a line) are covered by mount tests on fixtures (`LineDecisionBody`, `SwitchReview`) and by `lineNeeds` unit tests over captured inbox rows.

## LJ11. Words

| Was | Is |
|---|---|
| card, "Get a new card", "card unanswered" | decision; "Ask me again"; "asked, no answer" |
| Ask again / Re-ask / Runs to ask again | Needs a new ask |
| Not shipped: no answer | Asked, no answer |
| New, confirm | New: is this real? |
| Pipeline health | Failed (on Line) |
| Open (when the line is off) | Line off |
| Auto-start, waiting N | Starting; ready N, held N |
| red, mechanism, dissolved, handed on, parked | failed its test; cause found; turned out not to be a problem; passed on; needs a fact |
| station, visit, round, rung | step; (dropped) |
| Came back | Returned after the fix |
| off topic | about something else |
| Person / Agent / Agent · Aivery / app:union | the finder's one name |
| not shipped / not deployed / merged | built; shipped (merged); in production |

## LJ12. The tester's tasks

Run each from a cold load of `/line` on real data, in a tab of your own. Never change real state: drive each flow to its last step and stop before the final press. Confirm by reading the DOM as well as by screenshot. A task passes only when every "done" line is true.

1. **Clear the top of the queue.** Open `/line`. Done: the page is For you; the first row is selected and the reader shows a live fix decision (sd-600 on ct-59338 when it is still open, else the first in "Fixes to decide") with its question, today and what changes, proof, and enabled Ship / Revise / Drop; no click was needed. The nav count equals the number of rows in the counted groups. Stop before pressing an answer.
2. **"I click Decide and what?"** Press <KeyCap>3</KeyCap>, switch to Map, click the Decide node, then go back and click its waiting count. Done: both land on the step page, Work, `show=waiting` in the URL, with the first waiting decision expanded as the same `LineDecision` with enabled answers; the number of Waiting rows equals the count clicked; no A/B/C rows with key caps exist anywhere on the page.
3. **The same decision from a problem and from its run.** Open ct-59561 from Problems. Done: sd-615 is open in the act band without `?decision=` in the URL, the state line reads "Waiting on Cam", and the answers are enabled. Open its newest run and the Decide step. Done: the same decision is embedded there; there are no inert Ship / Revise / Drop chips and no bare "sd-615" link as the only route.
4. **Answer a question that needs a lookup.** In For you open ct-58311 (has Quinn left, or is Riley wrong). Done: the full question is readable with no text ending mid-word; its cited findings are listed under it and the first is open on the thread where Gabe heard from Quinn (a Union frame or MomentView, not one quoted sentence); the answer box and `Answer` are present and the button says whether a run starts. Type nothing; stop.
5. **Is this problem real?** In For you, under "New: is this real?", open ct-58683. Done: the question does not end at "or from th"; the finding it rests on is open in the reader; `Answer` and `Not a problem` are in the reader, and no row in the list carries a Confirm button. Stop before pressing.
6. **A built fix nobody answered.** Open ct-58282. Done: it is not in the For you count; it is listed under "Needs a new ask"; the act band shows sd-557's proposal and proof in full, the line "Asked Oct 10, no answer in 3h 11m" and exactly one act, `Ask me again`, with its duration on the button; pressing it opens a review step that says what starts. Close the review; do not confirm. Work › Run 3 shows Found, Change, Proof and Outcome, with no "Get a new card", no static Card panel and no pill row.
7. **Did the fix work?** Open ct-57509. Done: the state line gives one vocabulary (merged, not yet in production, watching until a date); the Findings list has one divider "Fix shipped <date>" and the findings since sit above it; nowhere on the page do "not shipped", "not deployed" and "merged" disagree.
8. **A closed problem.** Problems, `Closed` chip, open ct-57442. Done: the band says when it was closed (and who and why once ledger item 7 has landed); prev and next are enabled and walk the closed list; Back returns to Problems with the Closed chip still on and the scroll kept.
9. **Why is nothing happening?** Press <KeyCap>2</KeyCap>, click `Not started`. Done: the chip's count equals the rows shown; Callers & Call Management is a sub-group whose header reads `27 ready · 20 held` (or the ledger's current numbers, summing to the rows beneath) with `LineStartControl`; pressing it opens the review naming what starts now and per day. Close it; do not confirm. The same numbers appear in Line › Starting. No bare "Turn on" exists on any page.
10. **A step keeps failing.** Press <KeyCap>3</KeyCap>, find Prove in the table and click its Failed count. Done: the step page opens with `show=failed`; failures are grouped under a cause in plain words with a count; opening the row for ct-59565 shows what it was given, what it concluded and the failing output, with a reason, and no raw JSON, "Rung", "Red" or machine path. `Start again` states its duration; stop before confirming.
11. **Can I trust this judge?** In Line, Find lane, open Comms judge. Done: its findings are listed; opening one shows the conversation in place with the judged words marked; `Judge is wrong` is visible on the open finding; the head shows a wrong rate. Stop before pressing.
12. **Old links and Back.** Load `/line?view=inbox`, `?view=runs`, `?view=sources`, `?view=chat`, `?view=process&mode=notebook`. Done: each lands on its new home (For you, Problems, Line, Line, Line) with nothing blank. Then from For you open a problem, a finding and a run, and press Back three times. Done: each press returns one level, to the same filter, open item and scroll.
