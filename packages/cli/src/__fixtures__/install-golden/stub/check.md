
## Typechecking

Typecheck through one shared tsc watcher per project (cast check). Adds `cast check` so agents typecheck through one shared `tsc --watch` per tree and project instead of each running its own `tsc --noEmit`. The watcher keeps the program in memory and re-checks only what changed, so a check answers in seconds however many sessions ask, and a machine full of agents stops building the same program dozens of times over. A repo names its programs in a tracked .codecast/check.toml; without one, the tsconfig nearest the agent's directory is checked.

Run `cast guide check` for the commands and flags. The guide ships inside the binary you run, so it always matches the `cast` that will execute them.
<!-- cast @VERSION@ -->
<!-- /codecast-check -->
