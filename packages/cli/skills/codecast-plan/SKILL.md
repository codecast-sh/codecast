---
name: codecast-plan
description: Turn a request into a plan the team can review before code exists. Explores the codebase, searches prior sessions and recorded decisions for earlier attempts, interviews the user on the open questions, then writes a codecast plan with tasks and dependencies ready for orchestrate. Use when work has several parts, when asked to plan, or before fanning work out to other sessions.
argument-hint: "<what to build>"
---

Humans review plans hard and code lightly, because one wrong line of a plan
becomes hundreds of wrong lines of code. This skill produces the artifact
they review.

## Find what already exists

Run these in parallel before asking anyone anything:

```bash
cast context "<the request>"                 # sessions that tried this or touched the area
cast search "<key terms>" -s 60d             # earlier discussion, abandoned approaches
cast decisions --search "<key terms>"        # decisions that constrain the design
cast plan ls -q "<topic>"; cast task ls -q "<topic>"   # work already filed
```

Read the sessions that matter with `cast read`. Then explore the code the
change touches. Name, in one paragraph, what the earlier attempts learned and
what constraint each recorded decision imposes. A plan that repeats a
rejected approach without saying why is the failure this step exists to
prevent.

## Interview

Ask only the questions the code and the history could not answer: the goal
behind the request, what must not break, where the user wants to trade speed
for completeness, and what done looks like. Ask them together, not one at a
time. A question with an obvious answer wastes the human's attention; a guess
on a question with a real fork wastes the whole plan.

## Write the plan

```bash
cast plan create "<title>" -g "<goal in one sentence>" -a "<criterion>" -a "<criterion>" --body-file - <<'PLAN'
Context: what exists, what earlier attempts learned, which decisions bind.
Approach: the design, and the alternatives rejected with reasons.
Risks: what could go wrong and how each is checked.
PLAN
cast plan bind <plan_id>
```

Decompose into tasks that one session can finish alone, each with acceptance
criteria in the description and the files it owns, ordered by dependency:

```bash
cast task create "<title>" --plan <plan_id> -p high -d "<criteria and owned files>"
cast task dep <later_id> --blocked-by <earlier_id>
```

Two tasks that write the same file are one task or a dependency, never
siblings. Record design decisions on the plan as you make them: `cast plan
comment <plan_id> "<decision>" -d -r "<reason>"`.

## Stop

Reply with the plan id and the task list, then stop. The plan is the review
surface: the human approves it in the dashboard, and `/codecast-orchestrate`
executes it. Do not start implementing.
