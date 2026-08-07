Every coding agent session starts from scratch unless something carries context forward. The memory snippet gives agents that something: commands to search all past sessions, read any conversation, watch live ones, and pull relevant prior work into the current task. Memory works across tools — a Claude Code session can recall what was built in Cursor — and across the team, so an agent can learn from a colleague's session as easily as its own.

Memory is the foundation snippet: installing it via [the snippet system](/documentation/agent-snippets) also enables [messaging](/documentation/messaging) by default, and the [tasks and plans](/documentation/tasks-and-plans) snippet rides along with it.

```bash
cast memory        # install
cast install memory --disable
```

## Search and browse

The snippet teaches agents to search proactively — when starting a task, when debugging, when the user references previous work — and to parallelize searches across topics. Default scope is the team, from the current directory's project:

```bash
cast search "auth"                # team-wide search
cast search "auth" --mine         # only my sessions
cast search "auth" -m samvit      # a specific member
cast search "auth" -g -s 7d       # all teams, last 7 days
cast feed                         # recent team sessions
cast feed --state needs-input     # filter by work state
cast read jx7c6zk 15:25           # read messages 15–25 of a session
cast read '<share-url>#msg-<id>'  # read a window around a linked message
cast link jx7c6zk 42              # mint a deep link to any object
```

Search is hybrid: keyword matching combined with semantic similarity, with a fallback to title search under load. Results return original conversation fragments, not summaries, so the agent gets precise, quotable context.

## Watching sessions live

`cast sessions` is the state axis of memory — not what was said, but where every session stands right now:

```bash
cast sessions                     # snapshot, grouped most actionable first
cast sessions -w                  # live stream: one line per work state change
cast sessions -w --json           # …as NDJSON events for scripting
cast sessions --label fleet -w    # watch every session filed under a label
cast sessions --messages -w       # follow messages across live sessions
```

The `-w` stream is silent until something changes, which makes it a reliable wake signal for orchestration loops (see [messaging](/documentation/messaging) for the spawn → watch → send pattern). `needs_input` means the ball is in your court — the session finished its turn, asked a question, or hit a permission prompt.

Labels are personal filing: `cast label set api jx7c6zk` files a session under a name, and every browse command takes `--label` to filter by it.

## Analysis and continuity

```bash
cast diff jx7c6zk                 # files changed, commits, tools used
cast diff --today                 # aggregate today's work
cast summary jx7c6zk              # goal, approach, outcome, files
cast context "implement auth"     # find relevant prior sessions before starting
cast ask "how does session sync work"   # natural language answer across sessions
cast handoff                      # generate a context transfer document
cast decisions add "Use Stripe Checkout" --reason "handles SCA"
cast decisions list
```

`cast context` is the habit that pays off most: run it before starting anything and the agent begins with the three most relevant prior sessions instead of rediscovering them. `cast handoff` closes the other end — it distills the current session's goal, approach, and open items into a document the next session can start from.

## Ambient recall

Search is recall on demand. [Ambient awareness](/documentation/ambient-awareness) is recall pushed: with stable mode on, every new session starts with a feed of recent sessions already in context, no search required. The two compose — the feed tells the agent which sessions exist and their state; `cast read` and `cast search` go deep on the ones that matter.
