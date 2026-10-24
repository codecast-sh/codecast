---
name: cast-plan
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

Read the sessions that matter with `cast read`. Name, in one paragraph, what
the earlier attempts learned and what constraint each recorded decision
imposes. A plan that repeats a rejected approach without saying why is the
failure this step exists to prevent.

For how the code works today, run `/cast-research` on the request when the
change reaches into code you have not read: it returns a research doc
written by a session that never saw the goal. Plan from that doc and the
code it points to, not from its questions. For a change small enough to
read in full, read the code yourself.

## Interview

Ask only the questions the code and the history could not answer: the goal
behind the request, what must not break, where the user wants to trade speed
for completeness, and what done looks like. Ask them together, not one at a
time. A question with an obvious answer wastes the human's attention; a guess
on a question with a real fork wastes the whole plan.

When the human corrects the plan, read the code the correction rests on and
confirm it before applying it; if the code disagrees, say what it shows.

A real design fork, one where the options lead to different code and the
choice is the human's (a data model, a protocol, a tradeoff of taste), does
not get settled in the interview or in the plan body. Each becomes its own
`cast decide` card with the options and what each costs, posted with
`--advisory --default <n>` naming the option you would pick, so the plan can
be written around it while the human weighs in. After the steps exist, block
every step the answer shapes on the card (`cast task dep <step> --blocked-by
sd-N`): orchestration does not start them until it is answered, and steps
the fork does not touch run meanwhile. If the answer differs from the
default, rewrite those steps before unblocking them.

## Write the plan

```bash
cast plan create "<title>" -g "<goal in one sentence>" -a "<criterion>" -a "<criterion>" --body-file - <<'PLAN'
Context: what exists, what earlier attempts learned, which decisions bind.
Approach: the design, and the alternatives rejected with reasons.
Risks: what could go wrong and how each is checked.
PLAN
cast plan bind <plan_id>
```

Decompose into tasks that one session can finish alone. Each task is a
vertical slice: a thin piece of behavior carried through every layer it
needs, working end to end when the task is done, so the first wave already
proves the pieces fit. A task that builds one layer for a later task to
connect is a layer, not a slice; cut the work the other way.

Write their order as waves: one step per line, a blank line between waves.
Steps in a wave run in parallel; each wave needs every step of the one
before. After ` :: `, a line carries the step's description: its acceptance
criteria, the files it owns, and how it is verified (the test or check that
proves it, and what to look at in the running app when a person would see
the change). A step that cannot name its verification is not understood
yet.

```bash
cast plan steps <plan_id> - <<'STEPS'
Filter the board by status, end to end :: <criteria; owned files; verify: command, what the browser shows>

Bulk-change status from the board :: <...>
Show status history on the task page :: <...>
STEPS
```

Order by what a step needs, never by what comes first. A wave needs every
step of the one before, so a step that needs only part of a wave goes in
that same wave and gets its edge with `cast task dep <step> --blocked-by
<what it needs>`. A step that waits on something outside the
plan records it the same way, so it stays off the ready list until it
clears: a PR to merge (`--blocked-by "#42"`, or `"#42:checks"` for green
CI; quoted, since `#` starts a shell comment), a decision
(`sd-4`) or a time (`2h`, `2026-10-14T09:00`).

Two tasks that write the same file are one task or a dependency, never
siblings. Record design decisions on the plan as you make them: `cast plan
comment <plan_id> "<decision>" -d -r "<reason>"`. A plan worth repeating is
kept with `cast plan template save <plan_id>` and written again with `cast
plan create "<title>" --template "<name>"`.

## Stop

Reply with the plan id, the task list and the open decision cards, then
stop. The plan is the review
surface: the human approves it in the dashboard, and `/codecast-orchestrate`
executes it. Do not start implementing.
