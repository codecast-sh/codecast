---
name: codecast-ship
description: Take finished work through to merge. Commits in topical pieces, opens the pull request with a description that links the session, then binds this session to the pull request so review comments, failing checks and a stale branch wake it until the merge lands. Use when asked to ship, open a PR, or handle review feedback; "feedback" works the open threads on the current PR.
argument-hint: "[feedback]"
---

Other tools poll a pull request. A shepherded pull request wakes this session
when something happens to it, and the session sleeps in between.

## Before committing

Run the checks the repository defines (typecheck, tests, lint) and fix what
they find. Read `git status` for changes that belong to other sessions and
leave those out. Group the rest into topical commits with short messages that
say what changed and why; never one commit for unrelated work.

## Open the pull request

Description, in order: the goal in one sentence, what changed and why, how it
was verified (commands and results, screenshots via `cast image`), what the
reviewer should look at first, and the session link from `cast link`. Push
and open with `gh pr create`. If the work is bound to a task, comment the PR
url on it.

## Shepherd it

```bash
cast pr shepherd on             # the branch's PR; a ref or url for another
cast state --status dormant "Shepherding PR #<n>; wakes on review, checks and merge"
```

The bound session is woken on a review, a failing check, a stale branch, a
conflict and the merge. On each wake:

- Review threads: `cast pr threads`, fix or answer each, push, then `cast pr
  resolve <thread>` for the ones you settled. Do not resolve a thread you
  disagreed with; reply on it and leave it open.
- Failing checks: `gh run view <id> --log-failed`, fix, push.
- Behind or conflicted: `git fetch origin main && git rebase origin/main`,
  resolve, force push with lease.
- Approved and green: merge only when the human asked for it or the plan
  says the agent merges; otherwise pin `--status blocked` naming the merge as
  theirs.
- Merged: `cast pr shepherd off`, close the task with `cast task done`,
  pin `--status done`.

## `feedback`

Skip the commit and open steps: run the review threads step on the current
pull request, once, and report which threads were fixed, answered or left
open with the reason.
