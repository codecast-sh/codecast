---
name: codecast-second-opinion
description: Get an independent review of the current change from a different model in a fresh context, verify its findings against the code, and fold the confirmed ones into a ranked list. Use before shipping, after a long debugging session, or when asked for another model's view.
argument-hint: "[codex|grok|gemini|claude] [focus]"
---

A reviewer that saw the author's reasoning inherits the author's blind spots.
This review starts from the diff and the intent only, on a model that is not
the one writing.

## Pack the review

Three parts, nothing else: the intent in one paragraph (what the change is for
and what would count as done), the plan or task context if bound
(`cast task context --current`), and the diff (`git diff-main`, or
`git diff origin/main...HEAD` plus the working tree). Do not include this
conversation; that is the point.

## Run it

Choose the agent from the argument, else the first installed of codex, grok,
gemini; if only claude is available, use a different model than this session.
`cast exec --dry-run --agent <agent>` shows what would run.

```bash
cast exec --agent <agent> --permission-mode default --timeout 10m - <<'EOF'
You are reviewing a change you did not write. Report, ranked by severity:
correctness bugs with file and line, requirements in the plan the diff misses,
a simpler way to reach the same result, and what you would test first.
Be concrete. No praise, no summary of the diff.

<intent>
<plan or task context>
<diff>
EOF
```

A focus argument (security, performance, migration safety) narrows the brief.

## Verify, then keep what survives

Check every finding against the code before accepting it. Drop the wrong ones
and say which were wrong and why; fix the confirmed ones or list them with a
file and line. Record the outcome on the task
(`cast task comment <id> "second opinion from <agent>: …"`) so the next reader
knows a fresh pair of eyes looked and what they found.
