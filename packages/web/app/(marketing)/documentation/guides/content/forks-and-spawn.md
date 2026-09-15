Choose by who owns the result. When an agent delegates implementation, review, or an audit and will report back with the result, it uses `cast spawn --subagent`. The worker nests under its parent. Plain `cast spawn` and `cast fork` create independent inbox threads for the human to steer separately; use those when the human asks for that handoff.

The forks snippet is installed via [the snippet system](/documentation/agent-snippets).

## Spawn a worker

```bash
cast spawn --subagent -- "audit the auth module" "review the billing changes"
cast spawn --subagent --agent codex "review the diff"
cast spawn --subagent -C ~/src/other-repo "reproduce issue #412"
cast spawn --subagent --label rollout - - <<'EOF'
Implement the first task. Report the result to the parent.
---
Review the second task. Report the result to the parent.
EOF
```

`--subagent` without a value uses the current session as parent. To name one explicitly, use `--subagent <session>`. When a prompt follows the bare flag directly, put `--` between them so the prompt is not parsed as the parent ID.

Both spawn modes start fresh sessions with no shared history. Write a self-contained brief. A different backend, worktree, label, or plan binding does not decide whether the session belongs in the inbox: `--subagent` controls nesting.

The parent manages its workers with `cast read` and `cast send`, then delivers the combined result. Watch the returned IDs:

```bash
cast sessions <worker-id> <worker-id> -w --json
```

Nested workers are omitted from top-level lists, including label filters, but always answer when named. A `done` transition means delivered; `needs_input` requires reading whether the worker finished or is blocked.

## Spawn an independent inbox thread

```bash
cast spawn "the independent task the human asked to own"
```

Without `--subagent`, spawn defaults to an inbox card even when an agent calls it. Reserve this for a human-requested thread they will review and steer separately. A request to build a feature or work in parallel does not by itself ask for separate inbox threads.

## Fork: branch the conversation

```bash
cast fork "try the optimistic locking approach" "try the queue-based approach"
```

Each branch keeps the full conversation history up to the fork point, then pursues its own direction. By default the fork point is the latest user message; `--at <line>` picks another spot, and `-s <id>` forks a different session entirely — including a teammate's. Use fork when a thread genuinely splits: two plausible designs, two hypotheses about a bug, a risky refactor worth attempting two ways.

In the dashboard, forked conversations show a branch selector and a tree panel, so the human can compare branches and continue the one that wins.

## Labels group work

Forks inherit the label the caller filed their parent under. Spawns start with no label; `--label <name>` files them and creates the label if needed:

```bash
cast spawn --subagent --label rollout "task A" "task B"
```

Labels do not change inbox visibility. Watch nested workers by the returned IDs; `cast sessions --label rollout` lists independent sessions carrying that label.

## Ownership stays with the parent

Every launch starts working immediately. Delegated workers stay nested, and the parent reports their results. Independent spawns and fork branches appear in the human's inbox. Propose an independent handoff first when the human has not asked for one. Stashing a worker after it appears in the inbox is not a substitute for nesting it at creation.
