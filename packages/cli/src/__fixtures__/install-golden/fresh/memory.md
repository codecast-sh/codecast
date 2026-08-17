
## Memory

You are one session among many. Past conversations contain valuable context about decisions, patterns, and prior work. Search proactively and liberally - when starting tasks, debugging issues, or when the user references previous work. Parallelize searches when exploring multiple topics.

```bash
# Search & Browse (default: team scope from current directory)
cast search "auth"                # team-wide search
cast search "auth" --mine         # only my sessions
cast search "auth" -m samvit      # specific member
cast search "auth" -g -s 7d       # all teams, last 7 days
cast feed                         # team feed
cast feed --mine                  # only my sessions
cast feed -m samvit               # specific member
cast feed --state needs-input     # filter feed by work state
cast feed --label api             # sessions I filed under a label (search/sessions take --label too)
cast read <id> 15:25              # read messages 15-25
cast read '<share-url>#msg-<id>'  # read a window around a linked message (-c N for context size)
cast link [id] [line]             # mint a deep link to any object (session+line→message, ct-/pl- task/plan, --type doc)
cast link                         # …the link to THIS session, to hand a human something clickable

# Explore sessions — 3 axes: QUERY (which) × CONTENT (state | --messages) × LIVENESS (snapshot | -w)
cast sessions                     # state snapshot, grouped most-actionable-first
cast sessions -w                  # live change stream: one line per work-state change, silent otherwise
cast sessions -w --json           # …as NDJSON: {"event":"new"|"transition"|"gone","id","from","to",…}
cast sessions <id> [<id>…] -w     # watch an explicit set of sessions (ids also narrow the snapshot)
cast sessions --label fleet -w    # watch every session filed under a label
cast sessions --state needs-input # narrow to one state (also --team, -m <name>; with -w, new/gone events fire on enter/leave)
cast sessions --labels            # my labels + counts, current project (--by-label groups, --label <name> filters, -g all projects)
cast sessions --messages -w       # follow MESSAGES across my live sessions (multi-session)
cast sessions <id> --messages -w  # …focused on one session
# ORCHESTRATE a fleet: spawn workers under a label, run the watch in the background, act on events.
#   cast spawn --label fleet "task A" "task B"
#   cast sessions --label fleet -w --json     ← emits {"event":"transition","to":"done",…}
#   worker flips to done = finished, needs_input = blocked → cast read <id>, then cast send <id> "next step"
# The -w stream prints nothing until something changes, so wake-on-output is a reliable signal.
# Event states use underscores ("needs_input"); the --state flag accepts either form.
# --state: needs-input | done | working | dormant | idle | pinned | live (also works on cast feed)
# States answer WHO ACTS NEXT, same as the web inbox: needs-input = a human must unblock it (open
# question, permission prompt, dead with output, or a finished turn nobody classified); done = the
# agent declared it delivered; working = producing now; dormant = a machine wakes it (a declared
# `cast state --status dormant`, an open background task/Monitor, an armed trigger into it) — parked,
# not blocked, so don't wait on needs-input for it; idle = blank sessions with nothing to act on.

# Labels — personal filing. File a session under a name, then filter by it
# (cast sessions/feed/search --label <name>). A session carries at most one label.
cast label set api <id>           # file a session under "api" (creates the label if new)
cast label set api                # …file the CURRENT session
cast label ls                     # my labels with session counts
cast label clear <id>             # unfile a session (drop its label)
cast label rename api backend     # rename a label (its sessions follow)
cast label rm api                 # remove a label (its sessions become unlabeled)

# Analysis
cast diff <id>                    # files changed, commits, tools used
cast diff --today                 # aggregate today's work
cast summary <id>                 # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions
cast ask "how does X work"        # query across sessions

# Handoff & Tracking
cast handoff                      # generate context transfer doc
cast bookmark <id> <msg> --name x # save shareable link
cast decisions list               # view architectural decisions
cast decisions add "title" --reason "why"
```

Common options: --mine (just me), -m <name> (member), --label <name> (my label), -g (all teams), -s/-e (time range), -p (page), -n (limit)
<!-- /codecast-memory -->

## Referencing objects

Every codecast object has a short ID. Write one into your prose and it renders as a live reference: the object's title, its current state, and a link that opens it. This works anywhere you write — messages, summaries, task comments, doc bodies, trigger prompts.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |

There are two forms. Write the bare ID by default — `Filed under ct-4102.` — it reads as a normal sentence and still renders the full reference. Write `@[Title id]` — `@[Fix the auth race ct-4102]` — when the reader needs the name in the sentence itself.

Never paste an object's 32-character internal ID into prose. It renders as an unreadable blob, and every command that accepts an ID accepts the short one.
<!-- /codecast-references -->
