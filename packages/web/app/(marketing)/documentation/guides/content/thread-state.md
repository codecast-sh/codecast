A long session is expensive to re-enter. The transcript holds everything the agent did, in order, which is exactly the wrong shape for the question you actually have when you open it: where does this stand right now? Threads that several sessions have been talking in are worse — half the messages are addressed to somebody else.

The pinned thread state answers that question in one place. The agent writes a short standing line about the situation, revises it as the work moves, and clears it when it stops being true. You see it above the composer the moment you open the session, and truncated on the inbox card before you open anything.

```bash
cast state "Waiting on CI for the auth fix — nothing to decide yet"
cast state - <<'EOF'                 # multi-line, exact newlines preserved
Status: sync layer rewritten, tests green
Blocked: needs a prod key before the last check
Next: deploy once the key lands
EOF
cast state                           # print the current state
cast state clear                     # remove it
cast state show <session_id>         # read another session's state
```

## What the agent is told to write

The snippet ([how snippets work](/documentation/agent-snippets)) tells the agent to write for someone who has been away: what is happening now, what it is waiting on, what happens next, and whether anything is the human's to decide. It leads with the situation rather than the history, because the transcript is already the history.

`Goal:`, `Status:`, `Next:` and `Blocked:` render as bold labels, the same convention session summaries use, so a state written with them reads as a structured card rather than a paragraph.

The instruction the agent gets is not "write a state" but "keep one true". It rewrites the line whenever the answer changes — a new phase, a new blocker, a decision it needs from you — and clears it when the work is done. A state that says the agent is waiting on something that already arrived is worse than no state at all.

## Staleness is visible, not assumed

Nothing forces an agent to keep the line current, so the interface never claims it is. Every write stamps the message count of the thread at that moment, and every surface shows the gap since: "4m ago · 12 messages since".

As that gap grows the panel walks through three treatments — a cyan accent while the state is fresh, yellow once the thread has run well past it, orange when it has run far past. The card in the inbox dims its line the same way. A neglected state therefore reads as neglected instead of reading as current, which is the only thing that makes a pinned line trustworthy at all.

Time is the weaker signal and treated as such: a session parked overnight on a CI run has not changed, so the clock only takes over after the thread has been quiet for a long stretch.

## Where it shows

| Surface | What you see |
|---------|--------------|
| Conversation, above the composer | The full state, its age, and the message gap. Collapse it to the headline; clear it with the × |
| Inbox card | The first line, marked with a pin, in place of the generated session summary |
| `cast sessions` | The same first line, marked, above the generated summary it replaces |

Clearing from the panel is a local-first write: the panel disappears immediately and a toast offers Undo. The agent can pin a new state at any time — the human clearing it is a statement about this line, not a lock.

## Access

`cast state` writes to the session it is run from — the CLI resolves the current session the same way `cast dismiss` and `cast label` do. Pass `--for <session>` to write to another session, and `cast state show <session>` to read one. Both are restricted to sessions you run or own, the same rule that governs renaming and dismissing.
