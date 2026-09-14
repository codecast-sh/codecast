---
name: cast-handoff
description: Package the current work so the next session or a teammate can continue without reading this thread. Writes the decisions, the direction, what is verified, open questions and ordered next steps as a shared doc, pins the state, and optionally forks, spawns or hands the work to a session. Use before stopping, before a long pause, or when handing work over.
argument-hint: "[fork | spawn | <session-id> | <member>]"
---

Git holds what changed. Write what git does not: why it changed, where it is
going, and what to do first. The reader was not here and will not read the
transcript, so the doc must stand alone.

## Write it

Cover, in this order and only when true:

- Goal in one sentence, and the task or plan it belongs to.
- Decisions made and the reason for each; alternatives rejected and why.
- What is verified, how (the exact command or the screenshot), and what is
  not. Test commands with their results, so nothing is rerun.
- Open questions and what would resolve them.
- Next steps in order; the first one concrete enough to start cold.
- Live panes with the attach command, feature flags, credentials, flaky
  areas.

Skip history and activity. If a section would be empty, leave it out.

## File it

```bash
cast doc create "Handoff: <goal>" -t note -l handoff -c - <<'DOC'
…the doc…
DOC
cast state --status <done|blocked|dormant> - <<'STATE'
<what this session was working on, standing alone>
Next: <first step>, handoff in doc:<id>
STATE
```

Record any decision the doc names with `cast decisions add "<title>" --reason
"<why>"` so it is searchable outside the doc. If the work is bound to a task,
`cast task comment <id>` with the doc id.

## Hand it on

- `fork`: `cast fork --tip "<the first next step, naming doc:<id>>"` keeps the
  history and continues in the human's inbox.
- `spawn`: `cast spawn -` with a self contained brief that opens with the doc
  id; the new session has none of this context.
- A session id: `cast send <id>` the doc id and the first step, one message.
- A member: `cast own <session> <member>` on this session, then `cast send`
  is not needed; the state pin tells them where it stands.
- No argument: the doc and the pin are the handoff. Stop.
