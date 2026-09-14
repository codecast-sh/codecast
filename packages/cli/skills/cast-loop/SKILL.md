---
name: cast-loop
description: Run an autonomous loop that works through a queue of tasks one fresh session at a time, with verification as the gate and a human decision at merge. Sets up a recurring trigger that spawns a session per ready task, a precheck that spends nothing when the queue is empty, and the rules each run follows. Use for a backlog of small independent tasks, an overnight sweep, or when asked to loop, keep going until done, or run unattended.
argument-hint: "<plan id | project | query> [--every 30m] [--for 8h]"
---

A loop is only as good as its dispatcher and its gate. The task board is the
dispatcher: ranked, deduplicated, visible to the human. Verification is the
gate. Merge stays a human decision unless the human said otherwise.

## Queue

Confirm there is a queue worth looping over: `cast task ready --plan <id>`
or `--project <ref>` or `-q "<query>"`. Each task must be finishable by one
session alone with acceptance criteria in its description; fix the ones
that are not before starting, or the loop produces eight half answers.

## Arm

```bash
cast trigger add - --every <interval> --spawn --title "Loop: <name>" \
  --precheck 'test -n "$(cast task ready --plan <id> --json | jq -r ".[0].short_id")"' <<'BRIEF'
Take the highest priority ready task from `cast task ready --plan <id>`, claim it with
`cast task start`, work in a worktree (`cast ws acquire <task id>`), and run
/cast-verify before closing it. Commit on the task's branch and open a pull
request with /cast-ship; do not merge. Queue anything that needs a person with
`cast decide`. Finish with `cast trigger complete <trigger id> --summary "<what landed>"`.
BRIEF
```

The precheck runs before every firing and skips the run when nothing is
ready, so an idle loop costs no session. The brief is the run's entire
context; a spawned session has none of this thread.

## Watch and stop

`cast trigger ls` shows the loop; `cast trigger log <id>` the last run.
Pin this session dormant naming the trigger. Stop it with `cast trigger
cancel <id>` when the queue drains, when two runs in a row fail the same
way, or at the `--for` limit; a loop that keeps retrying a broken task is
spending the human's quota on nothing.
