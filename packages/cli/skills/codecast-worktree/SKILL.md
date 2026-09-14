---
name: codecast-worktree
description: Move this work into an isolated worktree with its own env files, ports and setup, so it cannot collide with other sessions in the shared checkout. Use before parallel work, before a risky change, when another session is editing the same files, or when asked to work in a worktree.
argument-hint: "<name> [destroy]"
---

Two sessions in one checkout race on the index and on every shared file.
A worktree gives each its own tree; codecast's version also copies the
gitignored env files, runs the project's setup, and allocates ports so two
dev servers do not fight.

```bash
cast ws acquire <name>              # create or attach; prints the path
cd "$(cast ws path <name>)"         # a binary cannot cd the shell, so this is explicit
cast ws status <name>               # ports, env, contract checks
```

Use a name that says what the work is (`fix-auth-race`, a task id). If the
repository has no `.codecast/workspace.toml`, run `cast ws init` once from
the root so ports and setup are detected.

Work there. Before landing: `git fetch origin main && git rebase
origin/main` in the worktree, resolve, then commit on its branch. Return
with `cd "$(git worktree list | head -1 | awk '{print $1}')"`.

With `destroy`: `cast ws destroy <name>` once the branch is merged. Never
destroy a worktree with uncommitted work in it; `git -C "$(cast ws path
<name>)" status -sb` first.
