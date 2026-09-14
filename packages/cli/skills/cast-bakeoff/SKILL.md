---
name: cast-bakeoff
description: Try several approaches to the same problem in parallel and compare the results side by side. Forks this conversation once per approach, waits for the branches to settle, then lays out each branch's diff, evidence and cost with a verdict. Use when two or more designs are plausible and the cheapest way to choose is to build each, or when asked to bake off, race, or compare approaches.
argument-hint: "<approach one> | <approach two> [| <approach three>]"
---

Arguing about two designs costs more than building both when each is under
an hour. The branches share everything up to now and diverge only on the
approach, so the comparison is fair.

## Fork

Write each direction as a complete instruction for a thread that does not
know it is one of several: the approach, the same acceptance criteria for
all, and the same evidence to produce at the end (tests run, a screenshot,
a short note on what was hard). Then one command:

```bash
cast fork --tip --label bakeoff-<topic> - - <<'EOF'
…approach one…
---
…approach two…
EOF
```

`--tip` keeps this whole thread in every branch. Each branch should stay in
its own worktree (`cast ws acquire <name>`) so the diffs do not collide.

## Wait

```bash
cast sessions --label bakeoff-<topic> -w --json
```

The stream is silent until a branch changes state; run it in the background
and act on `done` and `needs_input` events. A branch that asks a question
gets the same answer every other branch would get, by `cast send`.

## Compare

For each branch: `cast diff <id>` for size and files, `cast read <id>` for
the evidence and the note, and the time it took. Lay them out as a table:
approach, lines changed, files touched, tests passing, what was hard, and
the branch's short id. Then the verdict with the reason, and what the losing
branches found that the winner should adopt.

Hand the winner on: `cast send <id>` to continue it, or bring its diff into
this thread. Stash the others (`cast stash <id>`) and say which.
