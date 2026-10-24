# Learning tests

Each file here pins one behaviour of a tool codecast depends on (tmux, bun),
learned the hard way and fixed around in `src/`. When an upgrade changes the
behaviour, the test fails and names what to revisit.

They run with `bun run test:learning` from `packages/cli`. CI runs only
`src/`, so these never gate a merge, and each skips when its tool is absent.
