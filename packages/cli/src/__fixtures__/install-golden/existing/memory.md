# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

Every codecast object has a short ID. Written anywhere (messages, summaries, task comments, doc bodies, trigger prompts), it renders as a live reference: title, current state, and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Memory

You are one session among many, and past conversations hold the decisions, patterns and prior work you need. Search them liberally, in parallel for several topics: when starting a task, when debugging, and when the user refers to earlier work.

```bash
# Search & browse (default scope: the team for this directory)
cast search "auth"                # --mine | -m samvit | -g (all teams) | -s 7d
cast feed                         # team feed: --mine, -m <name>, --state needs-input, --label api
cast read <id> 15:25              # messages 15-25; --full shows tool payloads (REQUIRED to see a StructuredOutput return)
cast read '<share-url>#msg-<id>'  # a window around a linked message (-c N for its size)
cast link [id] [line]             # deep link to any object (session+line → message, ct-/pl-, --type doc); no args = this session

# Sessions: which (ids, --label, --state, --team, -m) × what (state | --messages) × live (-w)
cast sessions                     # state snapshot, most actionable first
cast sessions -w [--json]         # one line per work-state change; JSON: {"event":"new"|"transition"|"gone","id","from","to",…}
cast sessions <id> [<id>…] -w     # watch a set (ids also narrow the snapshot); --label fleet -w watches a label
cast sessions --state needs-input # one state; with -w, new/gone fire as sessions enter/leave it
cast sessions --labels            # my labels + counts in this project (--by-label groups, -g all projects)
cast sessions [<id>] --messages -w  # follow messages across my live sessions, or in one

# Labels: personal filing, at most one per session; filter with --label on sessions/feed/search
cast label set api [<id>]         # file a session (default: this one); creates the label if new
cast label ls | clear <id> | rename api backend | rm api   # rm leaves its sessions unlabeled

# Analysis
cast diff <id>                    # files changed, commits, tools used (--today aggregates today)
cast summary <id>                 # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions
cast ask "how does X work"        # query across sessions

# Handoff & tracking
cast handoff                      # context transfer doc
cast handoff --to codex           # continue in a new session on another agent (or --model opus); links both, pins this one done
cast bookmark <id> <msg> --name x # shareable link
cast decisions list | add "title" --reason "why"
```

States: `needs-input` (a human acts), `working`, `dormant` (waiting on an automatic wake), `done` (delivered), `idle` (unused); watch JSON spells it `needs_input`. Common options: --mine, -m <name>, --label <name>, -g (all teams), -s/-e (time range), -p (page), -n (limit).
<!-- cast @VERSION@ -->
<!-- /codecast-memory -->
