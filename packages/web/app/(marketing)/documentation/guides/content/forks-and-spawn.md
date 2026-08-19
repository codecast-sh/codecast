`cast fork` and `cast spawn` let a session spin work off into new sessions that land in the human's inbox. The distinction from subagents is ownership. A subagent reports back to the agent that launched it, and its result stays inside that agent's context. A fork or a spawned session is independent: it appears in the inbox for the human to review, steer, and continue. Reach for these when the work is the human's to own, or when several directions are worth running side by side.

The forks snippet is installed via [the snippet system](/documentation/agent-snippets).

## Fork: branch the conversation

```bash
cast fork "try the optimistic locking approach" "try the queue-based approach"
```

Each branch keeps the full conversation history up to the fork point, then pursues its own direction. By default the fork point is the latest user message; `--at <line>` picks another spot, and `-s <id>` forks a different session entirely — including a teammate's. Use fork when a thread genuinely splits: two plausible designs, two hypotheses about a bug, a risky refactor worth attempting two ways.

In the dashboard, forked conversations show a branch selector and a tree panel, so the human can compare branches and continue the one that wins.

## Spawn: start fresh

```bash
cast spawn "audit the auth module for missing permission checks" \
           "port the date helpers to the shared package"
cast spawn -C ~/src/other-repo "reproduce issue #412"
```

`cast spawn` starts fresh sessions with no shared history, in the current project unless `-C` says otherwise. Use it for self-contained hand-offs — a parallel audit, a port, a spike — rather than research the launching session would fold back into its own answer.

A spawned session knows only its prompt. The snippet drills agents on this: seed each spawn with a sharp, self-contained brief, because nothing else arrives with it.

## Labels group the fan-out

Labels are the filing system that keeps a fan-out coherent. A fork inherits the label its parent was filed under, so branches stay grouped with their source automatically. Spawns start fresh with nothing to inherit, so `--label` is how you file them:

```bash
cast spawn --label rollout "task A" "task B" "task C"
cast sessions --label rollout        # the whole fan-out as a group
cast sessions --label rollout -w     # …watched live
```

That last command is the orchestration hook: watch the label, and act when a worker flips to `needs_input`. The [messaging guide](/documentation/messaging) shows the full loop — spawn, watch, read, send.

## Etiquette

Both commands start working immediately and appear in the inbox, which is the human's attention. The snippet sets two rules: launch forks and spawns when the human asks, and propose first when it is the agent's own idea. After launching several, the agent tells the human what it sent where. And when the fan-out is done, [messaging](/documentation/messaging)'s inbox commands (`cast stash`, `cast kill`) clean up the workers so the inbox stays readable.
