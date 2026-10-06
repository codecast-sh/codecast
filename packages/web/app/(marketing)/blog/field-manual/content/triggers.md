Most agent work has a tail. You push a fix and someone should check CI in twenty minutes. A pull request is open and someone should answer the review comments when they land. Main moves overnight and the docs index needs a rebuild. Without help, that someone is you, polling.

A codecast trigger is a prompt with a clock or an event attached. When it fires, codecast runs a real agent session: either back in the conversation that set it up, with its full history, or in a fresh session. Agents arm their own follow-ups (one that pushes a fix sets itself "check CI in 30 minutes"), and you can create triggers from the Triggers page. Most runs finish quietly; the ones that need a person stay in front of you.

![The triggers feature page hero 'The work keeps going after you close the laptop': a timeline 'One night, six triggers' from 18:00 to 09:00, one lane per trigger tr-41 to tr-47, with hollow markers for precheck skips, a hatched park at a usage limit and one red mark; below, a summary: 24 firings, 12 skipped, 12 sessions ran, 1 needs you](/blog/field-manual/triggers-nightshift.webp "The night shift, from `/features/triggers`: six triggers, 24 firings, 12 of them skipped by a precheck that spent nothing, one run parked at a usage limit and resumed, and exactly one item waiting at 09:00.")

## Three clocks

- **Once, after a delay.** Follow-through on work that just shipped: "check CI in 30 minutes".
- **On a schedule.** A standing duty: every 4 hours, every morning at 9. Runs keep to their slots, so a daily check never drifts later, and a run that outlasts its interval skips missed slots rather than firing them all at once.
- **On an event.** A pull request comment, failing checks, a merge; a GitHub or Linear issue; a new error or alert from your running product. Events that land mid-run wait for the next run.

## The Triggers page

**Triggers** in the sidebar is the control room. One sentence at the top sums it up (how many are active, what fires next, "healthy" or how many failed their last run), and a timeline spans the last and next 24 hours with a dot for every run. A trigger that failed its last run gets a red banner, one click from the run.

Triggers are grouped by the session that owns them. Each row shows the title, cadence and next fire, then the last outcome (ok, failed or flagged), how many runs, and the last run's summary. Hover a row to run it now, pause it, edit it or see its history. **New** opens a form: the prompt, when it runs, which agent, the project, and a read-only switch.

## A trigger's own page

A trigger's page carries a status chip (running, due in 12m, paused, failed), **Run now**, **Pause**, **Edit** and **Cancel**, the full prompt, and its run history: a timeline where each run shows when it ran and the summary it left, and clicking it opens the exact message where that run began. Runs skipped by a precheck (below) show as hollow rows.

The conversation a trigger belongs to shows it too: a strip above the thread with a countdown to the next run, the last outcome and the same controls. A run that arrives in a conversation opens with a violet **TRIGGER RUN** label and what the previous run concluded, in red if it failed.

## In this thread, or a fresh session

A trigger set up inside a conversation runs back in it by default: the run arrives as a new turn with the whole history behind it. That suits follow-through that fires once or a few times. A repeating job instead runs in a fresh session each time, carrying only its prompt and the previous run's summary, because every inline firing would reload the whole history and bury the thread. Those runs do not crowd your inbox: an uneventful one folds into its schedule's single row, and the session that armed it is woken only if a run fails, dies without reporting, or asks for attention.

![The triggers page section 'Run it here, or in a fresh session': on the left, a conversation where the agent pushed a fix and set a check for 30 minutes later, then 'tr-41 fired 18:40' and the answer arrived as a new turn; on the right, tr-43 every 4h with four fresh-session runs, the fourth flagged as needing attention and waking jx7dhfh; below, a table 'What reaches you' for fires once, repeats, and fails/dies/asks](/blog/field-manual/triggers-where.webp "The two homes for a run, and exactly what reaches you in each case.")

## A precheck: spend nothing when nothing changed

Most repeating jobs ask a question whose usual answer is no: has main moved, is the queue empty? A trigger can carry a precheck, a quick shell test run before each scheduled firing. If it passes, the agent runs. If not, the firing is recorded as skipped (not failed, so it burns no retry) and the trigger waits for its next slot. Event triggers and **Run now** skip the gate, since they already have a reason to run.

![The triggers page section 'A gate that costs nothing when the answer is no': a day of tr-44 every 1h, fourteen hourly boxes, eleven dashed boxes reading 1 (skip recorded) and three green boxes reading 0, each green one dropping to a dot for an agent session; header '14 firings · 11 skipped · 3 sessions'](/blog/field-manual/triggers-precheck.webp "Fourteen firings, three sessions. The same gate lets an overnight loop drain a task queue and spend nothing once the queue is empty.")

## Every run says who acts next

A run ends with a summary and a verdict on whether a person needs to act. If not, the run folds into the trigger's history, and a quiet trigger reads as quiet, not broken. If so, the run is flagged, its row turns red, and it stays in your inbox until read. A run that ends without reporting at all is caught too, with a link to its transcript.

![The triggers page section 'Every run says who acts next': a toggle between 'a clean run' and 'needs attention', and a diagram where the run of tr-47 goes either to 'trigger history, read when you look' or, dashed in red, to 'your inbox, stays until you act'](/blog/field-manual/triggers-report.webp "Two destinations for a finished run: the trigger's history (read when you look) or your inbox (stays until you act).")

## Built to be left alone

- **Read-only runs** lose their write tools: right for watchers that should look and report, never touch.
- **Usage limits pause, they do not fail.** The run parks and resumes when the window resets, context intact, retries unspent.
- **Failures retry** three times with backoff, then the trigger is marked failed, one click from the transcript.
- **Each firing runs once,** even with several machines online, under a time cap.
- **Killing a session cancels its triggers;** restoring it re-arms them.

Runs execute on the machine where the trigger was armed. A sleeping laptop runs what came due when it wakes; for work around the clock, arm triggers from a cloud host.

![The product film's Automate chapter: a workflow graph Implement, Verify (with a failure loop back to Implement), success, Review; trigger rows 'Check CI every 4h' (ok 2s ago, 12 runs, ct-4182 passed verify) and 'Answer PR review comments' (on PR comment, event, 7 runs); a pinned NEEDS INPUT state 'Waiting on review of ct-4182'; and a run panel 'ship paused at Review' with Implement and Verify checked and the Review gate pending](/blog/field-manual/triggers-gate.webp "From the film: the &quot;Check CI every 4h&quot; trigger fires a workflow (implement, verify, review) that pauses at a human gate. A trigger decides when something runs; a workflow decides what runs in what order.")

> **Why it matters.** Scheduled agents are easy to build and expensive to leave running: every firing is a full session, and every result is something to read. Codecast attacks both costs. A precheck means a firing whose answer is "nothing changed" costs a shell command, not a session. Fresh sessions keep repeating work out of the long thread it would otherwise reload. And because a run has to say whether it needs you, the default outcome is silence, so the one run that needs you is not buried under eleven that did not.
