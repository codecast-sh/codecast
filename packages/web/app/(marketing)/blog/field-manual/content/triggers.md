Most agent work has a tail. You push a fix and someone should check CI in twenty minutes. A pull request is open and someone should answer the review comments when they land. Main moves overnight and the docs index needs a rebuild. Without help, that someone is you, polling.

A codecast trigger is a prompt with a clock or an event attached. When it fires, codecast runs a real agent session: either back in the conversation that set it up, with its full history, or in a fresh session. Every trigger has a short id like `tr-42` and a page of its own. Agents arm their own follow-ups (an agent that pushes a fix sets itself a "check CI in 30 minutes"), and you can create one from the Triggers page. Most runs finish quietly. The ones that need a person stay in front of you.

![The triggers feature page hero 'The work keeps going after you close the laptop': a timeline 'One night, six triggers' from 18:00 to 09:00 with lanes tr-41 (in 30m), tr-43 (every 4h, fresh session), tr-44 (every 1h with a precheck, mostly hollow skip markers), tr-45 (on PR comment), tr-46 (every 1d, read-only, a hatched park at a usage limit), tr-47 (on a new Sentry error, one red mark); below, an overnight log and a summary: 24 firings, 12 skipped by a precheck with no session spent, 12 agent sessions ran, 1 parked at a usage limit then resumed, 1 needs you: tr-47 in the inbox](/blog/field-manual/triggers-nightshift.webp "The night shift, from `/features/triggers`: six triggers, 24 firings, 12 of them skipped by a precheck that spent nothing, one run parked at a usage limit and resumed, and exactly one item waiting at 09:00.")

## Three clocks

- **Once, after a delay.** Follow-through on work that just shipped: "check CI in 30 minutes".
- **On a schedule.** A standing duty: every 4 hours, every morning at 9. Each run is counted from when it was due, so a daily check never drifts later by its own runtime, and a run that outlasts its interval skips the missed slots instead of firing them all at once.
- **On an event.** A pull request opened, commented on, failing checks, green, conflicting or merged; an issue opened or assigned in GitHub or Linear; or a signal from your running product (a new error, an error spike, a metric alert, a deploy, a failed job). Events that arrive while a run is working are kept for the next run, not dropped.

## The Triggers page

**Triggers** in the sidebar (or the palette) is the control room. A sentence at the top sums it up: how many are active, recurring and one-time, what is running now or fires next, and either "healthy" or how many failed their last run. Below it, a timeline spans the last and next 24 hours with a dot for every past and upcoming run. A trigger that failed its last run gets a red banner with its summary, one click from the run.

The list groups triggers by the session that owns them (or by project), with Active, Paused and History sections. Each row reads in three lines: the title, its cadence and when it fires next; a one-line description; and the last outcome (ok, failed or flagged), how long ago, how many runs, and the last run's summary. Hover a row to see its run history, edit it, run it now, or pause it. Filters cut the list by kind (recurring, one-time, event), by whether runs may make changes or only read, by project and by agent. History keeps finished triggers with a success-rate bar and a "failures only" switch.

**New** opens a form: the prompt, a title, when it should run (now, after a delay, on a schedule, on an event), which agent runs it, the project, and a read-only switch.

## A trigger's own page

Open one and you get everything about it. The header carries the id, a status chip (running, due in 12m, paused, failed, done), the cadence, and **Run now**, **Pause**, **Edit** and **Cancel**. Below it: when it fires next, a progress bar through the current cycle, how many runs, and a warning when several attempts in a row have failed. The prompt is there in full, with links to the session that created it and the session its runs land in.

The run history is a timeline, newest first. Each run shows its number, when it ran and the summary it left, and clicking it opens the exact message where that run began. Runs skipped by a precheck (below) show as hollow rows, so you can see the gate doing its job.

The same trigger is visible from the conversation it belongs to: a strip above the thread shows the cadence, a countdown to the next run, the last outcome and the same Run now, Pause and Cancel controls. When a run arrives in a conversation it opens with a violet **TRIGGER RUN** label, the prompt (folded), and what the previous run concluded, in red if it failed.

## In this thread, or a fresh session

A trigger set up inside a conversation runs back in that conversation by default: the run arrives as a new turn with the whole history behind it, and its answer lands where the question was asked. That is right for follow-through that needs what this conversation knows and fires once or a few times. It is wrong for anything that repeats, because every firing reloads the whole history and buries the thread.

So a repeating job usually runs in a fresh session each time, carrying only its prompt plus the previous run's summary. Those runs do not crowd your inbox: an uneventful run folds into its schedule's single row, and the session that armed it is woken only if a run fails, dies without reporting, or asks for attention.

![The triggers page section 'Run it here, or in a fresh session': on the left, a conversation where the agent pushed a fix and set a check for 30 minutes later, then 'tr-41 fired 18:40' and the answer arrived as a new turn; on the right, tr-43 every 4h with four fresh-session runs, the fourth flagged as needing attention and waking jx7dhfh; below, a table 'What reaches you' for fires once, repeats, and fails/dies/asks](/blog/field-manual/triggers-where.webp "The two homes for a run, and exactly what reaches you in each case.")

## A precheck: spend nothing when nothing changed

Most repeating jobs ask a question whose usual answer is no. Has main moved? Is the queue empty? Without a gate, a whole agent session is spent finding out. A trigger can carry a precheck: a quick shell test run in the project before each scheduled firing. If it passes, the agent runs. If not (or it takes over a minute), the firing is recorded as skipped and the trigger waits for its next slot. A skip is not a failure, so it never burns a retry. The trigger's page shows the precheck and when it last skipped and why. Event triggers ignore it, because the event is already the reason to run, and so does **Run now**.

![The triggers page section 'A gate that costs nothing when the answer is no': a day of tr-44 every 1h, fourteen hourly boxes, eleven dashed boxes reading 1 (skip recorded) and three green boxes reading 0, each green one dropping to a dot for an agent session; header '14 firings · 11 skipped · 3 sessions'](/blog/field-manual/triggers-precheck.webp "Fourteen firings, three sessions. The same gate lets an overnight loop drain a task queue and spend nothing once the queue is empty.")

## Every run says who acts next

A run ends by writing a summary of what it found, and by saying whether a person needs to act. Nothing to act on: the run folds into the trigger's history, where its summary waits for whenever you look, and a quiet trigger reads as quiet, not broken. Something to act on: the run is flagged, its row turns red, it stays in your inbox until read (a stashed session is pulled back in), and the session that armed it is woken. A run that ends without reporting at all is caught too, and the arming session is told with a link to the transcript.

![The triggers page section 'Every run says who acts next': a toggle between 'a clean run' and 'needs attention', and a diagram where the run of tr-47 goes either to 'trigger history, read when you look' or, dashed in red, to 'your inbox, stays until you act'](/blog/field-manual/triggers-report.webp "Two destinations for a finished run: the trigger's history (read when you look) or your inbox (stays until you act).")

## Built to be left alone

- **Read-only runs.** A trigger marked read-only gets its write tools removed and state-changing commands blocked: right for watchers that should look and report, never touch. It is a guard on what the agent may do, not an isolated machine.
- **Usage limits pause, they do not fail.** A run that hits a limit parks and resumes its session when the window resets, keeping its context and spending none of its retries; with account switching on it can move to a saved account with room.
- **Failures are visible.** A failed run retries after a short backoff, three attempts in all, then the trigger is marked failed, one click from the transcript.
- **Each firing runs once,** even with several machines online, and every run has a time cap (10 minutes unless set higher).
- **Cleanup is symmetric.** Killing a session cancels its triggers; restoring it re-arms them.

Runs execute on the machine where the trigger was armed, in that checkout. A laptop that is asleep when a trigger comes due runs it on wake; for work around the clock, arm triggers from a session on a cloud host.

![The product film's Automate chapter: a workflow graph Implement, Verify (with a failure loop back to Implement), success, Review; trigger rows 'Check CI every 4h' (ok 2s ago, 12 runs, ct-4182 passed verify) and 'Answer PR review comments' (on PR comment, event, 7 runs); a pinned NEEDS INPUT state 'Waiting on review of ct-4182'; and a run panel 'ship paused at Review' with Implement and Verify checked and the Review gate pending](/blog/field-manual/triggers-gate.webp "From the film: the &quot;Check CI every 4h&quot; trigger fires a workflow (implement, verify, review) that pauses at a human gate. A trigger decides when something runs; a workflow decides what runs in what order.")

> **Why it matters.** Scheduled agents are easy to build and expensive to leave running: every firing is a full session, and every result is something to read. Codecast attacks both costs. A precheck means a firing whose answer is "nothing changed" costs a shell command, not a session. Fresh sessions keep repeating work out of the long thread it would otherwise reload. And because a run has to say whether it needs you, the default outcome is silence, so the one run that needs you is not buried under eleven that did not.
