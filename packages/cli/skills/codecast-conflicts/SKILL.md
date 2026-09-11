---
name: codecast-conflicts
description: Before editing or spawning work, find the live sessions on this repository that are changing the same files, show what they changed, and warn them. Use before starting a task that touches shared files, before fanning work out to other sessions, or when asked who else is working on this.
argument-hint: "[files or globs; defaults to the working tree and the bound task]"
---

Merge conflicts in shared files are the failure no fleet tool catches before
the fact. Codecast can, because every live session reports what it changed.

## My footprint

The files this session is about to touch: the arguments if given, else the
working tree (`git status --porcelain`) plus the files named in
`cast task context --current`. Exclude this session from every check below;
`cast links` prints its id.

## Who else is live here

```bash
cast sessions --state working --json
cast sessions --state needs-input --json
```

Keep the sessions whose `project_path` is this repository or one of its
worktrees (the same repository name under `.codecast/worktrees` or
`.claude/worktrees`). For each, `cast state show <id>` gives its pinned intent
and `cast diff <id> --patch` gives full paths in the `diff --git` headers (the
stats view abbreviates paths, so match on the patch, not on the summary).

## Report

No overlap is a one line answer. When files overlap, one row per session:
short id, what it is doing (title or pinned state), the overlapping files with
line counts, and how recently it moved. Then read the overlapping hunks and say
whether the edits collide (same region or same symbol) or merely share a file.

## Act

- Colliding edits: tell the other session what you are about to change and
  where, with `cast send <id>`, and prefer to sequence: wait for it to land,
  or take the disjoint part first.
- Shared file, different regions: proceed, and still send the heads up; the
  cost is one message and it saves a rebase.
- Fanning out: split ownership by file in each worker's brief so no two
  workers own the same path, and name the shared files that need one owner.
