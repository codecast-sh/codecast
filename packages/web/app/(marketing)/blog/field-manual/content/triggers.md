Most agent work has a tail. You push a fix and someone should check CI in twenty minutes. A pull request is open and someone should answer the review comments when they land. Main moves overnight and the docs index needs a rebuild. Without help, that someone is you, polling.

A codecast trigger is a prompt with a clock or an event attached. When it fires, codecast runs a real agent session: either back in the conversation that armed it, with its full history, or in a fresh session. Every trigger gets a short id like `tr-42` and a page in the web app. Agents arm their own follow-ups (an agent that pushes a fix sets its own "check CI in 30m"), and most runs finish quietly. The ones that need a person land in your inbox.

![The triggers feature page hero 'The work keeps going after you close the laptop': a timeline 'One night, six triggers' from 18:00 to 09:00 with lanes tr-41 (--in 30m), tr-43 (--every 4h --spawn), tr-44 (--every 1h --spawn --precheck, mostly hollow skip markers), tr-45 (--on pr_comment), tr-46 (--every 1d --spawn --safe, a hatched park at a usage limit), tr-47 (--on error_new --source sentry --spawn, one red mark); below, an overnight log and a summary: 24 firings, 12 skipped by a precheck with no session spent, 12 agent sessions ran, 1 parked at a usage limit then resumed, 1 needs you: tr-47 in the inbox](/blog/field-manual/triggers-nightshift.webp "The night shift, from `/features/triggers`: six triggers, 24 firings, 12 of them skipped by a precheck that spent nothing, one run parked at a usage limit and resumed, and exactly one item waiting in the inbox at 09:00.")

## Three clocks

```terminal
$ cast trigger add "Check if CI is green on main" --in 30m
+ Trigger tr-41 in 30m: Check if CI is green on main

$ cast trigger add "Review open PRs and summarize findings" --every 4h --spawn
$ cast trigger add "Respond to new PR review comments" --on pr_comment --pr 482
$ cast trigger add - --every 7d --spawn --title "Weekly blog post" <<'EOF'
…a full brief, goal, numbered steps, constraints…
EOF
```

- **`--in 30m`**: once, after a delay. Follow-through on work that just shipped.
- **`--every 4h`**: a standing duty. Pair it with `--in` to set the first run, which fixes the time of day. Each run re-arms on its slot, counted from when it was due, so a daily check never drifts later by its own runtime, and a run that outlasts its interval skips the missed slots instead of firing them all at once.
- **`--on <event>`**: a webhook event. Pull request events (`pr_opened`, `pr_comment`, `pr_check_failed`, `pr_checks_green`, `pr_conflict`, `pr_merged` and more), issue events from GitHub or Linear, and events from your running product through a source (`error_new`, `error_spike`, `metric_alert`, `deploy`, `job_failed`). Narrow with `--repo`, `--pr` or `--source`. Events that arrive while a run is working are kept for the next run, not dropped.

## Here, or `--spawn`

A trigger armed inside a session runs back in that session by default: the run arrives as a new turn with the whole conversation behind it, and its answer lands where the question was asked. That is right for follow-through that needs what this conversation knows, firing once or a few times. It is wrong for anything that repeats, because every inline firing reloads the whole history (the prompt cache has long expired) and buries the thread.

Add `--spawn` and each run starts a fresh session that carries only its prompt plus the previous run's summary, so the prompt is written as a full brief. Spawned runs nest under the session that armed them, never as separate inbox cards. A once trigger posts its clean result back as a message without waking the thread (`--wake` wakes it); a repeating one posts nothing on a clean run (`--thread` posts each result). Either way the arming session is woken if a run fails, dies without reporting, or asks for attention.

![The triggers page section 'Run it here, or in a fresh session': on the left, a conversation where the agent pushed a fix and set 'cast trigger add ... --in 30m', then 'tr-41 fired 18:40' and the answer arrived as a new turn; on the right, tr-43 every 4h with four fresh-session runs, the fourth flagged '--needs-attention: wakes jx7dhfh'; below, a table 'What reaches you' comparing here and --spawn for fires once, repeats, and fails/dies/asks](/blog/field-manual/triggers-where.webp "The two homes for a run, and a table of exactly what reaches you in each case.")

## `--precheck`: spend nothing when nothing changed

Most repeating jobs ask a question whose usual answer is no. Has main moved? Is the queue empty? Without a gate, a whole agent session is spent finding out. `--precheck <command>` asks with a shell command first, in the project directory, before each scheduled or recurring firing. Exit 0 runs the trigger. Any other exit, or 60 seconds without an answer, records a skipped run and re-arms on the normal cadence. A skip is not a failure, so it never burns a retry. Event triggers ignore the gate (the event is already the reason to run), and so does a manual `cast trigger run`.

```terminal
$ cast trigger add "Review what landed on main" --every 1h --spawn \
    --precheck 'test "$(git rev-parse origin/main)" != "$(cat .last-reviewed)"'

$ cast trigger log tr-44
Precheck: test "$(git rev-parse origin/main)" != "$(cat .last-reviewed)"
skipped 12m ago, precheck exited 1
```

![The triggers page section 'A gate that costs nothing when the answer is no': a day of tr-44 every 1h, fourteen hourly boxes, eleven dashed boxes reading 1 (skip recorded) and three green boxes reading 0, each green one dropping to a dot for an agent session; header '14 firings · 11 skipped · 3 sessions'](/blog/field-manual/triggers-precheck.webp "Fourteen firings, three sessions. The `/cast-loop` skill uses the same gate to drain a task queue overnight: its precheck fails when `cast task ready` comes back empty, so an idle loop spends nothing.")

## Completion: every run says who acts next

A fired run receives your prompt, its trigger id, and its contract: finish with `cast trigger complete <id> --summary "…"`. The summary is what you read later, so it states the outcome. The flag decides whether you read it at all. Without `--needs-attention`, nobody needs to act: the run folds into the trigger's history, where every firing links to the conversation it produced, and a quiet trigger reads as quiet, not broken. With it, the run declares itself blocked and stays in your inbox until read; a stashed or killed session is pulled back into the queue, and a `--spawn` trigger also wakes the session that armed it. A run that ends without reporting is caught too: the arming session is told, with a link to the transcript.

```terminal
$ cast trigger complete tr-47 --needs-attention --summary \
    "New TypeError in checkout since last night's migration. Fix drafted, needs your call on the rollback."
ok Trigger completed: tr-47
```

![The triggers page section 'Every run says who acts next': a toggle between 'a clean run' and '--needs-attention', a cast trigger complete tr-47 --needs-attention command, and a diagram where the run of tr-47 goes either to 'trigger history, read when you look' or, dashed in red, to 'your inbox, stays until you act'](/blog/field-manual/triggers-report.webp "Two destinations for a finished run: the trigger's history (read when you look) or your inbox (stays until you act).")

## Built to be left alone

- **`--safe`**: a spawned run gets its write tools removed and state-changing commands blocked. Right for watchers that should look and report, never touch: `cast trigger add "Watch the signup funnel and report anything off" --every 4h --spawn --safe`. It is a guard on what the agent may do, not an isolated machine, and a run that injects into an existing session follows that session's rules instead.
- **Usage limits park, they do not fail.** A run that hits a limit parks and resumes its own session when the window resets, keeping its context and spending none of its retries; with account switching on it can move to a saved account with room.
- **Failures are visible.** A failed run retries after a short backoff, three attempts in all, then the trigger is marked failed, one click from the transcript.
- **Each firing runs once.** The daemon claims a due firing with a lease, so a second machine or daemon never runs the same firing twice. Every run has a kill cap (`--max-runtime`, 10 minutes by default).
- **Cleanup is symmetric.** Killing a session cancels the triggers bound to it; restoring it re-arms them.
- **Edits are versioned.** `cast trigger update tr-43 --every 8h` writes a new version, and `cast trigger history tr-43` shows who changed which field, from what, and from where.

Runs execute through the codecast daemon on the machine where the trigger was armed, in that checkout. A laptop that is asleep when a trigger comes due runs it on wake; to keep things running around the clock, arm triggers from a session on a cloud host.

![The product film's Automate chapter: a workflow graph Implement, Verify (with a failure loop back to Implement), success, Review; trigger rows 'Check CI every 4h' (ok 2s ago, 12 runs, ct-4182 passed verify) and 'Answer PR review comments' (on PR comment, event, 7 runs); a pinned NEEDS INPUT state 'Waiting on review of ct-4182'; and a run panel 'ship paused at Review' with Implement and Verify checked and the Review gate pending](/blog/field-manual/triggers-gate.webp "From the film: the &quot;Check CI every 4h&quot; trigger fires a workflow (implement, verify, review) that pauses at a human gate. A trigger decides when something runs; a workflow decides what runs in what order.")

> **Why it matters.** Scheduled agents are easy to build and expensive to leave running: every firing is a full session, and every result is something to read. Codecast's design attacks both costs. `--precheck` means a firing whose answer is "nothing changed" costs a shell command, not a session. `--spawn` keeps repeating work out of the long thread it would otherwise reload. And `--needs-attention` means the default outcome of a run is silence, so the one run that needs you is not buried under eleven that did not.
