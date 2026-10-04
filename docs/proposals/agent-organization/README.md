# Agent Organization proposal

> **Status (2026-10-04):** Superseded by `docs/proposals/org/index.html` (plan pl-622, done), whose contracts live in `docs/architecture/org-roles.md`, `org-roles-standing.md` and `org-staffing.md`. The roadmap pl-529 never ran (draft, 0/16). Its core idea, scoped leads as widened anchors, shipped in another form: roles are anchor rows in `org_roles` (`packages/convex/convex/orgRoles.ts`).
> The control plane specified here (per session role credentials, reservations, receipts, the decision ladder) was not built; escalation was removed on 2026-09-29 (e56bf1797).

Published page: https://codecast.sh/a/d0vFfz4flyqj

Proposal plan: pl-519. Draft implementation roadmap: pl-529.

Version 3 includes the final accessibility-label cleanup. On 5 September 2026, coordinator jx70p9m confirmed publication and DOM verification: ten chapters, nine focusable code blocks, no generic labels, and no horizontal overflow. ct-48817 and pl-519 are closed; pl-529 remains draft. No proposal work remains.

This deliverable proposes a feature. It does not implement or authorize managed agents, runtime spending, adoption, or deployment.

## Contents

- `index.html`: self-contained page markup and styles; Google Fonts have local fallback stacks.
- `s01.md` through `s10.md`: the ten reviewed source chapters.
- `figures.html`: accessible HTML diagrams and static interface concepts.
- `base.css`, `polish.css`: design and responsive styles.
- `implementation-map.json`: 16 filed backlog tasks, mapped to the proposal DAG.
- `review/`: independent reviews, correction record, and document/browser verification.

## Build and validate

Run from the repository root after installing its existing Bun dependencies:

```bash
bun docs/proposals/agent-organization/build.mjs
python3 docs/proposals/agent-organization/validate.py
```

The builder uses the already-installed `marked` package. No application dependency or runtime source was changed. The generated page has no author-supplied JavaScript; diagrams, evidence disclosure and contents use native HTML.

To republish the same page:

```bash
cast publish docs/proposals/agent-organization/index.html --title "Agent Organization: product proposal" --edit-mode owner
```

Only publish `index.html`, not this entire source directory. Publication management credentials are intentionally excluded.
