# Dynamic scopes and the scope page (W3)

A scope is what a role owns: a set of projects and plans. Default: one
project. Short lived: one plan (offer to retire the role when the plan closes).
Large: several projects. The root anchor's scope is the workspace.

## F1. Rules

- `org_roles.scope = { project_ids, plan_ids }`. A task is in scope when its
  `project_id` is in the set, or its `plan_id` is in the set, or its plan's
  project is in the set. A session is in scope when it is bound to a task or
  plan in scope, or its `project_path` equals a scope project's `project_path`,
  or it carries `org_role_id` for the role.
- Containment: a child's scope must be inside its parent's scope unless the
  parent is the root. Sibling overlap is allowed and shown as a warning on the
  org page and the scope page (two roles watch the same project).
- Scope changes are human only (scope page settings, `cast role scope <h>
  --add project:<ref> --remove plan:<ref>`), logged as a charter doc entry, and
  wake the role immediately.
- A role created from a project page ("Add a lead") starts with that project.

## F2. Query `org.scopeFeed`

```
org.scopeFeed({ role_id } | { scope: { project_ids, plan_ids } }, cursor?, limit? = 40, kinds?)
→ { rows: FeedRow[]; next_cursor? }
FeedRow = { kind: "session" | "task" | "plan" | "doc" | "artifact" | "decision" | "update" | "commit",
            id, short_id?, title, state?: string, actor?: { name, image?, is_bot? },
            updated_at, href, preview?: string, image_url?: string }
```

Sources, each read newest first with its own cursor and merged by
`updated_at`: conversations in scope (rule above; `by_team_user_updated` per
member with a 30 day cutoff), tasks (`by_project`/`by_plan` indexes; add if
missing), plans (`by_project`), docs (`by_project`, `by_plan`), artifacts
(published pages whose owning conversation is in scope), session_decisions
(`by_task` for tasks in scope), project_updates (`by_project_created`),
commits (`commits` table by repo in scope, last 7 days). Images: an artifact
row of image kind, or a message image in a session in scope, gives
`image_url` so the feed can show a thumbnail row.

## F3. The scope page `/org/<or-id>`

Also the role page (W1 T6). Layout:

- Header: name, handle, trust stage pill, host and model, the state stripe,
  reports to, caps and today's counters, actions (Talk, Wake, Pause, Retire).
- Board line: the brief's first line with the fact counts beside it.
- Tabs: Feed (default; kind filter chips, infinite scroll, thumbnails for
  images and pages), Tasks (the existing task board filtered to the scope,
  reusing the `/tasks` list component with a scope filter), Plans, Docs,
  Sessions (the org page's cluster list for this node), Decisions (open and
  answered, stacks), Brief and Charter, Settings (scope editor with project
  and plan pickers and overlap warnings, trust, caps, model, reports to,
  channels the role follows, retire).
- The root anchor has the same page at `/org/workspace`.
- Phone: header collapses to name and stripe; tabs scroll; the feed is the
  page.
