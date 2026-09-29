# My project

User prose that lives ABOVE every codecast block. An install must leave this
byte-identical.

## Messaging

STALE MESSAGING BODY — a short stand-in for whatever an older CLI wrote here.
Installing the `messaging` snippet must replace this block rather than stack a
second copy under it.
<!-- /codecast-messaging -->

## House rules

A user's own section sitting BETWEEN two codecast blocks. Nothing may move it.

## Referencing objects

STALE REFERENCES BODY — the shared section that ten of the eleven snippets
refresh as a side effect of installing. The one that does not (`visual`) leaves
this text exactly as it stands.
<!-- /codecast-references -->

## Deploy notes

The last user section. It follows the codecast blocks, so anything that cuts a
block by "everything to end of file" destroys this paragraph.

## Typechecking

Typecheck TypeScript with `cast check`, never `tsc --noEmit`. One `tsc --watch` per tree and project keeps the program in memory and rechecks only changed files, so answers take seconds and ten sessions asking cost the same as one. A fresh `tsc` rebuilds everything, and many at once push the machine into swap.

```bash
cast check                 # every project the tree lists, or else the tsconfig nearest this directory
cast check web             # one project, by its name in .codecast/check.toml
cast check packages/api    # any directory or tsconfig path in the tree
cast check --fresh         # restart a watcher that lost track, then ask
cast check --json          # { project, errors, diagnostics } for each project
cast check-status          # the watchers on this machine (--stop stops them all)
```

A tree lists its programs in `.codecast/check.toml` as a `[projects]` table of `name = "path/to/tsconfig.json"`. Commit it so every worktree inherits it (if the repo ignores `.codecast/`, add `!.codecast/check.toml`). A repo with more than one program needs it; without it only the tsconfig nearest your directory is checked, which may not be the program your change reaches.

Point each entry at the tsconfig the package's own `typecheck` script runs, not necessarily the plain `tsconfig.json`: a build that narrows `rootDir` often keeps a widened `tsconfig.typecheck.json`, and checking the build config reports hundreds of files-outside-root errors. When a check is red with errors nobody wrote, suspect the entry before the code.

The first ask builds the program (as slow as `tsc`); later asks take seconds. If a pass is still running, ask again rather than starting your own `tsc`. Sessions in one checkout share a watcher and each worktree gets its own. A watcher stops after 45 idle minutes, and a machine keeps at most six, stopping the longest idle.
<!-- cast @VERSION@ -->
<!-- /codecast-check -->
