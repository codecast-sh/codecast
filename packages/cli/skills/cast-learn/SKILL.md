---
name: cast-learn
description: Turn what this session learned into guidance the next session and the team will read. Extracts corrections the human made, decisions taken, and gotchas found; writes project guidance into the repository's agent instructions, records decisions where they are searchable, and files the rest as a doc. Use at the end of a piece of work, after a correction, or when asked to remember something.
argument-hint: "[scan | write]"
---

A correction that lives only in this transcript is made again by the next
session. This moves it to where the next session looks first.

## Harvest

Read back through this session for three kinds of learning:

- Corrections: moments the human said no, stop, not like that, or redirected
  the approach. Each is a rule the next session should already know.
- Decisions: a choice between approaches with a reason, whether the human
  made it or you did and they accepted it.
- Gotchas: a fact about this codebase or environment that cost time to find
  and is not written anywhere: a flag that must be set, a test that needs a
  service, a file that two systems own.

Skip anything derivable from the code or the git history, and anything that
was true only for this task.

## Route each one

- A rule that applies to every session in this repository goes into the
  project's agent instructions (CLAUDE.md or AGENTS.md) under the section
  that fits, in one or two sentences. Read the file first; edit an existing
  rule when one is close, never add a duplicate.
- A decision: `cast decisions add "<title>" --reason "<why>" --tags <area>`.
- A gotcha that needs more than two sentences: `cast doc create "<title>"
  -t insight -c -` with the body on stdin, and one line in the instructions
  pointing at it.
- A rule about how the human wants to be worked with, not about the code,
  goes into memory rather than the shared instructions.

With `scan`, list the candidates and the route for each without writing.
With `write` or no argument, write them and report what went where.

## Keep the file short

Instruction files lose adherence as they grow. When an addition would push
the file past a couple of hundred lines, tighten what is there before adding
to it, and prefer a pointer to a doc over a paragraph.
