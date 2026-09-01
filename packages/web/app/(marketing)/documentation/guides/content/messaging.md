`cast send` lets a session message any other session by its short ID — a session you ran last week, one running right now on another machine, or a teammate's. The messaging snippet teaches your agents this command, and that single capability changes what a fleet of sessions is: not isolated terminals, but teammates that can hand each other work, trade updates, and report back.

Messaging is installed by the [snippet system](/documentation/agent-snippets). It is on by default for anyone with [memory](/documentation/memory) enabled; `cast install messaging --disable` opts out.

## What one message does

```bash
cast send jx7c6zk "tests are green — take the next item on the list"

cast send jx7c6zk - <<'EOF'
Multi-line body via heredoc.
Markdown, code blocks, and exact newlines survive intact.
EOF
```

The text lands in the target session as a new turn, attributed to the sender. A live session sees it on its next turn. A dormant session wakes up: the agent resumes with its full history and runs what you asked. That last part matters — every past session is standing capacity. Any agent (or you) can hand a finished session new work and it continues where it left off, context intact.

On the receiving side, an inbound message arrives wrapped in an envelope naming the sender:

```
<session-message from="jx7c6zk">…</session-message>
```

The receiving agent replies to that ID with its own `cast send`. That is the whole protocol — two commands and an envelope. In the dashboard, sent messages render as cards showing who sent what to whom.

## Sessions talking to each other

Because both ends are agents, patterns compose:

- **Delegate**: hand a dormant session a task, ask it to ping you when done or blocked, then act on the reply.
- **Peer**: two sessions working the same problem trade findings as they go.
- **Fleet**: spawn workers under a label, watch their state, and message each one as it finishes:

```bash
cast spawn --label fleet "task A" "task B" "task C"
cast sessions --label fleet -w --json    # emits {"event":"transition","to":"needs_input",…}
# worker flips to needs_input = finished or blocked
# → cast read <id>, then cast send <id> "next step"
```

The watch stream prints nothing until something changes, so wake-on-output is a reliable signal. This loop — spawn, watch, read, send — is how one session orchestrates many without any of them sharing a context window.

Messaging routes team-wide: a session ID from `cast feed` or `cast search` works in `cast send` whether the session is yours or a teammate's. Your name rides on the message, so the receiving session (and its human) knows who is asking.

## Ambient awareness closes the loop

Messaging gives sessions a way to talk; [ambient awareness](/documentation/ambient-awareness) gives them someone to talk to. With stable mode on, every new session starts with a feed of the team's recent sessions — IDs, titles, states, first lines — injected at boot. So a session does not need to be told who its neighbors are. It boots knowing that `jx7az96` is stuck on a Convex error and that `jx75w5y` just finished a review, and it can `cast read` either one or `cast send` them directly. Every session is aware of every other session's existence and state, and can act on it.

## Managing the human's inbox

The messaging snippet also teaches agents the inbox gestures humans have in the web UI, so fan-out work can clean up after itself:

```bash
cast stash [session_id]      # out of the inbox; the agent KEEPS RUNNING (Stashed bucket)
                             # no ID = current session — tidy yourself away when done
cast stash --hide [session]  # stash and stay hidden: trigger wakes don't bring it back
cast restore [session_id]    # bring a stashed or killed session back
cast kill <session_id>       # tear the agent down, mark completed, cancel its triggers
                             # (transcript stays; the session is restartable)
```

Stash is reversible and keeps the agent alive; kill is the deliberate "done with it". A plain stash comes back into the inbox when a trigger fires into the session. `--hide` keeps it out of sight through those wakes and brings it back only for an ask: a blocked declaration, a `--needs-attention` run, or a stall. Agents are instructed to tell the human which sessions they hid or killed and why.

## Delivery

Messages are queued durably and retried until they land: a target daemon that is briefly offline gets the message when it reconnects, and a send from the web reaches whichever machine owns the session. If a message cannot be delivered — the target's machine is gone, say — the sender sees the failure rather than silence.
