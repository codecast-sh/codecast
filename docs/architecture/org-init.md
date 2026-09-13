# Org init and update (W5)

`cast org init` proposes an organization from what exists; `cast org update`
proposes changes when the workspace drifts. Both end in a decision stack the
person answers; nothing is created without an answer.

## O1. Inputs

`org.analysisInputs({ team_id? })` returns, for the workspace: projects with
task counts by status, plans with progress, docs by type, members with session
counts by project path (30 days), the top labels, git roots and remote urls
seen on sessions, session_insights themes and outcomes (30 days), chat
channels with activity, existing roles and anchors, open decisions by category.

## O2. Analyzer

`cast org init [--apply]` spawns a session (or runs in the current one with
`--here`) with the analyzer prompt: read the inputs, read the repo layout for
each git root (top level directories, package names), and write:

1. A proposal doc (doc_type "design") with the proposed chart, one section per
   role: name, handle, scope, reports to, charter paragraph, why this role
   (evidence: counts and session titles), suggested trust stage, caps.
2. A decision stack "Adopt the org for <workspace>": one decision per proposed
   role (create as proposed, create with changes, skip) plus one for the
   projects it proposes to create or merge, each linking the doc section.

`cast org apply <ds-N>` creates roles, scopes and charters for every accepted
member and provisions standing sessions. `cast org update` runs the same
analyzer in diff mode: it receives the current org and reports unfiled work,
idle roles (no scope events in 14 days), overloaded roles (wake cap hit daily),
sibling overlaps, new projects with no role, and proposes moves as a stack.

## O3. Hire flow in the web

"Add a role" on `/org` and "Add a lead" on a project page open the same form:
scope (preview: N plans, N tasks, N sessions it will read, N it cannot),
responsible person, host and payer, charter (proposed text, editable), trust
stage (understand only at creation, decide and direct visible and locked with
the unlock sentence), caps. Submit calls `orgRoles.create` then `provision`.
