---
name: codecast-conflicts
description: Before editing or fanning out work, find the live sessions on this repository that are changing the same files, show what they changed, and warn them. Use before starting a task that touches shared files, before spawning workers, or when asked who else is working on this.
argument-hint: "[files or globs; defaults to the working tree and the bound task]"
---

Merge conflicts in shared files are the failure no fleet tool detects before
it happens. This finds them while both sides can still adjust.

## My file set

The argument, if given. Otherwise the files in `git status --porcelain` plus
any files named in `cast task context --current`. When the question is about
work you are about to spawn, use the files each brief will touch.

## Their file sets

```bash
cast sessions --state working --json
cast sessions --state needs-input --json
cast links                      # this session's id, to exclude it
```

Keep sessions whose `project_path` is this repository or a worktree of it
(`.codecast/worktrees/<name>` and `.claude/worktrees/<name>` under the same
root count). For each:

```bash
cast diff <id>                  # "Files Changed" with +/- per file
cast state show <id>            # what it says it is doing
```

Paths in `cast diff` are abbreviated from the left, so match on the path tail.

## Report

No overlap is a one line answer. Otherwise a table: session (short id), what
it is doing, the overlapping files, its line counts, and when it last moved.
For each overlap read the relevant hunks with `cast diff <id> --patch` and say
whether the two changes can coexist, will conflict textually, or conflict in
meaning (same function, different intent).

## Act

Tell the other session what you are about to change in the shared file with
`cast send <id>`; one message, concrete, no status narration. Then choose:
sequence the work, split the file ownership, or rebase onto their change when
it lands. When spawning workers, write the file ownership into each brief so
no two briefs claim one file.
