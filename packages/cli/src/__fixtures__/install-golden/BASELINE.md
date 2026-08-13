# Where these fixtures came from

They characterize `cast install <slug>`: what it writes, byte for byte, for
every slug in `SNIPPET_CATALOG`. They are not a specification. Nothing here says
the recorded output is right — only that it is what the CLI produced at the
commit named below, so the next change to it has to be argued for in a diff.

Two eras are checked in.

| Directory | Recorded from | Role |
|---|---|---|
| `fresh/`, `existing/`, `manifest.json`, `help.txt` | `45e5e5806` + the phase-0 writer rewrite, i.e. the working tree of 2026-08-13 | what the tests compare against |
| `pre-rewrite/` | `6544b1e4d`, the tip of `main` before the rewrite | history, for diffing only — no test compares against it byte for byte |

## How each era was recorded

`pre-rewrite/` was taken from a `git archive` extraction rather than from the
working tree, because the rewrite had already landed in the shared tree by the
time this test was written. Recording it from the tree would have goldened the
output the rewrite is supposed to be measured against, which proves nothing.

```
git archive 6544b1e4d | tar -x -C /tmp/head-baseline
# mirror node_modules by symlink, with @codecast/shared pointed at the extraction
cd packages/cli
UPDATE_GOLDEN=1 GOLDEN_CLI_ROOT=/tmp/head-baseline/packages/cli \
GOLDEN_SLUGS=memory,messaging,forks,tasks,triggers,workflows,visual,publish,state,orchestration \
bun test src/install.golden.test.ts
```

The current era was then recorded from the working tree with plain
`UPDATE_GOLDEN=1 bun test src/install.golden.test.ts`, and `pre-rewrite/` keeps
only the eight files that actually differ between the two. A file the rewrite
left untouched has no copy here: a second identical byte-for-byte copy would be
noise, and its absence is itself the record that nothing moved.

## What the rewrite changed

`manifest.json` is unchanged across the two eras apart from the added `browser`
entry — every version number, every stdout line and every side-file hash
survived. The whole difference is in eight markdown files:

| File | Change |
|---|---|
| `fresh/memory.md`, `existing/memory.md` | content: `cast link <id>` became `cast link [id]`, plus a new line for `cast link` with no arguments |
| `existing/{messaging,forks,tasks,triggers,workflows,state}.md` | position only: the shared `## Referencing objects` block is now refreshed where it already sat, instead of being cut and re-appended at end of file |

The move is the point of the rewrite. The old writer removed the existing block
and appended a fresh copy after everything else, so every install walked the
shared section down past the user's own trailing sections. `diff <(sort a)
<(sort b)` on those six files is empty — the bytes are identical and only their
position moved, which is exactly the claim the rewrite makes.

## Two bugs the fixtures pin

Both were live in the shipped CLI, both were reproduced against the real binary
before being fixed, and both are the reason this snapshot exists at all: they
were content changes nobody would have noticed until a user lost work.

**1. An update could delete the rest of the file.** The old writer decided
*whether* a block existed by searching the whole file for its end marker, but
decided *where the block ended* by searching only after the heading. When the
marker sat above the heading — the shape a partly-applied heading rename leaves
behind — the second search failed, the end stayed at end-of-file, and the update
deleted everything from the heading down. Other codecast sections and the user's
own notes went with it, while the stale block was left in place, so the file also
gained a duplicate heading. `existing/*.md` pin that an update replaces only the
block it can prove it owns and leaves every neighbouring section byte-identical.

**2. Every refresh grew the file.** The cut left behind the blank line that had
separated the block from what followed, and the re-append added another. One
blank line per snippet per run, forever. The second-run comparison in the test
(each fixture is installed, then installed again over its own output) pins that
a repeat install is byte-identical rather than merely equivalent.

## Re-recording

`UPDATE_GOLDEN=1 bun test src/install.golden.test.ts` rewrites the current era in
place; `GOLDEN_SLUGS=<slug>,<slug>` narrows it to named slugs. Re-record only
when you meant to change what `cast install` writes, and show the fixture diff in
the same commit as the change that caused it — a fixture updated on its own is
indistinguishable from a regression that was goldened away.

Adding a slug to `SNIPPET_CATALOG` fails three assertions at once (a missing
`fresh/<slug>.md`, the slug-to-config-key mapping, and `help.txt`). That is the
test working: all three want recording, none wants weakening.
