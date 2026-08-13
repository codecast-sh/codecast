# Where these fixtures came from

They are a characterization baseline for `cast install <slug>`, recorded so the
phase-0 rewrite of the snippet writers can prove it changed nothing a user sees.
They are not a specification. Nothing here says the recorded output is right —
only that it is what the CLI produced at the commit named below.

## The commit

Recorded from `6544b1e4d` ("chore: checkpoint team chat + parallel session work
for deploy"), the tip of `main` at the time, extracted with `git archive` so the
recording could not pick up the working tree's in-flight edits:

```
git archive HEAD | tar -x -C /tmp/head-baseline
# mirror node_modules by symlink, with @codecast/shared pointed at the extraction
cd packages/cli
UPDATE_GOLDEN=1 GOLDEN_CLI_ROOT=/tmp/head-baseline/packages/cli \
GOLDEN_SLUGS=memory,messaging,forks,tasks,triggers,workflows,visual,publish,state,orchestration \
bun test src/install.golden.test.ts
```

The extraction was necessary because the rewrite landed in the shared working
tree while this test was being written. Running the recorder against the working
tree would have goldened the output the rewrite is supposed to be measured
against, which proves nothing.

## `browser` has no baseline, on purpose

`browser` entered `SNIPPET_CATALOG` after the baseline commit. At `6544b1e4d`
the CLI's `SNIPPET_BEHAVIOR` table has no `browser` entry, so `cast install
browser` cannot run there and there is no pre-rewrite output to record.

It is deliberately NOT recorded from the working tree. A fixture taken from the
code under test would pass and imply the rewrite left `browser` alone, which
nobody has checked. The test therefore reports `no baseline for
fresh/browser.md` — an honest absence rather than a false green. Record it with
the rest of the set once the writers have settled.

## What is normalised, and nothing else

- `config.json` `created_at` / `updated_at` — wall clock.
- The scratch `HOME` path inside the side files, replaced with `@HOME@` before
  hashing. `mkdtemp` gives a fresh path on every run.
- A slug that writes no `CLAUDE.md` (`orchestration` writes skills, agents and
  hooks instead) records the sentinel `@ABSENT@` rather than a missing file.

The snippet bodies embed no version and no timestamp. The version lives only in
`config.json`, and `manifest.json` records its exact value — so a body edit that
forgets to bump its version shows up as a one-sided diff rather than passing
unnoticed.

## Reading a failure

Compare the fixture to what the CLI writes now and decide whether the change was
intended. A pure move — the same lines in a different order — means a block
changed position in the file, not content; `diff <(sort a) <(sort b)` tells the
two apart in one command. Re-record only once you have decided, and say in the
commit message which slugs moved and why.
