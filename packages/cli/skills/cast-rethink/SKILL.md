---
name: cast-rethink
description: Stop and re-examine a piece of work from the top: what it was meant to be, what every earlier session did, which decisions constrain it, and whether the current direction still serves the intent. Reconstructs the history from the team's sessions, decisions and tasks before touching code. Use when a feature feels off track, after several failed attempts, or when asked to step back, rethink, or start over.
argument-hint: "[feature or task id]"
---

Execution drifts from intent one reasonable step at a time. This finds the
intent again, from the record rather than from memory.

## Name the work

`git log --oneline -20`, `git diff-main --stat`, and the bound task or plan
(`cast task context --current`, `cast plan context --current`). State in
one sentence what this feature is for. If that sentence is hard to write,
that is the first finding.

## Excavate, in parallel

Fan out subagents, one per angle, each reporting a short brief:

- Origin: `cast context "<feature>"` and `cast search "<keywords>" -s 90d`
  for the session where it was first asked for. What problem was the human
  solving, in their words?
- Decisions: `cast decisions --search "<keywords>"` and `cast search
  "decided|chose|went with|instead of"` for every choice made along the
  way and its reason.
- Attempts: every session that touched the files (`cast context --file
  <path>`), what each tried, what it abandoned and why.
- Board: the tasks and plans filed for it, what closed, what stalled.
- Current state: what the code does today versus the acceptance criteria.

## Judge

Lay the origin next to the current direction. Then, in order: what the
intent is, where execution diverged from it and at which session, which
decisions still hold and which were made for reasons that no longer apply,
and what the right next step is: continue, adjust, or restart from a named
point. Record the conclusion on the plan or task (`cast plan comment -d -r`
or `cast task comment`) so the next session does not excavate again.

Do not write code in this skill. The output is the judgment.
