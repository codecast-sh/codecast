---
name: codecast-lessons
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

## Propose

For each cluster, one of:

- A line for the project's agent instructions, written as a principle, with
  the exact place it belongs.
- A decision: `cast decisions add`, when the correction was really a choice
  the team has now made.
- Nothing, with the reason: the rule is present and the fix is elsewhere
  (a hook, a tool, a prompt), named.

Report as a table ordered by frequency. With `write`, apply the instruction
lines and record the decisions, then say what went where. Without it, the
table is the deliverable and the human chooses.
