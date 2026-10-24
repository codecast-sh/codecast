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
| Call    | `cl-42`   | `cast calls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a normal sentence and still renders in full. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as an unreadable blob, and every command accepts the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Workflows

Workflows are DOT execution graphs with loops, conditions and human approval gates, bound to a task or plan. Nodes are agent sessions, shell commands, approval gates or conditionals; the dashboard shows progress and gate buttons.

```bash
cast workflow run flow.cast --task ct-N     # or --plan pl-N
cast workflow list | runs | push
```

Flows are the team's library of these graphs: lines that take a change to done, and segments (check, review, eval, decide, ship) that do one part. A finished change goes through one before it ships, its run drawn live in the conversation.

Run a library flow that fits as it stands. When one fits as a backbone but a step needs this change's own work, extend it and fill its slots. Write a whole flow only when nothing in the library has the shape of the work.

```bash
cast flow ls                        # the library
cast flow run change                # this session's own edits through a library flow
cast flow run - <<'EOF' … EOF       # a flow written here (extends a backbone, or whole)
```

`cast guide workflows` shows the graph syntax, segments, slots and import.
<!-- cast @VERSION@ -->
<!-- /codecast-workflows -->
