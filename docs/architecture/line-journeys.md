# /line journeys

What a person comes to /line to do, the page each job finishes on, and what every page holds. This is the build spec for plan pl-889. It replaces the page list in `line-workspace.md` LW1 where the two disagree; the model (LW2), widgets (LW3) and actions (LW4) stand.

The standard for every page: it has one job a person came to do, lets them finish it there, and shows the real thing. A page is judged by whether the tester's task in LJ12 can be completed on it, never by how it looks.

Numbers in the wireframes are illustrative. Every count on a real page is the number of rows it opens.

## LJ1. Who comes here

**The founder (first).** Owns the product, does not read the pipeline. Arrives from a notification or a daily habit with a few minutes. Wants to clear what only he can answer and to know whether the product is getting better.

**The operator (second).** The same person in a different hour, later an engineer. Tunes the line itself: a step that keeps failing, a judge that is wrong, a prompt that needs changing.

When the two compete for build time, the founder's pages win. Nothing the founder needs lives only on an operator page: starting a line, a failed problem and a parked problem are all reached from Problems.

## LJ2. The jobs

| # | Job, in their words | Who | Finishes on |
|---|---|---|---|
| J1 | "What needs me? Let me clear it." | founder | For you |
| J2 | "Should this fix ship? Show me the change and the proof, then let me say yes or no." | founder | Wherever the decision is named |
| J3 | "What is wrong with my product right now, and is it getting better?" | founder | Problems |
| J4 | "Is this problem real? Show me the actual conversation or call." | founder | Problem page, a finding opened in place |
| J5 | "What is being done about this one, and if nothing, why not?" | founder | Problem page; for many at once, Problems `status=notstarted` and `status=failed` |
| J6 | "Did the fix work? Do customers have it?" | founder | Problem page |
| J7 | "Is this step working? If not, let me fix it." | operator | Step page of an agent step |
| J8 | "Can I trust this judge? Let me correct it." | operator | Step page of a finder |

Nobody comes to browse every run, read the line as a document, look at stat cells or chat with a graph. Those get no page.

## LJ3. Rules

1. **A waiting thing is never named without the thing.** Any text that says something waits renders `WaitingItem` or is a link that lands on one already open.
2. **One count.** "For you N" counts a need only if the viewer can answer it right now, in the reader, with no run started. It is summed across every process and shown in one place, the nav entry. A count anywhere else is a filter onto exactly the rows it counts.
3. **A finding opens the real thing in place,** as far as the finding's data allows (LJ6.3). Never a quote that opens nothing.
4. **No control without a backend.** LJ9 lists every act and whether its mutation exists. An act whose backend is missing is not drawn, and a count whose rows have no act is not drawn as a to-do.
5. **One act per state.** A problem, a run, a step and an open row each show at most one primary act, chosen by state. A disabled primary act always has an enabled way through beside it.
6. **State the cost on the control.** A control that starts a full line run says so in its label and goes through a review (`ConsequentialSwitch` with a ledger): turning a line on, `Start again`, `Start these again`, `Start a new run to ask again`, `Rerun from main`. A control that starts no run fires on one click: `Ask me again` on a paused run, `Test this edit`, the first message to an agent. A duration is shown only when it can be computed (LJ6.6).
7. **Every filter, sort, window and open item is in the URL.** LJ5 says which keys push history and which replace. Back returns to the same list, filter and scroll: the stage records every pane's scroll by address and Back or Forward restores it (`useStageScroll`), a problem's detail pane included.
8. **Text is never clipped mid-word.** Titles and questions wrap. Text that was stored cut ends at its last full sentence (LJ9 item 3).
9. **State is said once, by structure.** The `StageTrack` line is the one home of a problem's state. Nothing else on the page repeats it as a sentence; other places hold only what the line does not (the thing, a fact row, the act).
10. **Words.** One vocabulary (LJ11). Pipeline words do not appear outside the Line page.

## LJ4. Page map

```
For you   (landing)   J1 J2      what waits on me, read and answered here
Problems              J3 J5      what is wrong, is it better; start what is not started; restart what failed
  └ Problem page      J4 J5 J6   is this problem real and is it being handled   (+ J2 when a decision waits)
      └ Run page                 read what one run did (operator depth)
Line                  J7 J8      is the line working: every step and finder
  └ Step page                    one step, one job by kind: answer / fix the cause / correct the judge
/trial                           what the trial cost and what it produced (reached from a trial decision and the trial project)
```

Three nav entries. Pages switch with <KeyCap>G</KeyCap> then <KeyCap>F</KeyCap> / <KeyCap>P</KeyCap> / <KeyCap>L</KeyCap>; the shell binds no digit (LJ5).

### What is deleted

| Today | Verdict | Where its job goes |
|---|---|---|
| Landing on Problems | Change | Lands on For you. |
| Nav: Inbox | Rename, narrow | For you: only what a person can answer. |
| Nav: Sources | Delete as a page | The Find table on Line; a source opens as a step page. |
| Nav: Runs list | Delete as a page | Waiting on me: For you. Failed and why: Problems `status=failed`, grouped by cause. Parked: Problems statuses "Needs a fact from you" and "Waiting for more findings". Shipped: Problems `status=shipped` and `status=merged`. Running now: Problems `status=running`. |
| Run detail | Keep, move | Under its problem: Problems › ct-N › Run 3. |
| Nav: Process, Graph, Notebook | Merge | Line, with a Table / Map toggle. Notebook goes: its outline is the table, its open step is the step page. |
| Nav: Chat | Delete as a page | "Ask an agent to change it" on the step page. `?view=chat` redirects there. |
| Nav badges, header "N for you" chip | Delete | Only the For you nav entry carries a number. |
| Header Auto-start chip, both popovers | Delete | Problems `status=notstarted`, the one home of the start control. |
| Inbox groups Pipeline health, Silent runs | Move | Problems `status=failed` (the founder's view) and the Line Steps table (the operator's). A run that stopped waiting on a person's yes is a need, not a failure (LJ6.1 `stopped`). |
| Inbox groups Not starting, Watching | Delete | Problems statuses. The inbox kind `watching` (parked until more findings) becomes "Waiting for more findings"; "Watching" is kept for after a fix is in production. |
| Inbox row buttons and chips | Delete | Acts live in the reader, next to the full text. |
| Problems "fixes to decide" band, "Line off" strip, four tiles | Delete | For you; the Not started group; three figures that filter (LJ8.2). |
| Problems columns Ref, Source, Convos, Back, Fix, row sparkline, second Decide pill, verdict chip | Delete | Four columns remain. |
| Problem page pill row, "Came from", five tiles, big chart with range switch and legend | Delete | One stage track, one act band, a 64px strip. |
| Run card: step chips, legend, "Brief for the next run", static Card panel | Delete | Six-stage track and the real decision. |
| Findings dividers, tags, "Expectation check", sg ids | Delete | One divider: "In production Oct 11" (or "Merged Oct 10" where deploys are not recorded). |
| Step drawer, its meta line, "edited" pill, route pill rows | Replace | Step page. Routes are drawn on the Map. |
| A/B/C answer rows with KeyCaps on a step definition | Delete as controls | A plain definition list under Instructions. A KeyCap appears only on something that takes the key. |
| Outcome filter pills | Collapse | Waiting, Failed, Passed. |
| Graph legend, lane captions, node subtitles, runs popover, judge chip strip | Delete | A node is a name and at most two counts. |
| /trial lanes Waiting, Held, Failed, Stopped as places to act | Reduce | Counts that link to For you and to the problem page (LJ8.7). |

## LJ5. Shell and URL

```
For you                                    Problems, Line
┌──────────────────────────────────┐      ┌──────────────────────────────────────────┐
│                           [⚙]    │      │ [AgentWatch ▾]  [All projects ▾]   [⚙]   │
├───────────┬──────────────────────┤      ├───────────┬──────────────────────────────┤
│ For you 9 │                      │      │ For you 9 │                              │
│ Problems  │        page          │      │ Problems  │            page              │
│ Line      │                      │      │ Line      │                              │
└───────────┴──────────────────────┘      └───────────┴──────────────────────────────┘
```

- **Workspace.** /line reads one workspace of its own, never silently the app's active one (`lib/line/lineSpaces.ts`, `hooks/useLineSpace.ts`). The page is wrapped in `WorkspaceScopeProvider` (`hooks/useWorkspaceScope.tsx`), so every reader and feeder under it (the floor, labels, trial cards, `LineDecision`'s lookups) reads that workspace while the app's active pointer is untouched. Which one: the workspace of the thing the address names (`need`, `case`, `run`, `decision`, `project`; a run or problem the store does not hold yet is fed by id, so a cold link still finds it), else the one last picked on this device, else the one with the most problems not closed. The header names it first, on every page, as a menu of the viewer's workspaces that hold problems with each one's open count (one such workspace: its name, no menu). Picking one opens the current view's home there and is remembered on the device. Why: a founder whose app sat on Personal read /line as "nothing waits on you" while 14 needs waited in his team.
- **Process picker.** For you and the Problems list both cover every process, so "Waiting on you" on Problems and the For you count are the same set (Problems' `you` chip is the needs For you counts, `useProblemList` over `workspace.problems`, built per process in `useLineWorkspace`). On For you there is no picker and each row names its process. On the Problems list the picker narrows: `All` first and selected by default, a process writes `process=` (the list's own key, kept while a problem opens), and with All each row names its process beside its ref. On Line, an open problem and a run, the picker is the drawn process (`graph`). The project filter's open counts and For you's "N open problems" read the same all-process list.
- **Every ct-N link inside /line opens its problem page.** `LineWorkspace` provides `TaskHrefProvider` (`lib/taskHrefContext.tsx`): a ref /line holds as a problem opens `?view=problems&case=ct-N`, any other task its task page. Shared components read it (`EntityIdPill`; the decision renderer's meta pill and card facts through `useTaskHref`), so a link drawn by a component /line embeds never leaves the app.
- **Project filter** is set only by the person and shows as a removable chip. No navigation sets it as a side effect.
- **Every link to a problem, run or step sets `graph`** to that item's process (a need's `process`), because the model is per drawn graph and For you has no picker.
- **Keys.** The shell uses no digit and none of <KeyCap>X</KeyCap>, <KeyCap>T</KeyCap>, <KeyCap>Enter</KeyCap>: `LineDecision` binds bare <KeyCap>1</KeyCap> to <KeyCap>9</KeyCap>, <KeyCap>X</KeyCap>, <KeyCap>T</KeyCap> and <KeyCap>Enter</KeyCap> in a capture listener while focus is inside its article (`DecisionAnswerControls.tsx:115`), and For you lands with a real decision open. Pages switch with <KeyCap>G</KeyCap> then <KeyCap>F</KeyCap> / <KeyCap>P</KeyCap> / <KeyCap>L</KeyCap>. <KeyCap>J</KeyCap> <KeyCap>K</KeyCap> move the list only while focus is in the list, and never move focus into the reader. Focus enters a decision only by a click or <KeyCap>Tab</KeyCap> into it. All shell keys are ignored while a text field has focus or focus is inside a decision.

`lib/line/lineWorkspaceUrl.ts`: `LINE_VIEWS = ["foryou", "problems", "line"]`, `DEFAULT_LINE_VIEW = "foryou"`, `LINE_MODES = ["table", "map"]`.

| Key | Values | History |
|---|---|---|
| `view`, `case`, `run`, `step`, `source` | as today | push |
| `need` | the thing that waits, not the row key: a task short id (`ct-N`), `sd-N` or `tc-N`. A row key (`<kind>:<id>`) changes when a confirm becomes a question, so it is never in the URL. | push |
| `decision`, `card` | kept for notification links. On For you they resolve to the need that holds them and are rewritten to `need` with replace (a decision that waits on nobody settles on `need=sd-N`). On a problem page they are not required: the band shows the need without them. Moving to another view drops them unless the move names them, so they never ride along on later links. | push |
| `finding` | the open finding (`sg` short id); added to `PLACE_KEYS` | push |
| `status` | `you \| others \| newask \| running \| failed \| notstarted \| merged \| shipped \| closed`, a partition (LJ8.2) | push |
| `quiet` | `1`: with `status=shipped`, only fixes quiet since | push |
| `q` | search text | replace |
| `sort` | `findings \| last`; default is status group, then findings | replace |
| `win` | `24h \| 7d \| 30d` | replace |
| `show` | `waiting \| failed \| passed` | replace |
| `steptab` | `work \| instructions`. Old values: `prompt`, `try`, `ask` to `instructions`; `decisions` to `work`. | replace |
| `mode` | `table \| map` | replace |
| `project`, `graph`, `ask` | as today | as today |

- **Scroll.** Each list saves its `scrollTop` in `sessionStorage` under its URL without the open item, and restores it on mount. `select()` keeps `scroll: false`.
- **`case` carries the problem's ref** (`case=ct-56770`), as `need` does, so a copied link reads. The shell (`LineWorkspace`, `caseRefs`) hands every view the row id and writes every `case` back as the ref; an address with a row id (an older link, a run's own case) settles on the ref in place, with replace.
- **A run link with no `case`** (`view=runs&run=<id>`) resolves in the shell once the run row is in the store, then rewrites to `view=problems&case&run` with replace. `readLineSelection` stays pure.
- **Legacy names** resolve through `LEGACY_VIEWS`: `inbox` to `foryou`; `runs` with a run to `problems` with `case` and `run`, without one to `problems`; `sources` to `line` with `source`; `process` and `graph` to `line` with `mode=map`; `notebook` to `line`; `replay`, `timeline` as today's targets renamed; `chat` to `line` with the step kept and `steptab=instructions`.

## LJ6. Shared pieces

Each is built once and embedded everywhere.

- **One name per problem.** Every list row, reader head and page heading names a problem by `problemListName({ title, name })`: its written name (`lineFlow.causeName`, lineRetitle's `cause.named` while it names the current title), else its title cut to one clause. The problem page puts its whole statement under the name.
- **One reading of a card's figures.** `trialFacts` (components/trial/TrialFactsStrip.tsx) is the only place a trial card's proof, checks, reach, risk, diff, evals and cost are counted and worded; /trial's strip and LineDecision's chips (`TrialEvidenceBand`) both render its rows.
- **A call a finding names by id** is a pill to the app's call view and is framed under the opened finding (`lib/line/findingCalls.ts`); the row line names it by its first eight characters and drops Slack ts asides.

### LJ6.1 `lineNeeds` (`lib/line/lineNeeds.ts`)

A selector over the store; it replaces `isProblemRow` and `inboxCount`. No new stored copy.

**Inputs.** Counted needs come from `sessionDecisions` and the waiting causes of every process: the unfiltered `allInbox`, never `workspace.inbox`, which `useLineWorkspace.ts:298` narrows to the drawn graph. Needs held by someone else come from `lineCards` pending rows whose holder is not the viewer; that needs LJ9 item 12 (the card carries no holder today), and the `lineCards` feeder mounted for every project that has a cause, not only those of the drawn process.

| Need | From | Counted | Reader shows | Act |
|---|---|---|---|---|
| `decision` | inbox kind `decide`; a trial card with a session decision | yes | `<LineDecision>` | its own answers |
| `question` | kind `question`; a problem parked on a fact a person can give (`readiness: needs_context`, not waiting for findings) | yes | Ask block | `Answer` |
| `confirm` | kind `confirm` | yes | Ask block with the first finding open | `Answer`, `Not a problem` |
| `reask` | kind `proposal` with a question; a trial card with no session decision (a Held or Stopped trial card); a waiting visit at a removed step | **no**, until LJ9 item 4 lands; then yes | the session's question in full (its last message) | until item 4: `Ask me again`, one click, no run starts. After: the answer box. |
| `lapsed` | kind `unapproved` | **no**, until LJ9 item 1 lands | the stored decision, read only: the newest `lineCards` row for the task with a non-pending status (the inbox row carries no card id) | `Start a new run to ask again` through a review |
| `stopped` | the problem's newest run ended `deadend` (not `deadend-failed` or `deadend-silent`, `runReport.ts failCause`): a step finished, did not fail, reported, and had no next step. `finishedAtDeadEnd` decides finished (the step's outcome, else its node's status; a handoff, a kill or a failed node is `deadend-failed`). A step that finished and said nothing (no pinned report, no result prose) is `deadend-silent`: nothing to say yes to, so it is a failure row, "Build ended without a report", with `Start again` | **no**, until LJ9 item 14 lands | the yes in one line, the same on the band, the run's head and For you (`lineNeeds stoppedAsk`: "Prove finished: go on to Build?"), then that step's last message in full | `Yes, go on to Build` records the yes on the problem (comment and readiness note; the next run reads `readiness_note`) and starts nothing; then `Start the run with your yes` through its review. `Not a problem` second |

- Each need carries process, project, problem, holder and since.
- A need held by someone else is listed in its own group, uncounted, still answerable.
- `reask`, `lapsed` and `stopped` are listed in an uncounted group, "Needs a new ask", shown open, `lapsed` first: a built fix on a branch is worth the most. When a backend lands its rows move into the counted groups. The count never includes something that cannot be cleared in the reader.
- **Never a need:** a run whose step itself failed (`deadend-failed` and every other failure), a silent run, a problem waiting for more findings, a fix being watched, a project whose line is off. These are Problems statuses.

### LJ6.2 `WaitingItem`

The one reader for a need. Props: the need, `evidence` (whether to list the cited findings; on the problem page the Findings section is directly below, so it is off there), `onAnswered`.

- **`decision`:** `<LineDecision id onProblem onRun />`, embedded whole and untouched.
- **Host contract.** `LineDecision` is a full-height pane (`.ld` is `height: 100%; overflow: auto` with a sticky head and the answers docked in its footer). Every mount gives it a box of fixed height and no other scroll inside that box: the For you reader's full height; on the problem page `min(80vh, 880px)` as the first screen, Findings below it; in an open step-page row the same box. Its head already shows ref, title and project, so no host repeats them. If jx7d8av ships an `inline` variant (auto height, dock sticky to the viewport), the problem page and step rows use it and drop the box.
- **`question`, `confirm`: the Ask block.**
  - The full question, wrapping. The one line of why it matters.
  - **What this asks about.** The finding whose words name the most of the people the question and its reason name (`problemPage.askedAbout`), in its own words with its link ("Open the finding in Union"). None when the ask names no one or every finding alike.
  - A question saved cut short (ends "…") says so and offers "Ask it again, whole", which clears the problem's grounding so the ground step reads its findings again.
  - **What this asks about:** openable rows for what the question names. Until LJ9 item 16, an id in the question text that matches a known call, contact or conversation id is linked by lookup and opens `<ProductView>` in place under the question (`union:person/<id>`, `union:call/<id>`, `union:conversation/<id>`); a name that does not resolve stays text with `Open in Union`, a search link.
  - The cited findings as `FindingReader` rows with the first open (when `evidence`).
  - **The ask is a question.** Grounding states what it does not know as a sentence ("nothing says whether Quinn has actually left (so Riley is correct) or is still active (so the switch is the bug)"); `lineInbox askAsQuestion` reads it as the question it is ("Has Quinn actually left, or is Quinn still active?") and, when it weighs alternatives, offers each as a one-press answer button carrying what it would mean; a free box below takes "something else". A note stored cut at its 500-character cap inside its ask keeps that ask, marked "…", never the statement before it (`askParts`).
  - **`confirm` (one finding): "Is this a real problem?" is the question, answered in one press.** `Yes, it is real` is always enabled, the note optional; what grounding still does not know shows under the question as `Still unknown`. Nothing is required that no question asked.
  - **`question`: the answer takes the shape of the question** (`problemPage.ts askShape`), when there are no alternatives to press. A question that names parts in a list ("what snoozing should do (duration, who sees it, whether it hides the cause from review)") gets one labelled field per part, all required; the answer goes to the run as `Part: value` lines. Otherwise one required box. The reasoning behind the question is a folded `Why it asks` under the controls, never a paragraph above them.
  - **The answer buttons say only what they do** (`Answer`, `Yes, it is real`, `Not a problem`); **what answering sets off sits beside the yes as a figure or a control** (`AskBlock useAnswerStart`/`AnswerStart`, read from the problem's own project admission, one reading for the problem page's band and For you's reader). `answerProblem` only marks the problem ready; the sweep starts it.

    | Condition | Beside the yes |
    |---|---|
    | Line on, a place free, task has `goal_ref`, no assignee | `Starts now` |
    | Line on, places full | `N ahead` (N bold, the queue before it) |
    | Line off | the shared Turn on flow, `Turn on Callers's line…` (`LineStartControl`, its review) |
    | No `goal_ref`, or assigned | nothing |
  - **A problem opened on a finding that says nothing asks no question** (`lib/line/findingEvidence`). A finding whose body is a stub ("placeholder", "TODO", empty) once its expectation line, quote and bookkeeping are set aside is no evidence; a problem whose opening finding is one (read from the task description the door writes, so the list can tell before its findings are fed), or whose findings are all stubs, rests on nothing (ct-57470: two "placeholder" match findings and one unrelated match finding filed under an A/B-test rule). `lineInbox` raises it as `confirm` with no ask, and the Ask block reads `No supporting finding`, `N of M findings empty`, then `Close: no evidence` (primary, drops it) and `It is real`. Grounding's question about it is never shown. An empty finding's row reads `Empty finding`, dim, and opens only its link.

- **`reask`:** the question in full. Until item 4: one act, `Ask me again`, one click, no review and no duration; the run's station presents again on its machine (`trialReask` for a trial card), so the label states "the run's machine must be online" when it is not, and the row shows `ReaskRun`'s asking and no-reply states. After item 4: the ordinary answer box; the answer is stored on the task and the run reads it at its ask step.
- **`lapsed`:** the stored decision, read only, then two fact rows (Branch: its name and files stat; Asked: date) and one act: `Start a new run to ask again, about <d>`, through `SwitchReview` with `startAgainLedger` (what starts, cost from `useRunCost`, that the saved branch is reused), calling `startLineCause`. `ReaskRun` is not used here: `reaskTrialRunCore` refuses every project that is not a trial. When item 1 lands the decision's own answers are enabled and the act goes.
- **`stopped`:** the yes in one line (only where the host's own state line does not already ask it), the step's last message in full, then `Yes, go on to <next stage>` (recorded for the next run), `Not a problem`, and `Start a new run` through its review. On a run's own page the reader drops its "Open the run" link.

No bar in `WaitingItem` states the problem's state as a sentence (rule 9); the StageTrack line does.

Embedded in: the For you reader, the problem page act band, the run page's person step, the step page's Waiting rows.

### LJ6.3 `FindingReader`

One finding, opened in place.

- **Row:** who raised it under one name ("Comms judge", "Call judge", "Akash", "Escalation"), when, the objection in full, wrapping. A row whose finding holds nothing beyond its row (no moment, no body, no link, no act) is not a control: no chevron, nothing opens. A finding never restates the expectation the page heads with: the bold expectation line a finder opens with is dropped by its opening words, since stored titles are often cut short of it (ct-57459's 47 rows each led with the whole expectation), and the row leads with the finding's own first paragraph, else its quote. Every list of findings applies the same rule (`problemPage.ts findingLeads`): the problem page's Findings and the reader's Findings under a For you ask alike, so ct-58311's eight rows each lead with their own conversation, never the title above them eight times.
- **Loading.** The store holds few of a problem's findings before its page opens (ct-58311: 1 of 8). The host mounts `useSyncTaskSignals(caseId)` and draws `cause.signal_count` placeholder rows of fixed height until it answers. No "Not loaded".
- **Open,** by what the finding carries (read from the real store, 1039 signals):
  1. **`signal.moment` set** (every judge finding: match, comms, call; 807 of 1039): `<MomentView moment cited>`, the conversation as the people in it saw it. It frames Union's own screen itself (`momentViewRef`, `<ProductView hideWhenNone>`: a conversation, a match), then the moment's messages only, opened on the flagged line with the judge's one-sentence reason beside it, an email's quoted history folded under "Quoted history" (open when the judge quoted from it). A moment with no messages (a match) shows the reason alone. Everything only the grader read (the facts and notes it was handed, such as the commitment ledger and a party's lifecycle; every judge's run; the ids) sits behind one `What the judge saw` disclosure, closed. No block counts. No fingerprint parsing.
  2. **No moment, `evidence_url` set** (person, agentwatch, escalation, desk, invariant findings): the full `detail_md` with machine boilerplate stripped, and one small link named for its site ("Union", "Slack"), its title naming the target in full ("Open the agent run in Union").
  3. **An event source's finding** (an error group: `subject` is `eg-N`, `problemPage.ts eventFinding`): the row says what happened to the group ("Regressed in e2e@1.3.0 · 7 times"); open, `EventGroupFinding` shows the group itself, read live (`useSyncOpsGroup`): facts (group, status, seen, last, release, culprit), the newest stack with the product's frames lit, the newest samples, and the group's id linking to Ops > Issues. A group gone from its source says "Group not found" under the facts the finding carried. The filer's text is never shown, and never names a command (`ingest.ts promotionSignal`).
  4. **An escalation** (`source` union.escalation, `problemPage.ts escalationFinding`): the row is the contact, the ask and what woke it ("Caitlin Jones · Call: Email ceiling and no text thread · after a failed call"); open, the agent's reason, quoted. The filer's Ask/This one/Lane lines and ISO stamps are never shown.
  5. **Neither:** the full `detail_md`.
  6. **A desk finding** (`source` union.desk, an expert edited or rejected a draft): the expert's words as a quote, and `Open the draft in Union`. The prompt ids and the "N expert edits and rejections" count are bookkeeping and never shown. The draft itself and the thread it would have joined are not in the finding (ct-57501 asks to name an earlier email it cannot show): Union's desk finder has to send them, or a `union:conversation/<contact>@<at>` reference, before the reader can show them.
  7. **An AgentWatch finding** carries no moment and no reference to the conversation it judged (ct-58311's eight): the reader shows its description, its quote and `Open the finding in Union`. Union's finding rows hold `contactId`/`callId`/`matchId`; when its cluster signal writes `union:conversation/<contactId>@<detectedAt>` (or call, match) as a line of the detail, the reader frames that screen in place.
- **Acts.** `Judge is wrong` is drawn only when `signal.judge` is set and the row is not a `case_of` row; `labelFinding` refuses every other finding. On a problem's page every filed finding has `Not this problem…`: a `SwitchReview` (`findingLedger.ts`: how many findings leave with it, all its problem's findings under the same key; how many stay; "Leaves it with none"), then `moveFindingOut` (convex `signals.ts moveFindingOutCore`) files them under a problem of their own; they leave the page at once. `Open in Union` is last.
- At most three Union frames per page: opening a fourth folds the oldest back to its row.

### LJ6.4 `StageTrack`

Six dots, read from `model.steps[id].stage` (`LinePhaseKey`, `shared/contracts/linePhases.ts`): understand is **Investigate**, prove is **Prove**, build is **Build**, check is **Verify**, decide is **Present**, ship is **Ship**. Ship is drawn only once Present is done. Each dot is done, current, failed or not reached, and links to the run page at that stage's last step.

One line beside it is the only statement of state on the page: "Waiting on you since Oct 10", "Asked Oct 10, no answer", "Failed at Analyze after 2s", "No progress for 2h at Build", "Prove finished: go on to Build?", "Build ended without a report", "Merged Oct 10, not in production", "In production Oct 11, watching until Oct 18".

### LJ6.5 `<LineStartControl>`

From `components/consequential/lineStart.tsx`. The only way a line turns on. **It has one home: Problems `status=notstarted`,** in each project's sub-group header. Every other place that mentions a line being off (the Ask block, the problem page band, the Line page's summary row, the For you footer row) shows the state and links there with `project=` set. Its ready and blocked numbers are `RollupRow.ready` and `notReady` (`lib/lineFlow lineRollup`, split by `waitingReadiness`), not the admission, which carries no queue counts. A project with no lead (`admission.role` null) shows "No lead" and a link to the project page instead of the control. Turning on goes through the review; turning off is one press, `Turn off`.

### LJ6.5a How a decision stands (`lib/line/decisionOutcome.ts`)

One function, `decisionOutcome(card, run, { gate, trial, unapproved })`, reads every decision a run asked, and every surface that says how one stands reads it: the Decide step's groups and its row in the Steps table, a problem's Problems status and band, a run row's answer. Four states and no others:

| State | When | Words |
|---|---|---|
| waiting | the card is open and its run is at the gate | Waiting |
| answered | a person chose an option (the card's, else the gate's answer) | the option ("Ship"); in a trial "Would ship · trial", recorded and nothing shipped |
| lapsed | the gate came back with no answer (outcome `failure`) and the run went on | Lapsed |
| withdrawn | the card was taken back or dismissed, or the run ended at the gate before anything was asked | Withdrawn |

Only `answered` is an answer: a run that went on past an unanswered card to ship never reads "shipped" or "Answered". `why` carries the run's own words when it stopped ("The problem was merged into another while the run waited"). The line model puts the outcome on every person-step visit (`StepDecision.answer`); a trial is known by the trial's own run rows and a trial project's runs.

### LJ6.6 Durations

`<d>` on a label is the median `LineRunModel.durationMs` of finished runs of that project in that process, shown only with at least 3 such runs. With fewer the label carries no duration. One helper, `lib/line/runDuration.ts`. Cost in dollars comes from `useRunCost` and is shown in the review, not on the button.

### LJ6.7 Ledgers

This workflow writes the two new reviews in `components/consequential/ledgers.ts`: `startAgainLedger` (one problem: what starts, cost, the saved branch when there is one) and `startTheseAgainLedger` (a cause group: the count, total cost, total time). Both render in `SwitchReview`.

## LJ7. Click paths

**J1 clear what waits on me.** Open /line: For you, first item open in the reader. Answer in the reader. The next item opens. Repeat until the list is empty. Zero navigation clicks.

**J2 "I click Decide and what?"** Line › Map, click the Decide node or its waiting count. The step page opens on Work with `show=waiting` and the first waiting decision expanded as the real decision. Answer; the row leaves and the next expands. The same decision opens answerable from the For you row, the problem page (act band, no click), the run page's Decide step and a Problems row (one click). No path ends on text.

**J3 what is wrong, is it getting better.** <KeyCap>G</KeyCap> <KeyCap>P</KeyCap>: the figures state it; the trend shows it. Click "N% more": the table narrows to the problems that grew. Click a day's bar: the table narrows to that day's problems. Click a row: the problem page.

**J4 is this real.** On the problem page the first finding is already open: for a judge finding, the conversation or call with the judged words marked; for any other, its full text and the Union link. Click another row to open it in place.

**J5 what is being done, or why nothing.** One problem: the StageTrack line says where it is and the band holds the act (`Start again` when failed; the Ask block when it needs a fact; a link to the start control when its line is off). Many: Problems `Not started` opens each project with its start control; Problems `Failed` groups failures by cause with one `Start these again`.

**J6 did the fix work, do customers have it.** Problem page: the band's fact row says Merged, In production, Watch ends and Since. Findings: one divider at the production date; rows above it are findings since.

**J7 a step is failing.** <KeyCap>G</KeyCap> <KeyCap>L</KeyCap>: the Steps table, worst first, "Implement 37 · typecheck red 3 times". Click the count: step page, Failed, grouped by cause. The cause heading carries the act: `Edit instructions`, which opens Instructions with that group's runs as the test set. Edit › `Test this edit` › `Save`, or `Ask an agent to change it` when this machine cannot save.

**J8 can I trust this judge.** <KeyCap>G</KeyCap> <KeyCap>L</KeyCap>, Find table, Comms judge. Work: its findings. Open one: the conversation with the judged words marked. `Judge is wrong` on the wrong ones; the head's wrong rate moves.

## LJ8. Pages

### LJ8.1 For you (landing)

**Job:** answer what waits on me now (J1, J2). **Primary action:** answer the open item. Nothing else is listed: a thing no answer can reach is a problem's state, and it lives on Problems.

```
┌ list 420px ───────────────────────────┬ reader ────────────────────────────────┐
│ FIXES TO DECIDE  5                    │ ct-59338 Missed-call follow-ups open   │
│ ▌Missed-call follow-ups open with a   │ with the call attempt…   3h  1 of 9 ‹›│
│  line the contact never said          │                                        │
│  AgentWatch · Callers · 3h            │   <WaitingItem head={false}>           │
│ QUESTIONS  1                          │                                        │
│  Quinn or Riley on the account        │                                        │
│  Codecast's line · Broker · 1d        │                                        │
│ NEW: IS THIS REAL?  3                 │                                        │
│ ───────────────────────────────────── │                                        │
│ Needs a new ask  18                 › │                                        │
│ Not started  83                     › │                                        │
└───────────────────────────────────────┴────────────────────────────────────────┘
```

**List.** Two columns from first paint; the list never changes width. One item and no pointer lines: the list is not drawn and the reader takes the width (its line still says 1 of 1).
- Only needs the viewer can answer now (`counted`): Fixes to decide (`decision`), Questions (`question`), New: is this real? (`confirm`). Inside a group, oldest first. The nav badge, the rows and the reader's "N of M" are the same set, so they always agree.
- A row is what the item is about: the problem's title, whole, wrapping. Then one meta line: process, project, age. What is asked is the reader's, never repeated in the row. No chips, buttons, source or ids.
- The first row is selected on arrival. <KeyCap>J</KeyCap> <KeyCap>K</KeyCap> move while focus is in the list.
- Below the list, one quiet line per Problems chip that holds something no answer can reach: "Needs a new ask N ›" (`status=newask`: lapsed, stopped, paused runs) and "Not started N ›" (`status=notstarted`). Their counts are the Problems list's own (`useProblemList(...).counts`, every process, no chip or search), so the chip they open shows the same number. They are links, not rows: outside the J/K walk and the N of M.

**Reader.** One head line: the problem's ref and whole title (one link that opens the problem), its age, the `Trial` tag on a trial item (a link to /trial), then N of M and prev / next. `WaitingItem` follows with `head={false}`, so the decision opens on its question with no second ref, title, project or asker pill; `evidence` on, at the reader's full height. After an answer the row leaves the list (the store's row leaving, no prop needed) and the next opens; the count drops.

**Named but not here.** A `need` the address names that this page never listed (answered elsewhere, held by someone else, or a link from before it settled) is never swapped for another item: the reader says "ct-N · Not waiting on you" with `Open the problem`, and no row is selected. A decision named that way opens read as it stands under "Not in your list", and its address settles on `need=sd-N`. An item that leaves the list while open (answered here) hands its place to the next.

**Empty.** "Nothing waits on you" as the list's one line; the reader holds the three Problems figures (LJ8.2), the same component, each a link to its filter. The pointer lines stay.

**Removed.** "Needs a new ask" rows and the Not started row from the list (both are Problems chips; For you points at them), the process label above the reader, Pipeline health, Silent runs, Not starting, Watching, all row buttons and chips, the shrinking list, "Get a new card", "card", "Re-ask", "Runs to ask again", "Not shipped: no answer", the prose footer, "Held by".

### LJ8.2 Problems

**Job:** see what is wrong and whether it is getting better, and pick one (J3). **Primary action:** open a problem. With `status=notstarted` the page's primary action becomes starting a project's line; with `status=failed`, starting a cause group again (J5 for many).

```
 212 findings             5 in production        4 of 5 quiet since
 18% fewer than last week                        5 merged, not in production ›
┌ Trend ───────────────────────────────────────────────── [24h][7d][30d] ┐
│ findings per day, stacked: top 5 problems in colour, rest one thin band│
├ [All 109] [Waiting on you 6] [Someone else 1] [Needs a new ask 8]      │
│ [Running 9] [Failed 5] [Not started 62] [Approved, not merged 2]       │
│ [Merged 5] [In production 5] [Closed 8]                    search…     │
├ Problem                               Findings 7d   Status         Last┤
│ WAITING ON YOU  6                                                      │
│ Missed-call follow-ups open with…        41 ↑       Fix to decide    2h│
│  ct-59338 · Callers                                                    │
│ FAILED  5                                                              │
│  Analyze ended with no result · 4                  [Start these again…]│
│ NOT STARTED  62                                                      ▸ │
└────────────────────────────────────────────────────────────────────────┘
```

- **Figures, each one that names problems a link onto exactly them.** "1059 findings in 7d" anchors the chart. Its second line compares with the window before; when it says more ("140% more than the week before", red) it is a link that sets `found=more`, the problems found more than in the window before; fewer or the same is plain text (when occurrences are `capped` inside the previous window it drops the comparison). "5 fixes in production" sets `status=shipped`; "4 of 5 quiet since" sets `status=shipped&quiet=1`; with no fix in production neither is drawn. Merged and approved fixes are not figures: their chips count them. Only fixes in production count as shipped. **Quiet** = a fix in production with no entry in `history.regressions` after its deploy date. **One figure on every load:** findings count only problems with a series (`problemTable` `series`: the history feed came, or the problem is in a project, whose feed is on its way). A problem in no project has no history feed, so its count would be whatever the store's capped two-week signals window held on that load (1139 then 1059 minutes apart, the gap 80 findings on 44 dropped unfiled problems); it still shows its own count in its row. One component, `ProblemFigures`.
- **Empty.** No problem in view: the page is one line, "No problems", with no figures, chart, chips or columns. No findings in the window: the first figure is the line "No findings in 7d" with the count before it when there was one ("12 the week before"), never "0" and "100% fewer"; the chart is not drawn.
- **Trend.** One bar per day (per hour over 24h) on a counted axis (0 and round values, dashed rules). A bar is a control: pressing it sets `found=<bar start>`, and the table lists the problems with findings that day, busiest that day first, with the Findings column headed and counted for that day (no arrow); the bar turns blue, the others step back, and a `Found Oct 9 ×` chip beside the status chips lifts it (as does pressing the bar again). Hovering names the day's three busiest problems by ref, list name and count, then "Other problems". No colours per problem and no legend: the table is the list. Fix markers sit under the day as diamonds with a one-line key only when one is drawn. Under about 10 findings the chart is a 48px strip. `found` is a place (Back returns), and the chips count what it keeps.
- **Status is a partition, and it is the page's.** The row's status and phrase are the problem page's band, read through `problemPage.ts problemNow` (`problemStatus.ts problemStand` builds the band's input from what the list knows): a row and its page never say two things. `you` only when something on the page can be answered. Every problem has exactly one status; the chips are the only chips, they sum to All, and the table is grouped in chip order. A `problemTable` unit test asserts the group counts sum to the total. First match wins:

  | Order | `status` | When | Phrases |
  |---|---|---|---|
  | 1 | `you` | a `decision`, `question` or `confirm` need the viewer holds | "Fix to decide, since Oct 12", "Question for you", "New: is this real?" |
  | 2 | `others` | such a need held by someone else; a task in review that a named person holds (its assignee) | "Waiting on someone else" (LJ9 item 12: the name), "In review · Dana · 2d" |
  | 3 | `newask` | a `lapsed`, `stopped` or `reask` need; the newest run ended with its fix decision unanswered (`decisionOutcome` withdrawn or lapsed) and nothing shipped; a task in review nobody holds | "Fix withdrawn Oct 12, unanswered" (the card was taken back; "Fix asked Oct 12, unanswered" otherwise), "Prove finished: go on to Build?", "Needs a new ask", "Run ended Oct 11, nothing asked", "You answered Not now Oct 11, nothing since" |
  | 4 | `failed` | newest run failed at a step, a live run silent past its threshold, or a run that handed the problem back with nothing to answer | "Failed at Prove", "No progress for 2h", "Escalated at Refine: 107 of 246 findings reject the cause" |
  | 5 | `running` | a live run with progress | "Investigating", "Proving", "Building", "Verifying", "Presenting", "Shipping" |
  | 6a | `approved` | a fix approved to ship that never merged: nothing of it landed, and its next move is a person's merge | "Approved Oct 12, not merged" |
  | 6 | `merged` | a fix merged and not known to be in production | "Merged, not in production" (deploys recorded, none carried it); "Merged Oct 10" (deploys not recorded for the project) |
  | 7 | `shipped` | a fix in production | "In production Oct 11, watching until Oct 18"; "In production Oct 11, quiet"; "In production Oct 11, 2 since" |
  | 7a | `trial` | a trial run's card answered: recorded, and a trial never merges, so it is never counted with real fixes waiting on a merge (chip "Trial answered") | "Trial: you would ship" |
  | 8 | `closed` | closed without a fix | "Closed" |
  | 9 | `notstarted` | a waiting problem with no need and no run, or one a run parked | "Queued" (line on), "Ready: line off", "Ready: no line set up", what blocks it ("Not grounded yet", "Needs a goal", "Assigned to <name>", "Nothing to change", "Waiting for more findings (has 2)"), or the park record ("Already fixed on main (fc0d85b)", "Parked: needs a fact") |

- **Table.** Four columns: Problem (its list name: one clause under 80 characters, ref and project beneath, quiet), Findings 7d (number and an arrow against the previous window), Status (one phrase, never a verb that looks like a button), Last. The whole row opens the problem page; when it has a need, the need is open at the top.
- **Failed group.** Directly under the waiting groups, since it is the next thing a founder can move. Sub-grouped by cause (`failCause` key), the cause in plain words with a count ("Analyze ended with no result · 4"), so one outage across four problems is one heading. A failure no Inbox row names (a ship step that refused to merge, evals that could not score) takes its step from the newest run's trace (`useProblemList` `failedStep`, the last failed node past start and end): "Ship failed", rows "Failed at Ship". One no trace names is "Stopped without a reason recorded", rows "Failed, no step recorded"; never "a step gave up". The heading carries `Start these again`, through the review (`startTheseAgainLedger`: count, total cost, total time). A single row's `Start again` is on its problem page.
- **Not started group.** Folded in All. With `status=notstarted` it is open and is the page: sub-grouped by project, each header holding the project name, `<ready> ready · <blocked> blocked`, why the ready ones are idle as a state word in the sweep's order (`lineFlow admissionHold`: "Line off", "Paused", "Today's limit reached", "5 of 5 places taken"; the whole reason is its title) and `<LineStartControl>` ("Turn on…" opening the review while off, "On · Turn off" while on), or "No lead" and a link. The review counts the heading's own rows, one total stated once: "4 start within 2 min", "27 ready" (the heading's ready count), Starting names only problems the sweep would take (`startableCause`, never a blocked or held one), Then "23 more, 5 at a time", Blocked the heading's blocked count (its one reason when there is one), and the confirm "Run all 27". The admission is read from the org of /line's own workspace: `LinePage` holds the window's org tree to it (`useOrgScope`; `orgSlice` `orgScope` + `orgTreeFor` refuse a push for another workspace while it is set), so the control is never blank because the app sits on another workspace. Ready plus blocked equals the rows beneath; blocked counts only rows in this group, each saying its reason. Problems whose roll-up reason is "in review", "earlier run" or "needs context" are not here: they have a decision, a run or a question and sit under their own status.
- **Problem names.** A problem opens titled with its first finding, often a judge's whole sentence with call ids and Slack timestamps. The list never shows that: `lineRetitle`'s sweep (the same pass and grouping budget that renames a problem whose findings left) writes `cause.named` for any title over 80 characters, one clause with no ids, dates or names, recorded for the title it names, so a new title is named again. The title stays whole for the problem's page and runs. Until a name lands (or when the model's answer was unusable, stored as an empty name) `problemListName` drops id asides and cuts the title at its first sentence, else its last clause break, else its last whole word, under 90 characters.
- **Chips.** Only the pressed chip is filled. `Waiting on you` unpressed is a plain chip whose count is blue; `Failed` unpressed has a red count.
- **Trial project.** Its project filter row shows the trial's spend as a link to /trial.

**Removed.** Tiles, the for-you band, the Line off strip, six columns, the chart's legend (a second, truncated problem list), per-row sparklines, three controls per row, "Not met:" title prefixes, the opening sentence, the word "held".

### LJ8.3 Problem page

**Job:** decide whether this problem is real and is being handled (J4, J5, J6; J2 when a decision waits). **Primary action:** the one act its state calls for, in the act band. Every state has a band: one act, or the facts that show nothing is owed.

```
← Problems   ct-58282 · Infrastructure                              ‹  ›
Every line run's Eval gate fails before running any test because the
line spawns run-full-suite.sh without L3_DATABASE_URL
● Investigate  ● Prove  ● Build  ● Verify  ◉ Present    Asked Oct 10, no answer
┌ ACT ───────────────────────────────────────────────────────────────────┐
│ <WaitingItem evidence={false}>   (the stored decision, read only)      │
│ Branch  codecast/line-ct-58282 (copies)       Asked  Oct 10 3:51 PM   │
│                                    [Start a new run to ask again, ~4h…]│
└────────────────────────────────────────────────────────────────────────┘
FINDINGS 3   ▁▁▂▂▁▁▁▂|▁▁   Oct 8 to Oct 10
  ▾ Aivery · Oct 10 3:40 PM   run-full-suite.sh exited 2 before any test…
      the finding's full text
      Open the agent run in Union
  ▸ Aivery · Oct 8 …
WORK 3
  ▾ Run 3 · Oct 10 · 4h   Let code fixes reach the automated tests again
      Found     Reproduced the missing layer-3 database on the base…
      Change    5 files +175 −8                                   PR #412
      Proof     failed before · passes after
      Outcome   above
  ▸ Run 2 · Oct 9 · 3h   Stopped at Ship: …
```

**Head.** Crumb, ref, project, full title, `StageTrack` for the newest run with its one state line. Prev and next walk the list the person came from (the filter is in the URL). No pills.

**Act band.** Always rendered, with or without `?decision=`. It never restates the StageTrack line; it holds the thing, fact rows and the act.

| State | The band holds | Act | Example |
|---|---|---|---|
| Decision waiting | `<LineDecision>` in its sized box | its answers | ct-59561, sd-615 |
| Question, confirm, needs a fact | The Ask block; the findings it cites are the first rows of Findings, just below, already open. For a parked run: "Parked: <the full reason>" above the question. | `Answer` | ct-58311, ct-58683, ct-59687 |
| Lapsed | The stored decision, read only; fact rows Branch and Asked | `ClosedDecisionActs`: `Drop: close the problem` and `Ask again (new run, ~$N)`, the card's recommendation first | ct-58282, sd-557 |
| Fix unanswered (the newest run ended at its card, withdrawn or lapsed, nothing shipped; no need row carries it) | The same as Lapsed: the decision read only, fact rows Branch, Asked, Run | the same `ClosedDecisionActs` | ct-59433, sd-615 (recommends Drop, so Drop leads) |
| Trial answered | Fact rows You chose (Ship · day · its ref) / Shipped: No, a trial ships nothing / Change | `Close`; `Open the run` second. Taking the fix to the real line has no backend yet (`orgLineMerge.check` refuses trial runs). | ct-59229, sd-595 |
| In review, nobody holds it | Fact rows You answered / Run ended / Held by Nobody | `Start again…` through the review; `Open the run` second | |
| Stopped | The step's last message in full | `Start a new run to ask again`; `Not a problem` second | |
| Reask | The session's question in full | `Ask me again` (then the answer box, item 4) | ct-59445 |
| Not started, line off | Fact rows: Waiting on (this problem's reason, when it has one) / Line Off. Never the line-wide Ready and Blocked counts: they are not this problem's. | `<LineStartControl>` ("Turn on Callers' line…", the review) | ct-59561 |
| Not started, no line set up | Fact rows: Waiting on / Line Not set up | `Set up <project>'s line`, to the line settings for the project | |
| Escalated (a run handed it back with no card or question) | The step's own words in full; fact rows Reject the cause 107 of 246 findings / Handed back / Step | `Start again…` through the review; `Open the run` second. Never "Waiting on you". | ct-57459 |
| Parked by a run | Already fixed on main: fact rows Fixed on main fc0d85b / Parked / Note; else the park note in full | `Close as fixed` (fixed on main), else `Start again…`; `Open the run` second | ct-59687 |
| Not started, blocked | The reason in full ("Not grounded yet", "Assigned to Dana"). A run holds a problem only while that run is live, and is named ("Held by Run 2"); one whose last run ended while the task still points at it reads "Run 2 ended, nothing started since" | none; the reason is the answer. The ended-run case gets `Start again…`: the sweep passes a task that points at a run | |
| Waiting for more findings | Fact row: Has 2 / Needs: what the note says | none | |
| Running | Fact row: Stage Build / Running 42m / Usually done in <d> | none: nothing is owed | |
| Failed | The failing step's reason and output in full | `Start again, about <d>` through the review; `Open the step` second | |
| No progress | Fact row: Stage Build / Silent 2h / Last output (its last line) | `Start again, about <d>`; `Open the step` second | |
| Merged, not in production | Fact row: Merged Oct 10 (commit or PR link) / In production: no / Last production deploy Oct 8 (link) | the PR or commit link is the act: the deploy that would carry it is not codecast's to make (LJ9 item 13). No watch dates: a watch on a fix that never deployed watches nothing (`timeline.ts shownWatches`). | ct-57509 |
| Merged, deploys not recorded | Fact row: Merged Oct 10 (link) / In production: not recorded for this project | none | |
| In production, watching | Fact row: Merged Oct 10 / In production Oct 11 / Watch ends Oct 18 / Since 1, about something else. Each number opens the rows it counts. | none | |
| Approved, not merged | Fact row: Approved Oct 12 sd-583 / Merged No / In production No, last deploy Oct 11 (or "Not recorded for this project") / Change 3 files +108 −1 / Merge step Off (a fact only: its switch is the merge review's) / Earlier fix "Run 2 merged 9e85377 Oct 5" when an earlier run of the problem merged a different fix, so a finding naming that merge is read against it. Never the ship step's sentence. | `Merge this fix…`: when the team's Ship is off, the review's first step is the missing one, `Turn on Ship` for the team (`shipOnLedger`; admins only, else blocked "Only Union admins can"), after which the same dialog becomes the merge review. Then `SwitchReview` with `mergeFixLedger` (change, branch, pull request, whether it merges, the merge step); with the merge step off its confirm `Open pull request` is enabled. Confirm is Ship on the fix's pull request when it has one (merges once checks pass), else Ship on the task (opens one, and merges only where the line may); its words say which. `Open the run` second. | ct-57509 |
| Closed | Fact row: Closed Oct 9 / How / Why. The StageTrack line is left out: the facts say it once. Who and `Reopen` once LJ9 item 7 lands | none until then | ct-57442, ct-56770 |

**Head title.** A title stored cut at its cap ("…means nothing to t") heads in full from the expectation its findings restate (`problemHeading`), else to its last whole word with "…".

**Withdrawn.** A lapsed card that was withdrawn says "Withdrawn" once: the decision's own banner; the StageTrack line is left out.

**Findings (J4).** Header: the count, and "No supporting finding" when the only finding is doubted by grounding (`causeDoubt`) or every finding was moved out. No strip and no date span: every row carries its own date. Rows are `FindingReader`, newest first, the first open on arrival. One divider between before and after: "In production Oct 11" (or "Merged Oct 10" when production is not known); with a merged fix that is not in production the divider reads "Merged Oct 10, not in production" and findings above it are not counted against the fix. The count is this problem's findings; the upstream cluster size is not shown beside it.

**Work (J5).** Not drawn while no run has started: the band says where the problem stands. A run whose findings were moved to another problem after it ran (`movedOut` reads the line's move note; `runMovedTo` matches the run's words to that problem's title or the moved key) reads "Moved to ct-58022" with `Open ct-58022`, is never opened on arrival, and never sets this problem's state. An escalation reads "Escalated at Refine"; a park reads the band's words. One row per run, newest first, newest open. Collapsed: run number, date, duration, the headline of what it proposed, and the outcome from a fixed list ("In production", "Merged", "Approved Oct 12, not merged", "Asked you, no answer", "Dropped by you", "Failed at Prove", "Fix withdrawn Oct 12, unanswered", "Stopped at Ship: <reason>"). Headlines and findings are an agent's words without its bookkeeping ("[layer] Done:") or internal cause ids ("C120"), `personWords`; a merged commit links to its diff. A fix's words come from the run's own merge and deploy records (`problemPage.ts fixOutcome`), the facts the band reads, never the verdict alone, so a row and the band never disagree. Open: four labelled lines.
- **Found:** full text.
- **Change:** the files stat and branch. `Open diff` appears when the run's diff is readable (LJ9 item 6); otherwise the PR link when one exists; otherwise the stat alone, as text.
- **Proof:** the run's red and green step outcomes from the run model ("failed before", "passes after"). When the run has neither, the line is left out. `Open test` only with item 6.
- **Outcome:** who answered what and when, with a link to the decision record. For the newest run, when the band already shows it, the line reads "above" and says nothing more.
- `Open run` goes to the run page. An outcome is derived from the first failed step's own reason (LJ8.4), so a run cannot read "Failed at Review: Review approved".

**Removed.** Came from, tiles, pill row, the big chart and its controls, step chips and legend, the static Card panel, the brief, dividers, tags, duplicate state words, every sentence that repeats the state line.

### LJ8.4 Run page

**Job:** read what this run did. **Primary action:** by how the run ended; the step that carries it is selected on arrival.

| Run ended | Selected on arrival | Primary action |
|---|---|---|
| Waiting on a person | the person step | the `WaitingItem` |
| Failed | the first failed step | `Start again, about <d>` through the review |
| Parked | the Park step | the reason in full and the Ask block |
| Stopped (`deadend`) | the step that finished with no next step | its last message whole, `Yes, go on to Build`, `Not a problem`, `Start a new run`; the head reads the need's own line ("Prove finished: go on to Build?") for the run the need names, "Stopped at Prove after it finished" for an older one. A step that ended without a report reads "Build ended without a report" and offers `Start again` |
| Fix unanswered (its card withdrawn or lapsed) | the Decide step | the decision read only (`act={false}`) over the problem page's own dock (`ClosedDecisionDock`: Branch by name, Asked, `Ask again`, `Drop`); the head and the problem's Work row read the band's words, "Fix withdrawn Oct 12, unanswered". The acts show only on the newest run of an open problem |
| Merged, in production or watching | the Build step | its Change and Proof, with the PR link |
| Running | the current step | none; the step's live output |

Route `view=problems&case&run[&step]`. Crumb: Problems › ct-N › Run 3. Left, the step trace as focusable buttons. Right, the selected step.

- **Head:** the problem's title as its own page heads it (`problemPage problemTitle`: whole sentences, never the filer's cut "…"), then `StageTrack` and the true stop. Until LJ9 item 8 lands the first failed step is derived on the client: the earliest visit whose outcome is a failure. So the head reads "Failed at Analyze after 2s", not "Prove gave no result", without the engine change.
- **Agent step:** what it was told (folded), what it concluded (its last message), tool calls, a link to the session.
- **Person step:** `WaitingItem` for that step's decision. An answered one shows the decision with the answer marked, who and when. No inert Ship / Revise / Drop chips, no IN / RAN / OUT headings.
- **Script step:** the expanded command and its real output; the template behind a disclosure.
- **A landing step that never ran** (Ship after its decision was withdrawn or dismissed unanswered; `runTrace notRun`): marked like an unanswered step, never red, state "Did not run", and "Why it did not run" in one sentence; the command it would have run sits closed behind a disclosure. ct-59561 Run 5 had read "Failed" over the raw ship script.
- **Parked step:** the reason in full and the Ask block, the same one the problem page's band shows.
- **Build and Ship steps of a merged run:** the commit or PR link, and whether a production deploy carried it (the same fact row as the problem page).

**Removed.** Stats strip, "other paths", template fold, prompt hash, report fields, the source band (one link: "9 findings").

### LJ8.5 Line

**Job:** see whether the line is working and where it is not (J7, J8). **Primary action:** open the failing step.

```
Steps   8 waiting on you · 5 with someone else · 4 running · 137 failed   [Table] [Map]
        Step            Waiting                                Failed                                   Passed
UNDERSTAND
        Analyze         –                                      13 Its session never started                126
PROVE
        Prove           13  8 on you · 3 someone else · 2 running   40 Never started: its session sat empty…   81
CHECK
        Verify          1 running                              15 Checks failed, output not kept (muted)    48
DECIDE
        Decide          1 someone else                         12 No answer                                  9
FIND         Finder                   Findings 7d   Filed to a problem   Wrong rate
              Comms judge                   28            26                7% (2 of 28)
              Escalation                    53            14
```

- **One summary row** above the steps, "2 of 8 lines on · 9 running", a link to Problems `status=notstarted`, where the start control lives. Line has no switch.
- **Steps, Table (default).** In the line's order, so the table reads the way a problem travels: a body per phase (Understand, Prove, Build, Check, Decide, Ship, `PHASE_ORDER`) headed by its name, steps inside it in graph order. A script is its own row (folding it into the step it checks would make a count differ from the rows its page opens). A step no run reached, of any kind, is left out: a row of dashes has no job. Columns: Step, Waiting, Failed, Passed, each count the step page's own (`stepWork().counts`, read through `lib/line/stepTable.ts`), so the number clicked is the number of rows listed. Waiting says whose move it is beside its number: "on you", "someone else" or "running", each part counted when there are several (`waitOwner`). "On you" is the viewer's own needs (`workspace.needs`, matched by run, else by problem): the one source For you and the Problems page's Waiting on you read, so a decision Cam holds is "someone else" here exactly as Problems files it, never "on you". A decision or a stopped run no need of the viewer's names is someone else's. Failed counts step failures only: a count and the top cause in plain words, opening the step page with `show=failed`. A cause that only says nothing was kept ("Checks failed, output not kept", "No reason recorded", `WorkCause.thin`) is muted: the count is the fact, the cell opens the runs. A person's step never fails: its cell is its page's own words, "3 No answer", in a neutral color, and opens `show=noanswer` (and Answered `show=answered`; `readShow` reads either name). The bar's figures are the columns' sums (`stepTableFigures`): "N waiting on you", "N with someone else", "N running", "N failed" in red; unanswered decisions are not in the red figure. Until LJ9 item 8 lands a failure with no session at its step is counted under the previous step that ended in failure (the same client derivation as LJ8.4). Waiting opens the step page with `show=waiting`, first item open. A row opens the step page.
- **Find table.** One row a finder, named with its source when the source has several judges ("AgentWatch comms", "Comms judge"; never two rows of one name). Columns: Findings 7d, Not filed, Marked wrong (a person's marks; 0 when none, the same for every row). "Filed to a problem" is not a column: it is Findings less the other two, and on most rows it equalled Findings. Not filed is a neutral count, never red: findings not yet filed are not a failure. A finding is filed when a later finding under the same key opens a problem; nothing files it on a timer (`signals.ts commitSignal`, attach `held`). **One window, one count source.** The table and every figure on a finder's page count the same rows over the same window (`sourcesView findWindow`, `useFinders`): the last week, read from the line's findings feed (`signals.webList`, live findings only: a withdrawn judge finding, `retired`, never fills its cap of `LINE_SIGNAL_CAP`). When the feed is full before the week is, the window is what the line holds (`heldFrom`) and the label says so ("Findings 4d"), never "7d" over a shorter span.
- **Steps, Map.** Today's graph, stripped: a node is a name, a waiting count and a failed count; both counts open the same places as the table, and the failed count is the table's own (`stepFailures`, through `useStepTable`), so the two views never read two numbers for one step. A node's outcome bar is every visit ever, and its hover title says so. It exists to show shape. A script's dot says one short count under its name, "failed 16" in red when it failed, else "ran 70×"; its runs and loops are on hover. Its column is sized for that count and its way back ("↩ Implement"), so neighbouring dots never write over each other. No legend: a node's shape says its kind. A person's step is outlined and fills solid only while something waits there. Every node is a button in the tab order; Enter opens its step page. The Table|Map switch sits at the same place in both modes (`mode=` in the address).
- Runs waiting at a step the line no longer has are listed under Present as "7 waiting at a removed step" and open as `reask` needs. No ghost node, no raw node id.

**Removed.** The Starting table, Notebook, Chat, Sources page, Runs list, legend, the chip strip, Changes and Trace popovers, "ungrouped" and "marked wrong" in a Failed column.

### LJ8.6 Step page

Replaces the step drawer, the notebook's open step and Sources' source detail. Three variants, each with one job and one primary act.

Route `view=line&step=<id>&steptab=work|instructions`, or `&source=<key>` for a finder. Full width. Crumb: Line › Prove. **Head:** name, one line of purpose, three counts that are the only filters (`show=`): Waiting, Failed, Passed.

**Person step. Job: answer what waits here (J2).** Primary: the answer inside the open `WaitingItem`.
- Work rows are Waiting, No answer, Answered, by `decisionOutcome` (LJ6.5a). A waiting visit resolves to its decision by (`workflow_run_id`, `gate_node_id`, status pending) over `lineCards` and `sessionDecisions`; a visit with none is a `reask` need. The first waiting row is open in its sized box.
- No answer is grouped by its word, `Lapsed` and `Withdrawn`, each with its count. A row's line is the run's reason when it gave one. Open, it is the decision as it was asked (`LineDecision` closed: `act={false}`, inline, no head of its own) with the card's own answers as acts that still work (`ClosedDecisionActs`, shared with For you's lapsed reader): `Drop: close the problem` drops the problem now and records on it which decision it settles, starting nothing; `Ask again (new run, ~$N)` is a new run (`StartRunAct priced`, through its review), since Ship and Revise both need one. Whichever the card recommended comes first and filled (`drop`/`wait` puts Drop first), so the answer a person just read is the first thing they can press. A closed problem says there is nothing to ask again. A person step's groups carry no `Edit instructions`: an unanswered question is answered or asked again, not rewritten.
- Answered rows show the answer in `decisionOutcome`'s words, a trial's as "Would ship · trial".
- An open row keeps the problem's title in its head, its ref a link to the problem; only the decision's own head is left out.
- Instructions is a quiet link: the question filled from the newest real decision, and its answers as a plain definition list.

**Agent step. Job: find why it fails and fix the cause (J7).** Primary: the act on a cause heading.
- Work rows are this step's visits, grouped Failed, Waiting, Passed. Failed is sub-grouped by cause, the cause as the heading with a count. The cause is what happened, never the step's own label for failing ("Could not write a test for the problem" is Prove's label, not a reason): a check runner's failing checks ("Touched tests failed"), the run's reason ("Out of time, 30m"), the step's own words, or "Prove ended without a report". When those say nothing, the cause is read from what the visit left (`failCauseOf`): an eval's result names the layer that could not run, the gate suite's exit or the gate cases that failed (`evalFailWords`: "Layer 3 cannot run: L3_DATABASE_URL is not set", "The gate suite exited 2"); an agent's step with no session "Its session never started"; a timeout whose session holds no message "Never started: its session sat empty until the 3h limit", never "Out of time" (it did not run long). Only then is it thin: a script that printed nothing kept says what it is for, "Checks failed, output not kept"; otherwise "No reason recorded". A thin heading is muted. A heading is the cause's first line without machine paths. The heading carries `Edit instructions`, which opens Instructions with those runs as the test set, except over a cause in the runner (a session that never started, a stall), which no instruction fixes.
- **One stall, said first.** When most of a cause's visits hit their limit within six hours of each other (`stallOf`: at least three, at least half), the group leads with it: "One stall, not separate failures. 20 of these 22 runs hit the limit between 12:16 AM and 03:55 AM Oct 13, on 2 machines. None of their sessions ran a turn." Starting them again one by one sends each into the same stall; the fix is where they ran. A timeout's cause key carries no check, so one stall is one heading (it read as three before, split by an unrelated earlier check). A run that ended `deadend` asking a person is not under Failed: it is a `stopped` need and sits under Waiting.
- Row: full problem title, ref (a link to the problem), age. A problem that failed the same way more than once is one row, "2 times". The row's line says only what its heading does not.
- Open, a row is the run page's own step (`RunStep`): what the agent concluded and its tool calls from its session, what it was told; a script's command, its checks table and what it printed. The step page and the run page never tell one visit two ways. Then `Open the run`, `Open the problem`, and the earlier runs of the problem here.
- An open row has one act by state, in the step's head: failed, `Start again, about <d>`; passed, `Mark right` / `Mark wrong` as one two-way control. `Start again` belongs only to a problem's newest visit here while the problem is open: an older visit was already followed by a newer run.
- A failure of a problem closed since (done or dropped, `closedProblems`) is history: it leaves Failed and its count (on the table and the Map too) and sits last under a folded "Failed, problem closed since", with no act.
- A cause is a class of failure, never one problem's sentence (`causeClass`): "ct-59231 has no findings: nothing to work from" heads "No findings: nothing to work from" over every problem it stopped; the ids are on the rows. A long cause stops at its own sentence end, never mid-path.
- A visit is passed only when its step finished. One the run ended under ("Interrupted before it finished", runReport `INTERRUPTED_WORDS`) is failed, whatever its node kept from an earlier round.
- A station that handed the problem back (`blocked`, `needs_context`) failed by its handoff, never by the time limit that closed its session after: its group is "Handed back blocked: needs a person", and the open row's conclusion is the handoff note whole (the evidence, what it tried, what a person must rule on), not the chat line that introduced it.
- "Why it failed" is in words (`stepFailWords`): "Ran out of time: stopped at its 30 min limit", "It handed the problem back blocked, then its session was closed at the 30 min time limit", never the engine's "hand jx747zj killed after 30m at build". An open row links its session once.

**Finder. Job: correct the judge (J8).** Primary: `Judge is wrong` on the open finding (a judge's findings only).
- Work rows are its findings, open is `FindingReader`. Groups, over the Find table's window and counted as it counts them: Filed (to which problem, a link named as the Problems list names it), Marked wrong, Not filed; then "Before this week" ("Earlier" when the window is cut). Each label has one figure: a group's count is its heading, so the table's Not filed is the Not filed heading here; the head's Findings is the table row's figure (`sourcesView finderGroups`, `finderRows`). An open row there leads with `Open in Union`, because a live ask ("Someone needs to dial him now") is acted on in Union, then `Make this a problem` (LJ9 item 9). An open finding reads its whole detail (`signals.detailForWeb`); the feeds carry only its opening words.
- The head shows Findings this week and the Wrong rate from marks.
- A moment's head is words ("Contact conversation", "email sent", the time); its ids and source sit behind one `Ids` control.
- Instructions: what it looks for. `useLoopSteps` returns null over every project, so the page resolves its project from the source's rows (the project most of its findings are filed in) and reads the loop for it; over several projects it lists each project's expectations under the project name.

**Instructions.** `Edit` is the one primary. `Test this edit` and `Save` appear only once there is an edit. `Ask an agent to change it` is a secondary link, always enabled. Today's panels supply the behaviour (`PromptView`, Try, Ask). Every blocked state names the way through:

| Blocked because | The panel shows |
|---|---|
| The line was pushed from another machine | "This line is saved on <teammate>'s machine (<machine>)", named from the graph's owner and the machine roster where the window knows them, with `Ask an agent to change it` as the primary act (it works from any machine) |
| No project in scope | a project picker in the panel, not a sentence sending the person away |
| Editability still loading | the button in a pending state; it never reads as refused |
| No runs to test on | `Test this edit` names what is missing ("no finished run of this step yet"); `Save` stays enabled |

Instructions read every value the runner inserts as what it is (`readableTemplate`): `$branch` reads "(the fix's branch)", `$line.commands.prove` "(the project's prove command)", in code a marked placeholder; a shell's own `$HOME` stays.

Version diff and Restore come after the founder pages (LJ10 step 6).

**Removed.** The drawer, route pill rows, the "edited" pill, the meta line, outcome pills, source chips per row, hash pills, raw result keys, four equal acts on a row, "station / round / visit / handed on / red / mechanism / dissolved".

### LJ8.7 /trial

**Job:** what has the trial cost and what did it produce. Not in the nav. **Entries:** the `Trial` tag on a trial decision's reader, and the trial project's spend on Problems.

- Budget, spend and history stay as they are.
- The lanes stop being places to act. Waiting and Held are counts that link to For you with the need open; Failed and Stopped are counts that link to the problem page, where the act lives.
- A trial card with a session decision is a `decision` need and renders `LineDecision`. One without (a Held card) is a `reask` need: `TrialCardPanel` as the shell, the session's question in full, and `Ask me again`. A Failed card is the problem's Failed band state with the step's reason.
- A Stopped run (it reached a `failed_at_*` step with the problem open) asked nobody anything: its station gave up and filed a handoff. The failure step's comment carries only the session's state (`work_state: needs_input`), so the pane shows that station's handoff whole (task evidence `verification_evidence`): outcome, what it measured, what it would try next. ct-59445: Build reported `strategy_fails`, built, measured and reverted. Its act is `Rerun from main`, a new run that investigates and proposes again. On Problems such a problem is Failed at that step (never In review, whatever status the handoff left), and a Failed group's trial problems link to the trial's Stopped or Failed list rather than starting through a lead's line.
- The open list is in the address (`tab=waiting|held|failed|stopped|...`), beside `card`, so a list is linked and reloaded; every Trial tag carries the card it came from. Held is always counted, zero included.
- `Rerun from main` goes through the review.
- The card's facts (Checks, Proof, Diff) follow the rule of Change and Proof: a stat as text until it can be read, then a link. The facts strip is jx7d8av's; the request is in the one message (LJ9 item 11).

## LJ9. Backend ledger

Each line is an act or a fact the pages name, whether its backend exists, and what the page shows until it does. Rule 4: nothing here ships as a dead control. A convex change deploys through `packages/convex/deploy.sh` before the web that calls it.

| # | Needed | Exists | Until it does |
|---|---|---|---|
| 1 | Answer a lapsed fix decision from its stored content; the answer resumes the run at Ship from the saved branch | no | `lapsed` is uncounted, first in "Needs a new ask"; the act is `Start a new run to ask again` (`startLineCause`). Built in step 1. |
| 2 | A view ref on a finding (`union:<view>/<uuid>[@iso]`) | for judge findings, through `signal.moment` and MomentView (807 of 1039). Missing for person, agentwatch, escalation, desk and invariant findings; ProductView has no view for an agent run. | Full `detail_md` and the `evidence_url` link. Needs Union's finders to stamp `view_ref` (contact or call id) at filing; a codecast change cannot supply it. |
| 3 | Titles and `readiness_note` stored whole | no. The note is cut in the reply parser: `shared/contracts/goalsBrief.ts:355`, `oneLine(str("note")).slice(0, 500)`. Titles are cut at 200 with "…" (ct-59561, ct-58683) by a writer not yet found: it is not `lineRetitle` (`TITLE_MAX` 90). | Raise the cap at `goalsBrief.ts:355` and cut at a sentence end when over. Cut notes cannot be restored (the full note is stored nowhere): the reader ends a note of exactly 500 characters at its last full sentence, and the problem's findings carry the rest. Grounding again is a paid decision this workflow does not make. Titles: find the writer first; the fix is `lineRetitle` on the affected problems or the first finding's `title` (capped at 300 in `signals.ts`). |
| 4 | Store an answer for a `reask` need and hand it to the run at its ask step | no. A text field on the task that the run reads. | Uncounted; `Ask me again`, one click (`trialReask` for a trial card; the machine must be online). Built in step 1. |
| 5 | The for-you feed across every process | partly: `allInbox` is cross-process; `lineCards` is fed only for the drawn process's projects | Mount the `lineCards` feeder for every project with a cause; `lineNeeds` selects. |
| 6 | Read a run's branch diff and test output | no | Change shows the stat and the PR link; Proof shows the run model's red and green outcomes. |
| 7 | Who closed a problem, when, why; reopen | no | "Closed Oct 9", no Reopen. |
| 8 | Failure reason at the first step that failed | no: the engine reports the step that received nothing | Derived on the client: the earliest visit with a failure outcome (step 1). The engine string sits behind a disclosure. |
| 9 | Finding acts: Make this a problem, Not this problem, Add to a problem, Dismiss | `Make this a problem` yes (dispatch `makeProblemOfFinding`, `signals.ts makeProblemOfFindingCore`: a problem of its own with every finding held under its key). The other three no. | `Make this a problem` on an open unfiled finding, after `Open in Union`. Not filed carries its count, the Find table's. `Judge is wrong` exists for judge findings. Handing a finding to a person has no backend: make it a problem, then assign the problem. |
| 10 | The need's kind (confirm or question) written by the ground step | no | `askParts`; an answer is required when the question ends in "?" or contains " or ". |
| 11 | From jx7d8av, one message at step 1: `onAnswered`; a title that wraps (`.ld-title` is one line, 46ch); whether an `inline` variant (auto height, dock sticky to the viewport) is preferred over the fixed box; an answer slot for a lapsed decision (item 1); the trial facts strip's Checks, Proof and Diff as links when readable | asked once | The fixed box; the list advances on the store's row leaving. |
| 12 | Holder and question on line cards: `shapeCard` (`convex/lineWorkspace.ts`) adds `holder`, `asked_user_ids`, `question` | no: the holder is only in the per-decision detail, loaded after it opens | The group and the status read "Waiting on someone else". |
| 13 | Whether a merged fix is in production; what deploys a project; the last production deploy (link) | partly: `CauseHistory.ships[].deploys` and `coverage` (`known`, `none`, `unread`). Only production deploys are recorded, and codecast does not deploy a customer's project. | `known` and no deploy: "Merged, not in production" with the commit or PR link and the last recorded production deploy. `none`: "Merged Oct 10", "In production: not recorded for this project". `unread`: the merged date only. No "put it in production" control is drawn. |
| 14 | Approve a run that finished a step with no next step, resuming it | no | `stopped` is uncounted; `Start a new run to ask again`. |
| 15 | Answer a parked run and resume it | yes for a problem with no live run: `answerProblem` marks it ready and the sweep starts it. For a run parked at a Park step: check in step 1 whether parking ends the run and returns the problem to `needs_context`. | If it does, the same Ask block. If not, the problem is a `stopped` need until the resume exists. |
| 16 | The ground step writes the refs its question names (person, call, conversation) on the task | no | Ids in the question text are linked by lookup; names that do not resolve stay text with `Open in Union`. |
| 17 | `Start these again` for a cause group | yes: `startLineCause` per problem | Through `startTheseAgainLedger`. |
| 18 | A duration for a full run | no helper | `lib/line/runDuration.ts` (LJ6.6); no duration under 3 finished runs. |

## LJ10. Build order

Each step leaves /line better than it found it and names the plan task it belongs to.

0. **Truth first** (ct-59700). Done, in the log: judge findings carry `moment` and open through MomentView; other findings carry only `evidence_url`; the store holds few findings before a problem opens; the note is cut at `goalsBrief.ts:355`. Left: whether a ProductView frame mints from localhost; whether call 94373d15 and Quinn in ct-58311's question resolve to full ids; the writer that cuts titles at 200; whether a Park step ends its run (item 15). Raise the note cap.
1. **Decide where you are** (ct-59699). `lineNeeds` with all six kinds, `WaitingItem` with the host contract, the URL model with legacy redirects and the key change, For you as the landing page, and `WaitingItem` mounted on the step's Waiting rows, the graph count, the run page's person step and the problem page band. The one message to jx7d8av (item 11). With it, the backends that make "Needs a new ask" answerable, before For you is called done: item 4 (the stored answer), item 1 (answer a lapsed decision), item 12 (holder on cards). Also the client derivation of the first failed step (item 8), `runDuration` and the two ledgers. This closes "I click decide and what?" from every entry.
2. **See the real thing** (ct-59700). `FindingReader` by finding kind; the problem page: head with the six-stage `StageTrack`, the act band for every state in LJ8.3, Findings, Work. Delete Came from, tiles, pills, the big chart.
3. **Pages cut to their job** (ct-59701). Problems: the three figures, four columns, the status partition with its unit test, the Failed group by cause, Not started as the home of the start control. Nav to three entries; Runs list, Sources, Chat, Notebook and the header chips deleted behind redirects. /trial reduced to its job.
4. **Line and step page** (ct-59701). The summary row, Steps table worst first, Find table, stripped Map; the three step page variants; Instructions with a way through every blocked state.
5. **Backend that turns fallbacks into answers.** Item 9 `Make this a problem` first, then 14, 15 (if needed), 6, 7, 16, 8 in the engine. As each lands its row in LJ9 flips.
6. **Operator depth.** Version diff and Restore, the remaining finder acts, marked rows as attachments. Outside codecast: Union's finders stamping `view_ref` (item 2).

Answer paths that cannot be exercised on real data (answering, starting a line, starting again) are covered by mount tests on fixtures (`LineDecisionBody`, `SwitchReview` with each ledger) and by `lineNeeds` and `problemTable` unit tests over captured rows.

## LJ11. Words

| Was | Is |
|---|---|
| card, "Get a new card", "card unanswered" | decision; "Ask me again"; "asked, no answer" |
| Ask again / Re-ask / Runs to ask again | Needs a new ask |
| Not shipped: no answer | Asked, no answer |
| Finished without choosing a next step | <step> finished: go on to <next stage>? (or "<step> ended without a report" when it said nothing) |
| New, confirm | New: is this real? |
| Pipeline health | Failed |
| Open (when the line is off) | Line off |
| Auto-start, waiting N | ready N, blocked N |
| held (a problem that cannot start) | blocked, with the reason: "Not grounded yet", "Needs a goal", "Assigned to <name>", "Nothing to change" |
| held (a fix with no finding since) | quiet since the fix |
| Held by Cam | Waiting on Cam; "Waiting on someone else" until the holder is known |
| parked: not ready to build | Needs a fact from you |
| parked until more findings; inbox "watching" | Waiting for more findings |
| Watching | only for a fix in production: "In production, watching until Oct 18" |
| red, mechanism, dissolved, handed on | reproduced: its test fails without the fix (a Prove pass, never worded as a failure); cause found; turned out not to be a problem; passed on |
| station, visit, round, rung | step; (dropped) |
| Came back | Returned after the fix |
| off topic | about something else |
| ungrouped, waiting to group | not filed |
| Person / Agent / Agent · Aivery / app:union | the finder's one name |
| not shipped / not deployed / shipped / merged | built (on its branch); merged; in production. "Shipped" alone is not used. |

## LJ12. The tester's tasks

Run each from a cold load of `/line` on real data, in a tab of your own. Never change real state: drive each flow to its last step and stop before the final press. Confirm by reading the DOM as well as by screenshot. A task passes only when every "done" line is true. On every page: no disabled primary button without an enabled alternative beside it, and no sentence that repeats the StageTrack line.

1. **Clear the top of the queue.** Open `/line`. Done: the page is For you with no process picker; the first row is selected and the reader shows a live fix decision (sd-600 on ct-59338 when it is still open, else the first in "Fixes to decide") with its question, today and what changes, proof, and enabled Ship / Revise / Drop; no click was needed; the title appears once. The nav count equals the number of rows in the counted groups. Stop before pressing an answer.
2. **"I click Decide and what?"** <KeyCap>G</KeyCap> <KeyCap>L</KeyCap>, switch to Map, click the Decide node, then go back and click its waiting count. Done: both land on the step page, Work, `show=waiting` in the URL, with the first waiting decision expanded as the same `LineDecision` with enabled answers, its answers docked inside a box with no second page scroll; the number of Waiting rows equals the count clicked; no A/B/C rows with key caps exist anywhere on the page.
3. **The same decision from a problem and from its run.** Open ct-59561 from Problems. Done: sd-615 is open in the act band without `?decision=` in the URL, the state line reads "Waiting on someone else" (or the holder's name once ledger item 12 has landed), and the answers are enabled. Open its newest run. Done: the Decide step is selected and the same decision is embedded there; there are no inert Ship / Revise / Drop chips and no bare "sd-615" link as the only route.
4. **Answer a question that needs a lookup.** In For you open ct-58311 (has Quinn left, or is Riley wrong). Done: the full question ends at a sentence end; "What this asks about" lists what the question names, and Quinn's Union person screen or call 94373d15 opens in place when its id resolves, else it is text with `Open in Union`; the cited findings are listed in full text, each with its Union link; the answer box and `Answer` are present and the label says whether it starts now, is queued, or waits on a line that is off. Type nothing; stop.
5. **Is this problem real?** In For you, under "New: is this real?", open ct-58683. Done: the question ends at a sentence end, not at "or from th"; the finding it rests on is open in the reader in full; `Answer` and `Not a problem` are in the reader, and no row in the list carries a Confirm button. Stop before pressing.
6. **A built fix nobody answered.** Open ct-58282. Done: it is not in the For you count; it is the first row under "Needs a new ask", which is open; the act band shows sd-557's proposal and proof in full, fact rows Branch and Asked, and two acts, the card's recommended one first: `Drop: close the problem` (starts nothing) and `Ask again (new run, ~$N)`; the state "Asked Oct 10, no answer" appears once, on the StageTrack line; pressing the act opens a review that says what starts, what it costs and that the branch is reused. Close the review; do not confirm. Work › Run 3 shows Found, Change, Proof and Outcome "above", with no "Get a new card", no static Card panel and no pill row.
7. **Did the fix work, do customers have it?** Open ct-57509. Done: the page says whether customers have the fix. If not, the band names what is missing: the merge date with its commit or PR link, "In production: no" and the last recorded production deploy, or "not recorded for this project"; no watch dates are shown for a fix that is not in production. It sits under its own chip on Problems ("Approved, not merged" when it never merged, else Merged), not In production, and is not counted in "quiet since". Nowhere on the page do "not shipped", "not deployed", "shipped" and "merged" disagree.
8. **A closed problem.** Problems, `Closed` chip, open ct-57442. Done: the band says when it was closed (and who and why once ledger item 7 has landed); prev and next are enabled and walk the closed list; Back returns to Problems with the Closed chip still on and the scroll kept.
9. **Why is nothing happening?** <KeyCap>G</KeyCap> <KeyCap>P</KeyCap>, click `Not started`. Done: the chip's count equals the rows shown; the group is open; Callers & Call Management is a sub-group whose header reads `<ready> ready · <blocked> blocked`, summing to the rows beneath, with `LineStartControl`; every blocked row says its reason; pressing the control opens the review naming what starts now and per day, whose ready figure equals the header's ready count, now plus "more" equals it, Blocked equals the header's blocked, and every name under Starting is a row here reading Ready or Queued. Close it; do not confirm. Line shows only the summary row linking back here. No bare "Turn on" exists on any page, and no second start control.
10. **A step keeps failing.** <KeyCap>G</KeyCap> <KeyCap>L</KeyCap>, the Steps table runs in the line's order under phase headings, and the bar names the failed total in red; find Prove under Prove and click its Failed count. Done: the step page opens with `show=failed`; failures are grouped under a cause in plain words with a count, and the heading carries `Edit instructions`; opening the row for ct-59565 shows what it was given, what it concluded and the failing output, with a reason, one act, and no raw JSON, "Rung", "Red" or machine path. Open Instructions: `Edit` is the one primary; when this machine cannot save, the panel names the machine and `Ask an agent to change it` is enabled. Stop before confirming anything.
11. **Can I trust this judge?** In Line, Find table, open Comms judge. Done: its findings are listed; opening one shows the conversation in place with the judged words marked; `Judge is wrong` is visible on the open finding; the head shows a wrong rate. Open Escalation: no finding there offers `Judge is wrong`, an unfiled finding opens with `Open in Union` first, and no red count calls unfiled findings failed. Stop before pressing.
12. **Old links and Back.** Load `/line?view=inbox`, `?view=runs`, `?view=sources`, `?view=chat`, `?view=process&mode=notebook`, `?decision=sd-600`. Done: each lands on its new home (For you, Problems, Line, Line, Line, For you with that decision open and `need=` in the URL) with nothing blank. Then from For you open a problem, a finding and a run, and press Back three times. Done: each press returns one level, to the same filter, open item and scroll. Typing in search adds no Back step.
13. **The chips are a partition.** On Problems read every chip. Done: the counts sum to All; each chip's count equals its rows; clicking "5 in production" and "4 of 5 quiet since" narrows to exactly that many rows. Click `Failed`. Done: failures are grouped by cause, the ct-5xxxx rows of one outage sit under one heading, and the heading's `Start these again` opens a review naming the count, total cost and total time. Close it.
14. **A parked problem.** Open ct-59687 from Problems. Done: its status reads "Needs a fact from you" (or "Waiting for more findings" if that is why it parked); the reason is readable in full on the problem page; when a fact is asked, the answer box is in the band, not only on the run's Park step.
15. **Keys cannot answer.** In For you with a real decision open, click once inside the decision, then press <KeyCap>G</KeyCap> <KeyCap>P</KeyCap>, <KeyCap>J</KeyCap>, <KeyCap>K</KeyCap>. Done: no decision state changes (read the store's decision row before and after) and no shell key draws a digit KeyCap. Do not press a digit, <KeyCap>X</KeyCap>, <KeyCap>T</KeyCap> or <KeyCap>Enter</KeyCap> while focus is in the decision: those answer it.
16. **A run that needs a yes is not a failure.** Find the run whose Prove step ended "Finished without choosing a next step" and whose last message says the fix needs Cameron's yes. Done: its problem is under "Needs a new ask" on For you and Problems, reads "Stopped at Prove: needs your yes", shows that last message in full, and is not under Failed on the Prove step page.
17. **/trial.** Open a trial decision in For you and click its `Trial` tag. Done: /trial shows spend and history; its Waiting, Held, Failed and Stopped are counts that link out; the Trial tag opens the card it came from; ct-59445 opens under Stopped with Build's handoff in full and `Rerun from main`, and Problems files it Failed at Build.
