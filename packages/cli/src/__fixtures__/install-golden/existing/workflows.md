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

Every codecast object has a short ID. Written anywhere (a message, comment, doc or prompt), it renders as a live reference: title, state and a link.

| Object  | Short ID  | Where to find it |
|---------|-----------|------------------|
| Session | `jx7c6zk` | `cast feed`, `cast search`, `cast context` |
| Task    | `ct-4102` | `cast task ls`, `cast task ready` |
| Plan    | `pl-88`   | `cast plan ls` |
| Trigger | `tr-42`   | `cast trigger ls` |
| Doc     | `doc:<id>` | `cast doc ls`, `cast doc search` |
| Call    | `cl-42`   | `cast calls` |
| Flow    | `flow:change` | `cast flow ls` |
| Deploy  | `dp-1972` | `cast line deploy targets` |
| Issue   | `eg-2242` | `cast events groups` |
| Metric  | `mw-12`   | `cast metrics ls` |
| Replay  | `rp-311@1:23` | `cast replay ls` |

Write the bare ID by default (`Filed under ct-4102.`); it reads as a sentence and renders in full. An ID alone on its line is a live card (a metric's chart, an issue's last 72h, a flow's steps); stack them for a dashboard. Write `@[Title id]` (`@[Fix the auth race ct-4102]`) when the sentence needs the name. Never paste a 32-character internal ID: it renders as a blob, and every command takes the short one.
<!-- cast @VERSION@ -->
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Workflows

Workflows are DOT graphs with loops, conditions and approval gates, bound to a task or plan (`cast workflow run flow.cast --task ct-N`). Flows are the team's library of them: whole flows that take a change to done, and segments (check, review, eval, decide, ship). Run a library flow that fits; extend one and fill its slots when a step needs this change's own work; write a whole flow only when nothing fits.

```bash
cast flow ls                        # the library, the workspace's default flow marked
cast flow run                       # this session's own edits through the default flow
cast flow run change                # or through a library flow by name
cast flow run - <<'EOF' … EOF       # a flow written here (extends a backbone, or whole)
```

To add a check to the project's pipeline or tweak a station's prompt (Review's, say), run `cast flow edit` (`cast flow edit change add lint --after pr --fix brief --run "bun run lint"`), never a rewrite of the flow file.

`cast guide workflows` shows the graph syntax, segments, slots, import and every `cast flow edit`.
<!-- cast @VERSION@ -->
<!-- /codecast-workflows -->
