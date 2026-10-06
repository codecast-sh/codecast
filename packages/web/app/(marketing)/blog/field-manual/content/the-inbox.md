Run five agents and a new job appears in your day: cycling through terminals asking each one whether it needs you. Agents do not page you. They finish, or stall on a permission prompt, and wait. The inbox replaces that loop with a single computed answer for every session on every machine: *whose move is it?*

Every session, whether it runs Claude Code, Codex, Cursor, OpenCode or pi, on your laptop or a cloud host, lands in one list. The list is not sorted by time. It is grouped by who acts next: you, the agent, a machine, or nobody.

![The codecast web app: navigation on the left, an open Claude Code conversation in the middle, and on the right the inbox grouped into Needs Input (1), Done (3) and Working (3), each card showing its agent icon, a pinned state line, project and message count](/blog/field-manual/inbox-hero.webp "The inbox on the right reads top down as whose move it is. The yellow NEEDS INPUT and cyan COMPLETE tags on the first two cards are pinned state lines the agents wrote themselves.")

## The sections, in order

The inbox renders these sections top to bottom, and the order is the point: your moves first, then the agent's, then a machine's.

- **Questions**: a session asked you something. An open question from the agent, a tool waiting on approve or deny, a decision card, or a worker's open ask. Clicking one opens a full-width answer view anchored on the question, and answering advances to the next.
- **Pinned**: sessions you pinned to the top, whatever their state.
- **New**: sessions with no messages yet.
- **Needs Input** (yellow): the ball is in your court.
- **Done** (cyan): delivered; read it when you like.
- **Working**: the agent is producing right now. Leave it alone.
- **Dormant** (blue): parked on a wake a machine owns, such as a scheduled check or a background watcher.

Below those sit three collapsed buckets that are nobody's move: **Snoozed**, **Stashed** (with a "kill all" button) and **Killed**. On a busy day they hold hundreds of sessions, none of them in your way.

![The inbox after a lead session spawned two workers: under 'Retry failed webhooks' in Working, two indented child rows, 'Webhook API half' on a cloud host and 'Dashboard retry UI', each with its own agent icon and message count](/blog/field-manual/inbox-workers.webp "Workers a session spawns nest under it in the same section (here a Codex worker on a cloud host and a Cursor worker), so a fan-out reads as one line of work instead of three cards.")

A session's section is decided first by anything you did to it (stashed, snoozed, killed), then by whether it is asking you something, then by a pin, then by being empty, and only then by its work state. A pinned session keeps its state underneath, so the counts stay honest.

## The five work states, and what moves a session between them

Every session carries one of five work states: **Working**, **Needs Input**, **Done**, **Dormant**, **Idle**. One shared function computes it everywhere, so the web inbox, the phone, push notifications and the Lock Screen can never disagree about where a session belongs.

It reads what the agent's process is doing, what the transcript shows, what the agent said about itself, and what you did to the card. The rules, in order:

1. **Killed wins.** A killed session is idle, and nothing but a new message from you makes it look busy again.
2. **Snooze.** A snoozed session is dormant until its time comes, then needs input.
3. **Your own verdict.** If you filed the row yourself (dragged it into a section, or chose Mark done, Dormant or Mark needs input), it stays there. This outranks even hard blocks, because you already saw them. It expires on the next activity, so it can never hide a *new* ask.
4. **Hard blocks** go to Needs Input: an error banner ("Please run /login", a usage limit), an open question, a permission prompt.
5. **Producing** goes to Working: the agent is thinking, compacting, starting or resuming, or there is queued work a live machine can deliver.
6. **Dead or unresponsive with output** goes to Needs Input: someone has to read it or restart it (unless it exited right after saying it was done, the ordinary end of a scheduled run).
7. **Settled** (the turn ended) picks a resting place, in trust order: the agent said it is blocked, so Needs Input; it named a wake, or a schedule or loop is armed into it, or one of its workers is still running, so Dormant; it said done, so Done; a classifier read the turn and judged it delivered, so Done. Anything else falls through to Needs Input.
8. **Not settled, no status**: you just sent a message it has not picked up, so Working. No messages at all is Idle.

> **Why it matters.** The fallthrough is deliberate: a finished turn that nobody classified lands in Needs Input, not Done. The system never guesses that work is finished. Silence costs you a glance; a wrong "done" costs you a stalled agent you never look at again.

Two trust limits keep agents honest. "I'm waiting on something" is a promise about a wake. If codecast can see the wake (an armed schedule, a running background task, a worker still producing) the session parks indefinitely. If not, the claim holds for two hours of quiet, and then the card moves back to Needs Input marked as an unverified claim. And "done" or "dormant" covers only the turn that says it: after the next wake the agent has to say it again, or the session returns to Needs Input.

## State lines: the agent's own answer to "where does this stand?"

An agent can pin one short block of text to its session, shown above the composer and on the inbox card. In the hero shot above, "the 4242 test card is rate limit…" and "tests green, PR open for review" are state lines. The card shows how many messages have passed since the line was written, so a stale line looks stale.

Each state line also carries the agent's answer to who acts next: still moving, blocked on you, done, or parked on a named wake ("waiting on CI run 8841, re-checks at 3pm"). That answer decides where the card files when the turn ends. A "blocked" outranks every machine wake: if a schedule keeps waking a session but the agent said a human must act, the card says so where you look, and it pulls a stashed session back into view.

## Answering without leaving the inbox

Most of the time you clear a card by replying to it. The composer at the bottom of a conversation types into the agent's real terminal as its next turn, so a reply flips the session from Needs Input back to Working. `Alt+Enter` sends and opens the next card, `Alt+Shift+Enter` sends and stashes, and `Ctrl+Enter` queues the message behind the current turn. On a permission prompt, `y` approves and `n` denies.

When an agent needs a choice only you can make, it posts a decision card: one question, options with their cost and risk, and its reasoning. The card drops over the conversation, the session moves to Questions, and the left nav grows a Questions count.

![A decision card over a veiled conversation: 'Exponential or fixed backoff?' with three numbered options, each with a cost and a risk, plus 'or type an answer in your own words' and 'dismiss'](/blog/field-manual/inbox-decide-asked.webp "The ask: three options with their cost and risk, a free-text answer, or dismiss. The nav shows Questions 1.")
![The same decision card collapsed to its answer, 'Exponential, 5 attempts' with a check mark, and the Questions entry gone from the nav](/blog/field-manual/inbox-decide-answered.webp "One tap later: the card records the answer, the agent receives it as its next turn, and Questions empties.")

## Every action on a session

When you are not going to reply right now, you park the card. Three surfaces share one vocabulary, with the same icons and colors:

- **The triage bar**, one quiet row under the composer, shows three words: **Defer**, **Stash** and **Kill**, the verbs that settle nearly every card. Its "more" button opens the full menu.
- **The right-click menu** on any card is that same menu, every verb with its shortcut beside it.
- **The keyboard**, for triage without the mouse: `Ctrl+J` and `Ctrl+K` move between cards, a chord files the selected one, repeat.

The parking verbs, lightest first:

- **Defer**: not now. The card drops down the stack and comes back on its next activity.
- **Dormant**: parked; a machine wakes it (a schedule, a watcher, another session).
- **Stash**: out of the inbox, and the agent keeps running. It comes back on its own when a scheduled run fires into it, when the agent says it is blocked, or when it stalls on a prompt, a question or a dead process.
- **Stash and hide**: a stash that stays out through scheduled wakes. Only a real ask brings it back. Made for a recurring loop you have reviewed and want quiet.
- **Kill**: done with it. Tears the agent down, cancels anything scheduled into it, and files it under Killed. The transcript stays readable and the session restartable.

Two filing verbs remove nothing: **Pin** (top of the list) and **Label** (one of your personal labels; a session carries at most one, and teammates never see yours). Dragging a card into Needs Input, Done or Dormant is the same verdict as the menu item. Working is not a drop target: nobody can declare that an agent is producing. Every action lands in the undo history (`Ctrl/Cmd+Z`); undoing a kill brings the card back, but the agent stays stopped until you restart it.

| Action | Where in the app | Shortcut | On the phone | What happens |
|---|---|---|---|---|
| Reply | Composer | `Enter`; `Alt+Enter` sends and advances | Open the session, type | Lands in the agent's terminal as its next turn; card goes to Working |
| Approve / deny | The permission prompt | `y` / `n` | Buttons on the prompt | Answers the waiting tool |
| Defer | Triage bar, right-click | `Shift+Backspace` | | Card sinks until its next activity |
| Dormant | Triage bar "more", right-click | `Alt+Shift+Backspace` | | Files under Dormant until the next wake |
| Mark done / needs input | Right-click, or drag the card | | | Files the card where you put it, until the next activity |
| Snooze | Right-click ("Snooze…") | `Alt+Z` | | Dormant until the time you pick; "Move to Needs Input now" wakes it early |
| Stash | Triage bar, right-click | `Ctrl+Backspace` | Swipe left, or long-press | Out of the inbox; agent keeps running |
| Stash and hide | Triage bar "more", right-click | `Ctrl+Alt+Backspace` | | Stays out until an ask |
| Kill | Triage bar, right-click | `Ctrl+Shift+Backspace` | Long-press, then confirm | Agent stopped, schedules cancelled, filed under Killed |
| Restore | Right-click on a stashed or killed card | | | Back in the inbox (a killed agent stays stopped) |
| Pin | Triage bar "more", right-click | `Ctrl+Shift+P`; jump to pinned with `Ctrl+P` (Mac) | Swipe right, or long-press | Top of the list, state kept underneath |
| Label | Triage bar "more", right-click | `Ctrl+L` | Long-press, "Label…" | Files under a personal label |
| Mark unread | Right-click | `Ctrl+Shift+U` | Long-press | Card keeps its dot until you next open it |
| Rename | Right-click | `Ctrl+Shift+E` | | New title on the card |
| Hand off | From an open conversation | `Alt+Shift+H` | | Picks a teammate; the session moves into their inbox |
| Jump to most urgent | | `Ctrl+I` | | Opens the top Needs Input card |
| Cycle the view | | `Ctrl+,` | | Grouped by state, by time, or by label |
| Everything else | Command palette | `Cmd+K` | | Search plus every verb on the selected session |

The right-click menu also carries a few session-level actions that are not triage: favorite, change the model and effort, move the session to another machine, copy its link, and delete.

> **Why it matters.** The destructive chords are all Backspace variants, and they only fire from an *empty* composer. `Ctrl+Backspace` is also the system "delete previous word" key, and an earlier version stashed the selected session mid-sentence while swallowing the keystroke. Now the chords defer to the editor whenever there is text to delete, so keyboard triage is fast and typing is safe. Plain `Alt+Backspace` is unbound for the same reason; adding Shift makes it a press no editing reflex produces.

### The command palette

`Cmd+K` opens one palette for everything: search across sessions, tasks and docs, and the session verbs in modes (snooze picks a time, label picks a label, model switches the model, delete confirms). Shortcuts like `Alt+Z` and `Ctrl+L` open the palette straight into that mode for the selected card.

![The command palette with the query 'webhook retry': three session results by Alex Rivera with match counts and dates, and a Done task ct-4182 below](/blog/field-manual/inbox-palette.webp "The palette searches the transcripts behind every session and the tasks they produced, in one list.")

## Assignment decides whose inbox a session is in

Three things about a session move independently: whose *account* runs it, which *machine* it runs on, and who *owns* it. Ownership is the one that decides inboxes. A session you run but do not own leaves your inbox, takes its open questions with it, and stops ringing your phone. An unowned session (most of them) stays with whoever started it.

- An owned session stays in the owner's inbox with no age limit and no status gate. A handoff nobody has opened in six weeks is exactly the one that must not age out.
- A handoff clears the previous holder's stash and snooze, so the session lands where the new owner can see it. A kill is left alone; that session is retired.
- A bot account on a shared machine can park a session on a human reviewer: it shows in the reviewer's Needs Input marked with who runs it.

A good handoff is more than a reassignment: the agent pins a "blocked" state line written for someone who has not read the thread, adds the teammate as owner, and leaves them one note.

### Team feed vs. your inbox

Your inbox holds sessions you own or started and still hold. The team feed is wider: the team's recent sessions, filterable by person, state and label. A teammate's session appears there because the team can see it, which says nothing about whose move it is. It enters your inbox only when you own it.

Agents read the same states. One that orchestrates workers watches for a worker moving to Needs Input or Done, reads it, and sends the next step, the way you would.

## The inbox on the phone

The iOS app runs the same placement over the same data, so its sections and counts match the web exactly. Swipe a card left to stash it, right to pin it, and long-press for the rest (pin, favorite, mark unread, label, stash, kill). A session handed to you arrives with a "Got it" row to acknowledge it. Replying from the phone is the same as typing at the terminal: the agent gets your message as its next turn and carries on.

![A Codex session on the desktop asks 'Should a 410 Gone count as failed?' while the same session is open on an iPhone with a reply being typed: 'Agreed. Log 410s, never retry.'](/blog/field-manual/inbox-phone-ask.webp "A Codex worker asks a question; the same session is open on the phone and the answer is half typed.")
![The reply 'Agreed. Log 410s, never retry.' has landed in both the desktop transcript and the phone, and Codex answers 'Got it: 410s logged once, never retried. Running the tests.' with a Working indicator](/blog/field-manual/inbox-phone.webp "Seconds later the reply is in the transcript on both screens and the session is Working again.")

Off the app, a single Live Activity on the Lock Screen and Dynamic Island shows every live session's state, from the same verdict: Working reads as working, Needs Input as waiting, Done as done, and a dead process or error banner as failed. Status changes arrive at once. Workers and hidden sessions never reach it, the same etiquette the push notifications follow.
