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
<(sort b)` returning nothing is what tells a pure move apart from a content
change in one command.

## Two bugs the fixtures pin

Both are recorded as named lists in `install.golden.test.ts`, checked on every
run, and written so that fixing the bug also fails the test — the note can never
outlive the defect it describes.

### memory's body changed, its version did not

`fresh/memory.md` differs between the eras while `manifest.json` records
`memory_version: "12"` in both. An installed machine refreshes a snippet only
when its recorded version differs from the CLI's (`index.ts:2832`), so nobody
who already has memory installed will ever receive the new `cast link` text.

`BODY_CHANGED_WITHOUT_VERSION_BUMP` names `memory` for exactly this reason. Bump
`MEMORY_VERSION` in `src/update.ts`, re-record, and delete the entry.

### orchestration reports a file it never wrote

`manifest.json` records orchestration's success line as `* Orchestration —
updated in ~/.claude/CLAUDE.md` next to `wroteClaudeMd: false`. The install
writes skills, agents and hooks; it writes no `CLAUDE.md` at all. The line is
built from the CLAUDE.md target list whatever the snippet touches
(`index.ts:9601`), and its verb comes from `entry.install(true)`, which always
passes `update: true` — so "updated" is what any change prints.

`STDOUT_NAMES_A_FILE_IT_DID_NOT_WRITE` names `orchestration`. Unremarked in the
same area: `orchestration` is wired to `getWorkVersion` (`index.ts:9560`), so
`orch_version` silently tracks the tasks version — both pin `"7"` here.

## `browser` was recorded after the rewrite, not before it

`browser` entered `SNIPPET_CATALOG` after `6544b1e4d`. At that commit the CLI's
`SNIPPET_BEHAVIOR` table has no `browser` entry, so `cast install browser`
cannot run there and no pre-rewrite output exists to record.

`fresh/browser.md`, `existing/browser.md` and its `manifest.json` entry are
therefore **post-rewrite recordings**, not a baseline. They say nothing about
whether the rewrite changed `browser`'s output — nobody has checked, and now
nobody can. They do catch every change from here on, which an unrecorded slug
would not.

`help.txt` — `cast install -h` — is post-rewrite only for the same reason: its
snippet list is generated from `SNIPPET_CATALOG` (`index.ts:9531`), so the two
eras would differ by the `browser` row alone and the comparison would say
nothing about the writers.

## What is normalised, and nothing else

- `config.json` `created_at` / `updated_at` — wall clock.
- The scratch `HOME` path inside the side files, replaced with `@HOME@` before
  hashing. `mkdtemp` gives a fresh path on every run.
- A slug that writes no `CLAUDE.md` (`orchestration` writes skills, agents and
  hooks instead) records the sentinel `@ABSENT@` rather than a missing file.

The snippet bodies embed no version and no timestamp. The version lives only in
`config.json`, and `manifest.json` records the whole config object as the CLI
wrote it — so a body edit that forgets to bump its version shows up as a
one-sided diff rather than passing unnoticed.

## Reading a failure

Compare the fixture to what the CLI writes now and decide whether the change was
intended. Two of the file's checks are NOT fixture comparisons and must never be
answered by re-recording:

- **"installing X twice does not settle"** — the second install rewrote bytes
  the first one produced. That is a writer bug on the upgrade path, the same
  class as the blank line the shipped CLI used to add on every run
  (`snippets.ts:104`).
- **"dropped user lines"** — the install ate text from `seed.md` that belongs to
  the user. The check reads the seed, not a fixture, precisely so that recording
  cannot make the loss the new normal.

Everything else is a fixture comparison. Re-record only once you have decided,
one slug at a time:

```
cd packages/cli && UPDATE_GOLDEN=1 GOLDEN_SLUGS=<slug> bun test src/install.golden.test.ts
```

and say in the commit message which slugs moved and why. `pre-rewrite/` is
frozen — nothing re-records it, and it is only meaningful next to the commit it
names.
