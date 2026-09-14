---
name: codecast-review
description: Review another session's work from its transcript and diff, then deliver findings to that session or its owner. Reads what the session was asked to do, what it changed, and how it verified, and reports correctness, missed requirements and risks with file and line. Use when asked to review a session, a teammate's work in progress, or a worker spawned from this session.
argument-hint: "<session id> [focus]"
---

A pull request shows the diff. A session also shows the ask, the reasoning,
the dead ends and the verification, and those are where most review findings
hide.

## Read the session

```bash
cast summary <id>              # goal, approach, outcome
cast diff <id>                 # files, commits, tools; --patch for the hunks
cast read <id> :10             # the ask and the first plan
cast read <id> --full          # the rest; --full to see tool payloads and test output
cast task context <task>       # when the session is bound: the acceptance criteria
```

Match the diff against the ask and the acceptance criteria before reading
for quality. The most expensive finding is work that is correct and not what
was asked.

## Look for

- Requirements in the ask or the task that the diff does not meet.
- Claims in the transcript that the evidence does not support: tests that
  were not run, a screenshot that shows a different state, a "works" with no
  output behind it.
- Correctness in the hunks: edge cases, error paths, concurrency, data the
  change assumes.
- Code that duplicates something the repository already has.
- Changes to files outside the task's scope, and their effect on other
  sessions (`/codecast-conflicts` when in doubt).

## Report

Findings ranked by severity, each with file and line and the reason, then
what is done well in one line, then a verdict: pass, needs changes, or
reject with the reason. Concrete, no praise padding.

Deliver it where it acts: `cast send <id>` when the session is live and
should fix it; `cast task comment <task> -t review` when it is bound to a
task; both when a human owns the session and the agent will do the fixes.
For a worker you spawned, the findings go back as its next instruction.
