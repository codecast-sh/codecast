
## Typechecking

Typecheck TypeScript with `cast check`, never `tsc --noEmit`. One `tsc --watch` per tree and project rechecks only changed files, so answers take seconds and ten sessions asking cost the same as one; fresh `tsc` runs rebuild everything and push the machine into swap.

```bash
cast check            # every project in .codecast/check.toml, else the tsconfig nearest this directory
cast check web        # one project by name, or any directory or tsconfig path
cast check --fresh    # restart a watcher that lost track, then ask
```

The first ask builds the program; later ones take seconds. If a pass is running or queued, wait on it rather than starting your own `tsc`. A worktree holds a program of its own (gigabytes per project), so give worktrees only to the agents whose edits would collide. When a check is red with errors nobody wrote, suspect the `.codecast/check.toml` entry before the code. `cast guide check` covers that file.
<!-- cast @VERSION@ -->
<!-- /codecast-check -->
