# Agent Organization proposal, version two

Product design for an organization of agent sessions: leads at workspace, project and plan scope, workers at task scope, each understanding the work at its own level. Builds on version one (the parent directory, plan pl-519), which set the control plane contracts. Version two designs the product those contracts left open.

Proposal plan: pl-544. Published page: see `review/publication.json` once published.

This is a proposal. It authorizes nothing and deploys nothing.

## Contents

- `c01.md` to `c12.md`: the twelve chapters, in reading order.
- `figures.html`: figure and mockup templates, referenced from chapters by `<!-- FIGURE:name -->` and `<!-- MOCKUP:name -->`.
- `base.css`: the page's design system. Light page, one colour per organization level, dark app frames for mockups.
- `meta.json`: title, headline, reading paths, chapter level colours.
- `build.mjs`: assembles `index.html` from the above. Reuses the version one pipeline shape.
- `validate.py`: strict markup, fragment and chapter order checks.
- `review/`: critic findings, polish record and browser verification.

## Build and validate

From the repository root, with dependencies installed:

```bash
bun docs/proposals/agent-organization/v2/build.mjs
python3 docs/proposals/agent-organization/v2/validate.py
```

## Publish

```bash
cast publish docs/proposals/agent-organization/v2/index.html --title "Agent Organization v2: product proposal" --edit-mode owner
```

Publish only `index.html`. The page has no author supplied JavaScript.
