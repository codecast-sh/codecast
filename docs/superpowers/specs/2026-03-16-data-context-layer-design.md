# Convex Data Context Layer

## Problem

Team/workspace resolution is scattered across 40+ call sites as `user?.active_team_id || user?.team_id`. Every mutation and query independently resolves team scope, leading to recurring bugs where items get scoped to the wrong team. There is no centralized data access layer enforcing privacy, scoping, or field injection.

## Design

### Core: `createDataContext`

A single function that wraps `ctx.db` with automatic workspace scoping, team resolution, field injection, and access control. Every Convex handler creates one at the top. All reads and writes go through it.

```typescript
const db = await createDataContext(ctx, {
  userId,                   // required: from getAuthUserId or verifyApiToken
  project_path?,            // CLI: resolve team from directory_team_mappings
  workspace?,               // Web: "personal" | "team"
  team_id?,                 // Web: the selected team (when workspace === "team")
});
```

### Workspace Resolution

Runs once during `createDataContext`. Priority order:

1. `workspace: "personal"` -> type "personal", no team_id
2. `workspace: "team"` + `team_id` -> type "team", use that team
3. `project_path` provided -> look up `directory_team_mappings` via `resolveTeamForPath`
4. None of the above -> type "unscoped" (backwards compat, no workspace filtering)

### Scoped Tables

Tables with `team_id` that get automatic scoping: `tasks`, `plans`, `docs`, `projects`, `decisions`, `patterns`.

All other tables pass through to `ctx.db` unchanged.

### Writes

`db.insert(table, fields)` auto-injects:
- `user_id` from the data context
- `team_id` from resolved workspace (for scoped tables)
- `created_at` (if not already set)
- `updated_at`

### Reads

`db.query(table)` returns a scoped query builder:
- **Team workspace**: uses `by_team_id` index
- **Personal workspace**: uses `by_user_id` index + post-filter for `!team_id`
- **Unscoped**: no workspace filter, returns raw `ctx.db.query(table)`

The `PersonalQuery` wrapper proxies `.filter()`, `.order()`, `.take()`, `.first()`, `.collect()` and applies the `!team_id` filter transparently on terminal operations.

For non-scoped tables, `db.query(table)` returns the raw Convex query builder.

### Access Control

- `db.get(id)`: returns the doc if user owns it OR doc belongs to user's current team. Returns `null` otherwise.
- `db.patch(id, fields)`: same ownership check, throws on failure. Auto-sets `updated_at`.
- `db.delete(id)`: same ownership check, throws on failure.

### Escape Hatch

`db.unscoped` returns a data context with workspace type "unscoped". Used for inbox (global session list), admin views, and cross-workspace reads.

```typescript
const allSessions = await db.unscoped.query("conversations")
  .withIndex("by_user_updated", q => q.eq("user_id", userId))
  .collect();
```

### File Structure

- `packages/convex/convex/data.ts` -- the entire layer (~150 lines)
- Imports `resolveTeamForPath` from `privacy.ts`
- `resolveTeamForMutation` in `privacy.ts` is deleted (absorbed)

### Migration

Big bang: rewrite all 40+ instances of `user?.active_team_id || user?.team_id` across:
- `tasks.ts` (~10 instances)
- `plans.ts` (~6 instances)
- `docs.ts` (~3 instances)
- `projects.ts` (~1 instance)
- `taskMining.ts` (~5 instances)
- `decisions.ts` (~1 instance)
- `conversations.ts` (~6 instances)
- `dispatch.ts` (~6 instances)

Each function gets `const db = await createDataContext(ctx, { ... })` at the top, and all `ctx.db` calls for scoped tables route through `db` instead.

Functions that need cross-workspace access (inbox, session dispatch) use `db.unscoped`.

### What This Replaces

- `resolveTeamForMutation` in `privacy.ts`
- All inline `user?.active_team_id || user?.team_id` patterns
- The `workspace`/`team_id` arg handling added to `webList` queries (absorbed into data context)
- Manual `team_id` injection on every insert call

### What This Does NOT Change

- Schema (no changes to tables or indexes)
- The `resolveTeamForPath` function (reused as-is)
- Client-side code (useWorkspaceArgs, TeamSwitcher)
- HTTP routes / API surface
