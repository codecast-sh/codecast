---
name: cast-lessons
description: Harvest the corrections humans made across the team's sessions in a window, cluster them, and propose the guidance that would have prevented each. Reads every session where someone said stop, no, not like that, or redirected an agent, and turns the pattern into instruction lines, decisions, or a doc. Use for a weekly retro, when the same mistake keeps recurring, or when asked what the team keeps correcting.
argument-hint: "[window, e.g. 7d] [write]"
---

Every session captures its own corrections at best. Nobody reads the
corrections across the team, so the same one is made in ten threads.

## Find the corrections

```bash
cast search "don't|do not|never|stop|wrong|not like that|instead|revert" -s <window> -n 50
cast search "why did you|I said|again" -s <window> -n 30
```

For each hit, `cast read <id> <line>` with a few messages of context to see
what the agent did and what the human wanted instead. Keep the ones where a
human corrected an agent; drop agent to agent messages and corrections that
were about a one time misunderstanding.

## Cluster

Group by the rule that would have prevented them, not by the words used.
Three sessions told to stop rewriting files they did not own are one rule.
For each cluster: the rule in one sentence, how many sessions hit it, the
short ids, and whether the repository's instructions already say it (read
them; a rule that is written and still ignored is a different problem than
one that is missing).

Then match each cluster against docs/principles.md, when the repository has
one. A cluster is that principle when the principle, as written, would have
prevented every correction in it; one that only shares a topic is not. A
match is a repeat of a rule the team already holds, and its count belongs to
that principle. A cluster with no match, seen in two or more sessions, is a
candidate principle: write it as the file writes them (the principle, why it
matters, the evidence) under the next free id in its area.

## Propose

For each cluster, one of:

- A line for the project's agent instructions, written as a principle, with
  the exact place it belongs.
- A decision: `cast decisions add`, when the correction was really a choice
  the team has now made.
- Nothing, with the reason: the rule is present and the fix is elsewhere
  (a hook, a tool, a prompt), named.

## File each cluster as a signal

A cluster that needs a change goes through the signal door, so the line can
take it up as a cause, and the same rule seen next week counts toward that
cause instead of opening another:

```bash
cast signal add --source lesson --kind cohesion \
  --fingerprint lesson:<rule-slug> \
  --title "<the rule, one line>" \
  --subject <the instruction file or area it concerns> \
  --detail - <<'BODY'
<how many sessions hit it, their short ids, and the proposed line or decision>
BODY
```

The fingerprint names the rule, not this week's wording, so a rerun over a
later window lands on the same cause. A cluster that matches a principle
uses the principle's id (`lesson:PR-code-4`), so every repeat counts toward
that principle's cause, and the detail says what the principle failed to
prevent this time: missing from the instruction the agent read, or present
and ignored. A candidate principle uses its own slug and carries the
proposed text in the detail. A signal only suggests a cause, so file it in
both modes.

Report as a table ordered by frequency, with the signal and the cause each
cluster reached. With `write`, apply the instruction
lines, record the decisions, add each candidate principle to
docs/principles.md and update the evidence line of each matched one, then
say what went where. Without it, the
table is the deliverable and the human chooses.
