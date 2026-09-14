---
name: cast-from-call
description: Turn a team call's action items into tasks people can pick up, each linked to the line in the transcript where it was agreed. Reads the call's summary and transcript, confirms each commitment against what was actually said, and files tasks marked as decided in a meeting. Use after a call, when asked what was agreed, or to file follow ups from a huddle; "chat" does the same for a chat thread.
argument-hint: "[call id | chat <thread id>]"
---

Action items written from memory drift from what was said. The transcript
is exact and speaker attributed, so the tasks can quote it.

## Read

```bash
cast calls -n 10                 # find the call; the newest is the default
cast call <id>                   # title, participants, summary, generated action items
cast call <id> --transcript      # who said what; the source of truth
```

For a chat thread: `cast chat thread <root_id>`.

Check every generated action item against the transcript: who committed,
to what, by when, and whether anyone pushed back later in the call. Drop
items that were floated and not agreed. Add ones the summary missed.

## File

```bash
cast task create "<what, in the owner's words>" --from-meeting --assignee <member> -p <priority> -d - <<'DESC'
Agreed on the call <title> (<date>).
<speaker>: "<the line, quoted>"
Due: <if said>
DESC
```

`--from-meeting` puts the task on the human's board because a person agreed
to it; never use it for work you decided on your own. When the call named a
project or plan, file under it with `--project` or `--plan`. Decisions made
on the call that are not tasks: `cast decisions add "<title>" --reason
"<the quoted line>"`.

## Report

The tasks created with their short ids and owners, the items dropped with
the reason, and anything the call left unresolved that needs a follow up.
Post the list on the team channel only when asked.
