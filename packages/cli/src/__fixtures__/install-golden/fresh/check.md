
## Typechecking

Typecheck TypeScript with `cast check`, never `tsc --noEmit`. One `tsc --watch` per tree and project holds the program in memory and re-checks only the files that changed, so an answer takes seconds, and ten sessions asking at once cost the same as one. A fresh `tsc` builds the whole program again every time; many sessions doing that at once put the machine into swap and slow everything on it.

```bash
cast check                 # every project the tree lists, or else the tsconfig nearest this directory
cast check web             # one project, by its name in .codecast/check.toml
cast check packages/api    # any directory or tsconfig path in the tree
cast check --fresh         # restart a watcher that lost track, then ask
cast check --json          # { project, errors, diagnostics } for each project
cast check-status          # the watchers on this machine (--stop stops them all)
```

A tree names its programs in `.codecast/check.toml`: a `[projects]` table of `name = "path/to/tsconfig.json"`. Keep that file in git so every worktree inherits it, and if the repo ignores `.codecast/`, add `!.codecast/check.toml` to the ignore file. A repo with more than one program needs this file; without it, `cast check` checks only the tsconfig nearest your directory, which may not be the program your change reaches.

Point each entry at the tsconfig that repo's own typecheck script runs, which is not always the plain `tsconfig.json` beside the code: a package whose build narrows `rootDir` often keeps a widened variant for checking (`tsconfig.typecheck.json`), and checking the build one instead reports hundreds of errors about files being outside the root. Read the `typecheck` script in each package before you write the entry. When a check comes back red with errors nobody wrote, suspect the entry before the code.

The first ask on a tree builds the program and takes as long as a plain `tsc`; later asks take seconds. When the answer says a pass is still running, ask again instead of starting your own `tsc`. Sessions in one checkout share a watcher, and a worktree gets its own. A watcher stops after 45 minutes with no ask, and a machine keeps at most six, stopping the one idle longest.
<!-- cast @VERSION@ -->
<!-- /codecast-check -->
