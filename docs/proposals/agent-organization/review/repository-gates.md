# Broader repository gates

The proposal changes only files in `docs/proposals/agent-organization`. No application source was changed.

A full root gate was attempted with `bun run lint`, `bun run typecheck`, and `bun run test`. Lint and typecheck did not produce results after roughly ten minutes each in a heavily concurrent checkout; only this run's processes were stopped. Both reported exit 137. The test gate exited 1 after 2m42s.

Failures included shared inbox projection determinism/fold tests, Convex conversation lifecycle expectations and assignee sweep, and a CLI tmux decision-input test. Several tests exceeded their time limits. These checkout failures were not diagnosed or claimed fixed by this document-only task. No green repository gate is claimed.

The proposal's own build, strict HTML checks, diagram/contents interactions, responsive layouts, and accessibility checks are recorded separately. Planned feature tests in chapter 8 are acceptance requirements, not tests executed against an implementation.
