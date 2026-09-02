# @platform/snippets

The idempotent, hash stamped section installer for agent instruction files
(CLAUDE.md, AGENTS.md). A product CLI installs capability sections into files
the user owns; this package is the machinery that makes those writes safe:
it recognizes the sections the installer owns, rewrites them in place, leaves
every other byte of the user's file alone, and skips the write entirely when
nothing changed. It ships no snippet bodies of its own except the platform
doctrine sections — every consumer brings its own catalog.

```
src/types.ts       SectionSpec, SnippetSection, SnippetDefinition, SnippetTarget, SnippetFs
src/sections.ts    findOwnedSections, cutOwnedSections, applySnippet (pure string engine)
src/hash.ts        snippetContentHash (FNV-1a; byte compatible with codecast's stored hashes)
src/rewriteKey.ts  snippetStale, stampSnippet, snippetHashKey
src/gating.ts      planGatedSnippets (server gated enables, predicate injected)
src/fs.ts          nodeFs (atomic writes via @platform/cli-kit), memoryFs (tests, previews)
src/targets.ts     resolveTargets (declared candidates -> instruction files on this machine)
src/install.ts     installSectionToFile / installSectionToTargets / removeSectionFromTargets / install
doctrine/          platform doctrine sections + stampDoctrine
```

Exports: `@platform/snippets` (the engine) and `@platform/snippets/doctrine`.

## The invariants the engine holds

- A block is owned only when its end marker sits after its heading and before
  the next `## ` heading. A marker stranded elsewhere in the file never causes
  a cut to run to end of file. This is the data loss bug the engine exists to
  kill.
- Updates happen in place. The refreshed section lands where it already was,
  so the user's section order never changes and repeated updates are byte
  identical. Duplicate blocks left by older writers collapse into the first
  one's position.
- A user section that shares an owned heading but carries no marker is left
  alone. Content probes are the one opt in for removing bodies written before
  markers existed.
- A write with unchanged bytes is skipped, so the file's mtime does not move
  and watchers (editors, agents reading CLAUDE.md) stay asleep.
- Writes are atomic (temp file plus rename) and never change the mode of a
  file the user already owns. A new file lands owner readable only.
- Rewrite decisions are keyed on a content hash of the body, not on version
  constants. A body edit with no version bump reinstalls; a version bump with
  identical bytes writes nothing. The version is stamped alongside the hash as
  a display value and as a shadow for older binaries. The hash function is
  byte compatible with the values codecast fleets already have in config, so
  adoption triggers no rewrite pass.

## Using it

```ts
import { install, resolveTargets, nodeFs, snippetStale, stampSnippet } from "@platform/snippets";
import * as os from "os";

const targets = resolveTargets(
  [
    { path: "~/.claude/CLAUDE.md", always: true }, // the host CLI's own client
    { path: "~/.codex/AGENTS.md" },                // included when ~/.codex exists
  ],
  { home: process.env.HOME || os.homedir(), fs: nodeFs },
);

// CATALOG is the consumer's own table of SnippetDefinitions.
const report = install(CATALOG, {
  targets,
  enabled: (def) => config[def.enabledKey] === true,
  fs: nodeFs,
});
```

`install` reconciles the whole table: enabled definitions are installed or
refreshed, disabled ones are removed from every target. Per snippet, gate the
pass with `snippetStale(config, def)` and record what was installed with
`stampSnippet(config, def, version)`. For a server gated feature (the team
turns chat on for the fleet), `planGatedSnippets(prev, reported, isEnabled)`
decides which slugs to act on; only changes act, so a human's hand disable
sticks until the team flips the flag again.

Every function takes the filesystem as a value (`SnippetFs`). `nodeFs` is the
real one; `memoryFs()` backs the tests and lets a caller preview an install
without touching disk.

## Doctrine stamping

The platform ships doctrine: engine rules every app built on `@platform`
packages should hold its agents to, written once here instead of copied into
each repo by hand. The first section is the local first store rules (render
from the store, feed it from queries, write through `action()`), generalized
from the codecast chapter that proved them.

```ts
import { stampDoctrine, DOCTRINE } from "@platform/snippets/doctrine";

stampDoctrine({ filePath: "/path/to/repo/AGENTS.md" });
```

Stamping uses the same section machinery as any snippet: the repo's own prose
survives byte for byte, a re-stamp with unchanged doctrine writes nothing, and
a platform upgrade that revises a doctrine body refreshes the section in
place. Add a new doctrine section by adding a `SnippetDefinition` under
`doctrine/` and listing it in `DOCTRINE`; the test suite proves each body is
recognized by its own spec and contains no `## ` line that would break the
boundary scan.

## Codecast adoption

Codecast's catalog (bodies, slugs, config keys) stays in
`packages/shared/contracts/snippets.ts`; its `SnippetDescriptor` satisfies
`SnippetDefinition` structurally. Two CLI files become imports:

- `packages/cli/src/snippets.ts` — `findOwnedSections`, `cutOwnedSections`,
  `applySnippet`, `installSectionToFile`, `installSectionToTargets` come from
  here (the CLI passes `nodeFs` and the targets it resolves from its agent
  client registry via `resolveTargets`). `snippetStale`/`stampSnippet` come
  from here too; codecast keeps a thin wrapper that resolves a slug against
  its catalog and throws on a typo, plus `ensureMessagingForMemory`, which is
  product policy.
- `packages/cli/src/gatedSnippets.ts` — `planGatedSnippets` comes from here;
  the daemon passes `(slug) => { const d = snippetBySlug(slug); return d ? config[d.enabledKey] === true : undefined; }`.

Deletable on adoption: the engine halves of those two files, and the engine
tests now ported here — `snippets.sections.test.ts` (the pure suites and the
file suites), `snippets.rewriteKey.test.ts`, `snippets.fileMode.test.ts`,
`gatedSnippets.test.ts`, and the resolution logic under
`snippets.targets.test.ts`. What stays in codecast: the catalog and its table
tests (unique headings and markers across real specs, the regression matrix
replayed over every shipped body), `install.golden.test.ts` (byte goldens of
the real CLI subprocess), `snippets.wiring.test.ts` and the index.ts gate
checks (they pin codecast's wiring, not the engine), and
`getSnippetTargets`'s registry driven candidate list.

## Another app's adoption

Define a catalog, resolve targets, reconcile:

```ts
const MY_SNIPPET: SnippetDefinition = {
  slug: "sync",
  name: "Sync",
  desc: "Background sync commands",
  detail: "Adds the `myapp sync` reference so agents can drive sync.",
  writesTo: "CLAUDE.md — a ## Sync section",
  shipped: "2026-08-21",
  enabledKey: "sync_enabled",
  versionKey: "sync_version",
  section: {
    spec: { headings: ["## Sync"], endMarker: "<!-- /myapp-sync -->" },
    body: "\n## Sync\n\n…\n<!-- /myapp-sync -->\n",
  },
};
```

Rules for a body: pad it with one newline at each end, put the heading on the
first real line and the end marker on the last, and never start a line with
`## ` inside it (including inside fenced code) — the boundary scan would read
it as the next section and stop recognizing the block. Keep old headings in
`spec.headings` after a rename so updates replace the old section instead of
stacking a new one.
