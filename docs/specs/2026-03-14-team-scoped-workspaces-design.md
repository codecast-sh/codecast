# Team-Scoped Workspaces

## Problem

Plans, tasks, and docs have an optional `team_id` field in the schema, but the web UI doesn't filter by team. Everything shows up in a single flat list regardless of which team is selected. Meanwhile, projects without a team mapping (like Codecast itself) have no natural home -- there's no concept of a "personal" workspace.

## Design

### Core Principle

The workspace switcher scopes durable, organized work (plans, tasks, docs, projects, conversation archive). The inbox/activity feed stays global because it's a real-time monitor of all active sessions.

### Workspace Switcher

Add a permanent "Personal" entry to the `TeamSwitcher` component:

- Always first in the list, above all teams
- Uses the `User` Lucide icon with neutral styling
- Not editable or customizable
- Selecting it sets `active_team_id` to `null`

Teams continue to work as they do today. The switcher becomes a workspace picker: Personal or one of the user's teams.

The existing `useEffect` in `TeamSwitcher` that auto-selects a team when none is active must be reworked: `null` is a valid selection (Personal workspace), not "no selection yet." Only auto-select on first-ever use if the user has never explicitly chosen.

### Scoping Rules

| Area | Scoped by workspace? | Behavior |
|---|---|---|
| Plans | Yes | Filtered by selected workspace's `team_id` |
| Tasks | Yes | Filtered by selected workspace's `team_id` |
| Docs | Yes | Filtered by selected workspace's `team_id` |
| Projects | Yes | Filtered by selected workspace's `team_id` |
| Decisions | Yes | Filtered by selected workspace's `team_id` |
| Conversation archive | Yes | Filtered by selected workspace's `team_id` |
| Inbox / activity feed | No | Always shows all active sessions globally |

**Personal workspace** = items where `team_id` is `null`/`undefined`.
**Team workspace** = items where `team_id` matches the selected team.

Note: `patterns`, `session_insights`, and `day_timelines` also have `team_id` but are lower priority. They should follow the same scoping rules if displayed in any workspace-scoped view.

### Inbox Team Badges

Each session card in the inbox gets a small badge showing the team's icon and color (via `TeamIcon`). Sessions with no team show no badge. This gives at-a-glance context without requiring workspace switching.

### Creation Flow

New plans, tasks, and docs inherit `team_id` from the currently selected workspace:

- Personal selected: created with no `team_id`
- Team selected: created with that team's `team_id`

No explicit team picker in creation forms. If you need to create something for a different team, switch workspaces first.

### CLI Team Resolution

CLI commands (`cast task`, `cast plan`, etc.) resolve team from the current working directory using `directory_team_mappings`, matching the same logic used for conversation routing in `resolveTeamForPath`.

- Directory has a team mapping: use that team's `team_id`
- No mapping: personal workspace (no `team_id`)
- Optional `--team <name>` flag for explicit override

This is more correct than using `active_team_id` from the web UI, since a user may be working in a directory that belongs to a different team than what's selected in the browser.

### Data Model

No schema changes required. The existing structure already supports this:

- `team_id` is optional on plans, tasks, docs, projects, decisions
- `null`/`undefined` = personal workspace
- Existing indexes (`by_team_id`, `by_user_id`, `by_user_status`) support both filtered and unfiltered queries

### Query Architecture

**Workspace selection is passed as an explicit argument from the client to each query function**, rather than reading `user.active_team_id` server-side. This avoids cascading reactivity where changing the workspace triggers a user record update that re-renders every query subscribing to the user.

The `user.active_team_id` field continues to be written (for persistence across page loads) but query functions receive the workspace team ID directly as a parameter.

**Query patterns by workspace:**

- **Team selected**: use `by_team_id` index to query items matching the selected team. Straightforward.
- **Personal selected**: Convex indexes cannot query for undefined field values. Use `by_user_id` (or `by_user_status`) index and filter in-memory for `!doc.team_id`. For large item counts, paginate. This is acceptable because personal workspace items are typically fewer than team items, and the `by_user_id` index narrows the scan.

**Existing functions to update:**

The `webList` functions (e.g., `plans.ts:webList`) currently read `user?.active_team_id || user?.team_id` and branch between `by_team_id` and `by_user_id` queries. These need to accept an explicit `team_id` argument (nullable) and use the query patterns above.

The `docs.webList` function currently merges user docs with team docs and dedupes. Under workspace scoping, it should use one path or the other, not merge.

### Team Member Visibility

When viewing a team workspace, users see all items belonging to that team (from all team members), not just their own. This is consistent with team semantics -- if you create a task under a team, all members should see it.

### Edge Cases

- **User switches teams while viewing a plan detail page**: redirect to the plans list for the new workspace, since the current plan may not belong to the new workspace.
- **CLI in an unmapped directory with `--team` flag**: use the specified team. Without the flag, create as personal.
- **Existing plans/tasks with no team_id**: these appear in the Personal workspace. No migration needed.
- **User removes a directory-team mapping**: existing items created under that team stay with that team. Only future creations are affected.
- **Moving items between workspaces**: not supported in v1. Items stay in the workspace where they were created. Can be added later if needed.
- **Conversation archive performance**: for users with large conversation histories, the personal workspace query (by_user + in-memory filter for `!team_id`) may need pagination. Implement with Convex `.paginate()` from the start.

## Implementation Notes

### Components to modify

- `TeamSwitcher.tsx`: add Personal entry, accept `null` in `handleTeamChange`, rework auto-select `useEffect`
- `setActiveTeam` mutation: accept `null` to clear `active_team_id`
- Plans page query hooks: pass workspace `team_id` as query argument
- Tasks page query hooks: same
- Docs page query hooks: same
- Projects page query hooks: same
- Conversation archive queries: same
- Inbox session cards: add team badge via `TeamIcon`
- CLI task/plan commands: resolve team from directory mapping instead of `active_team_id`

### Convex functions to modify

- `plans.ts` webList/query functions: accept explicit `team_id` argument (nullable), filter accordingly
- `tasks.ts` webList/query functions: same
- `docs.ts` webList: stop merging user+team results, scope to one workspace
- `decisions.ts` query functions: add workspace filtering
- CLI API endpoints that create plans/tasks: accept directory path, resolve team via `resolveTeamForPath`
