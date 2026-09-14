---
name: cast-second-opinion
description: Get an independent review of the current change from a different model in a fresh context, then verify its findings and fold the real ones in. Use before shipping, after a long debugging session, or when asked for another model's view.
argument-hint: "[codex|grok|gemini|claude] [focus]"
---

A reviewer that read the author's reasoning is biased by it. This hands a
fresh model only the intent, the plan and the diff, then treats its findings
as claims to verify, not verdicts.

## Choose the reviewer

The argument names the agent. Otherwise prefer a different vendor from the
one running this session (`cast exec --dry-run --agent codex` shows whether
it is installed); fall back to the same vendor on a different model. Never the
same model that wrote the change.

## Build the packet

- One paragraph of intent: what the change is for and what it must not break.
- The plan or task: `cast task context --current` or `cast plan context --current`.
- The diff: `git diff-main` (or `git diff` plus staged changes when the alias
  is absent). Trim generated files and lockfiles.
- The focus, if the user gave one.

Nothing else. No transcript, no reasoning, no list of what you already checked.

## Run it

```bash
cast exec --agent <agent> --permission-mode default --timeout 10m - <<'PACKET'
You are reviewing a change you did not write. Read the intent, the plan and
the diff, then report, ranked by severity, with file and line for each:
correctness bugs, requirements in the plan the diff misses, simpler ways to
get the same result, and what you would test before merging. Be concrete.
Skip praise and restatement.

<intent, plan, diff, focus>
PACKET
```

## Verify, then fold in

Check every finding against the code before accepting it. Fix the confirmed
ones or list them with a reason for deferring. Name the ones you rejected and
why, so the reader can see the review was weighed rather than obeyed. Record
the outcome on the task with `cast task comment <id>` when one is bound.
