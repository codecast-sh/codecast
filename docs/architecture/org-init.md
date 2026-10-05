# Org init and update (W5)

> Superseded in part: the analyzer no longer writes a design doc and a decision stack. It is the Head of People prompt (`shared/contracts/headOfPeoplePrompt.ts`) and posts staffing proposals (`op-N`, `cast org propose`) that a person accepts, edits or skips on the org page; see org-staffing.md S4, S8 and S24. The decision stack path in O2 survives only for org templates. Trust stages and caps in O3 are gone (org-staffing.md S23).

`cast org init` proposes an organization from what exists; `cast org update`
proposes changes when the workspace drifts. Both end in a decision stack the
person answers; nothing is created without an answer.

## O1. Inputs

`orgInit.analysisInputs({ team_id? })` (route `/cli/org/analysis-inputs`,
`cast org inputs`) assembles bounded query slices (`orgInit.analysisPart`:
work, activity, org, signals, goals, landing, per session use) and returns,
for the workspace: projects with
task counts by status, plans with progress, docs by type, members with session
counts by project path (30 days), the top labels, git roots and remote urls
seen on sessions, session_insights themes and outcomes (30 days), chat
channels with activity, existing roles and anchors, open decisions by category.

## O2. Analyzer

`cast org init` spawns a session (or prints the prompt for the current one
with `--here`) with the analyzer prompt: read the inputs, read the repo layout for
each git root (top level directories, package names), and write:

1. A proposal doc (doc_type "design") with the proposed chart, one section per
   role: name, handle, scope, reports to, charter paragraph, why this role
   (evidence: counts and session titles), suggested trust stage, caps.
2. A decision stack "Adopt the org for <workspace>": one decision per proposed
   role (create as proposed, create with changes, skip) plus one for the
   projects it proposes to create or merge, each linking the doc section.

`cast org apply <ds-N>` creates roles, scopes and charters for every accepted
member and provisions standing sessions (`--no-provision` skips that); for a
proposal, `cast org apply <op-N>` only prints its changes and the org page
link. `cast org update` runs the same analyzer in review mode (the same run
as `cast org review`, spawned): it receives the current org and reports unfiled work,
idle roles (no scope events in 14 days), overloaded roles (wake cap hit daily),
sibling overlaps, new projects with no role, and proposes moves as a stack.

## O3. Hire flow in the web

"Add a role" on `/org` and "Add a lead" on a project page open the same form
(`components/org/HireRoleDialog.tsx`): scope (preview from
`org.scopeSummary`: N plans, N tasks, N sessions it will read, N it cannot),
reports to, charter (proposed text, editable), tenure, avatar; the host is
the viewer. Submit is one store action, `createOrgRole` with `provision:
true`, which rides `orgRoles.create`.
