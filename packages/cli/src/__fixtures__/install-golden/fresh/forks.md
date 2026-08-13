
## Forks & Sessions

You can spin work off into your human's inbox as independent sessions — not hidden subagents. The difference is ownership: a subagent (Task tool) reports back to you and you keep its result; a fork or a spawned session lands in the human's inbox for them to review, steer, and continue on their own. Reach for these when the work is theirs to own, or when several directions are worth running at once and seeing side by side. Launch them when the human asks; if spinning them up is your idea, propose it first.

```bash
cast fork "<direction>" ["<direction>" ...]   # branch THIS conversation N ways from here
cast spawn "<task>" ["<task>" ...]            # start N fresh sessions, no shared history
cast spawn - <<'EOF'                          # multi-line briefing via stdin (same as cast send)
…goal, numbered steps, constraints — exact newlines preserved…
EOF
```

For multi-line prompts, pass `-` and feed the body via heredoc — never `"$(cat file)"`, which mangles formatting. Several `-` args split one heredoc into one prompt per `-`, separated by lines containing only `---` — so a whole fan-out of multi-line briefs fits in one invocation:

```bash
cast fork - - <<'EOF'
…first branch's brief…
---
…second branch's brief…
EOF
```

`cast fork` branches the current conversation — each branch keeps the full history up to the fork point (just before the latest user message by default, so the fork request itself never enters a branch; `--at <line>` picks another spot, `-s <id>` forks a different session), then pursues its own direction. Use it when the thread splits into distinct paths worth exploring in parallel. When forking is your own idea rather than the human's request, pass `--tip` — there is no fork request to strip, and the default would drop the human's real latest message.

A fork fan-out is a handoff, not an orchestration. When the human asks to run work in N forks, issue ONE `cast fork` with all N directions, report the roster, and return to your own thread. A branch doesn't know it is a fork — its history ends before the fork request, and its seed arrives as its next instruction — so write each direction as a complete, self-contained instruction for that thread. The branches run independently and the human steers them from the inbox; do not stage launches, monitor branches, or build coordination between them.

`cast spawn` starts fresh sessions with no shared history, in the current project (`-C <dir>` for elsewhere). Use it to hand off self-contained work — a parallel audit, a port, a spike — rather than research you'd fold back into your own answer.

Both start working immediately and appear in the inbox. A branch or session only knows what you give it — for forks, plus the history up to the fork point — so seed each with a sharp, self-contained prompt. When you launch several, tell the human what you sent where.

Labels carry across a fork by default: a branch inherits whatever label you'd filed the parent session under (labels are your personal filing, so this follows your own filing even when you fork a teammate's session), keeping a fork grouped with its source without any flag. Pass `--label <name>` to file the new sessions under a label you choose instead — an override for forks, and the only way to file a `spawn` (which starts fresh, with nothing to inherit). The label is created if it doesn't exist: `cast spawn --label rollout "<task>" "<task>"`, then `cast sessions --label rollout` to see the whole fan-out as a group.
<!-- /codecast-forks -->

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
