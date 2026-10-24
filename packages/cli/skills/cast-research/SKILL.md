---
name: cast-research
description: Document how the code works today before anyone decides what to change. Turns a goal into neutral questions about the existing code, then has a fresh session that never sees the goal answer them in a research doc with file and line references and no recommendations. Use before planning a change that reaches into unfamiliar code, or when asked to research how something works.
argument-hint: "<goal or task id>"
---

An agent that knows what it wants to build reads code selectively and
reports what supports its plan. This skill separates the two: one step knows
the goal and only asks questions; another answers them without knowing the
goal, so the answers describe the code as it is.

## Write the questions

From the goal (and the bound task or plan, if any), write the questions a
planner would need answered about the existing code: where a behavior lives,
how data flows through it, what calls what, which rules and guards apply,
how the area is tested today. Each question is about what exists, phrased so
it does not reveal what will be built or favor an approach. Leave out the
goal itself, the proposed design and any wording that hints at either.

```bash
cast doc create "Research questions: <area>" -c - <<'EOF'
<the questions, grouped by area>
EOF
```

## Answer them in a fresh session

Spawn a worker that receives only the questions doc id, nothing about the
goal:

```bash
cast spawn --subagent -- - <<'EOF'
Answer the questions in doc <doc_id> (cast doc show <doc_id>) by reading
the code in this repository. Write the answers as a new doc with
`cast doc create "Research: <area>" -c -`, then reply with its id.

Describe what exists and how it works. Each section heading states the
finding itself, so a reader skimming headings learns the answer. Back every
claim with file:line references. For each area, include how it is tested
today. Do not recommend changes, judge the design or speculate about what
should be built; where the code cannot answer a question, say so.
EOF
```

Watch it with `cast sessions <id> -w --json` and read its reply with `cast
read <id>`.

## Hand it on

Reply with the research doc id. Whoever plans next (`/cast-plan`) reads the
research doc and the code it points to, never the questions doc. Do not
write a plan or a design in this skill.
