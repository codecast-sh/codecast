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

Flows are the team's library of these graphs: lines that take a change to done, and segments (check, review, eval, decide, ship) that do one part of the path. A finished change goes through a flow before it ships; the run draws live in the conversation, and a flow written there can be saved to the library from it.

Choose by how well the library fits the work. A library flow that fits is run as it stands, since it carries what the team has learned. When one fits as a backbone but a step needs work particular to this change, extend it and fill its slots with steps you write, leaving the rest of it the team's. Write a whole flow only when nothing in the library has the shape of the work.

```bash
cast flow ls                        # the library, each flow with its steps
cast flow run change                # this session's own edits through a library flow (or --task, --branch, --pr)
cast flow run - <<'EOF'             # a flow written here, checked before it starts
digraph <name> {
  graph [extends="<flow>"]          # a library flow as the backbone
  subgraph <slot> { a -> b -> c }   # the steps that fill one of its slots
}
EOF
cast flow import <wf_id>            # a Workflow-tool run becomes a flow: your draft until you make it general, then cast flow publish
```

`cast guide workflows` shows the graph syntax, segments, slots and the line commands.
<!-- cast @VERSION@ -->
<!-- /codecast-workflows -->
