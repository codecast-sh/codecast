# Team-Scoped Workspaces Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Personal" workspace to the team switcher and scope plans, tasks, docs, projects, and conversation archive by workspace, while keeping the inbox global.

**Architecture:** The TeamSwitcher gets a permanent "Personal" entry (null team_id). All `webList` query functions accept explicit `team_id` and `workspace` arguments from the client instead of reading `user.active_team_id` server-side. Personal workspace queries use `by_user_id` index + in-memory filter for `!team_id`. Inbox remains unscoped with team badges on session cards.

**Tech Stack:** Convex (backend queries/mutations), React + Zustand (frontend state), TypeScript

**Spec:** `docs/superpowers/specs/2026-03-14-team-scoped-workspaces-design.md`

**Out of scope:** `patterns`, `session_insights`, `day_timelines` tables -- these have `team_id` but are not displayed in workspace-scoped views yet. Scope them when they get UI.

---

## Chunk 1: Backend Query Changes

All backend changes follow the same pattern: add `team_id: v.optional(v.id("teams"))` and `workspace: v.optional(v.union(v.literal("personal"), v.literal("team")))` to args. Replace server-side `user.active_team_id` resolution with explicit arg-based branching. Keep a backwards-compat fallback (no workspace arg = all user items) so the CLI API-token endpoints continue working until Task 12.

**IMPORTANT:** These are targeted edits to the query resolution logic only. Preserve all existing enrichment, filtering, pagination, and return value logic in each function. Only replace the block that determines which index/query to use.

### Task 1: Verify `setActiveTeam` mutation handles null

**Files:**
- Review: `packages/convex/convex/teams.ts:758-790`

- [ ] **Step 1: Verify the mutation already handles undefined**

The mutation already has `v.optional(v.id("teams"))` for `team_id` and an `else` branch (lines 779-785) that clears `active_team_id`. No code change needed. Verify by reading the function.

- [ ] **Step 2: Move on (no commit needed)**

### Task 2: Update `plans.webList` to accept explicit workspace args

**Files:**
- Modify: `packages/convex/convex/plans.ts:755-795`

- [ ] **Step 1: Add workspace args and replace team resolution**

Add to the `args` object:
```typescript
team_id: v.optional(v.id("teams")),
workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
```

Replace the block that reads `user.active_team_id` (approximately lines 767-787) with workspace-based branching. The `project_id` path stays unchanged. The new branching logic:

```typescript
// Replace: const user = await ctx.db.get(userId);
//          const team_id = user?.active_team_id || user?.team_id;
// With workspace-based resolution:

let plans;
if (args.project_id) {
  // existing project_id path -- unchanged
} else if (args.workspace === "team" && args.team_id) {
  plans = await ctx.db.query("plans")
    .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id!))
    .collect();
} else if (args.workspace === "personal") {
  plans = await ctx.db.query("plans")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  plans = plans.filter((p) => !p.team_id);
} else {
  // Backwards compat: no workspace specified = all user's plans
  plans = await ctx.db.query("plans")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
}
```

Preserve all downstream logic (status filtering, `include_all`, `limit`, return value).

- [ ] **Step 2: Verify no type errors**

Run: `cd /Users/ashot/src/codecast && npx convex dev --once`

- [ ] **Step 3: Commit**

```bash
git add packages/convex/convex/plans.ts
git commit -m "feat(convex): add workspace scoping to plans.webList"
```

### Task 3: Update `tasks.webList` to accept explicit workspace args

**Files:**
- Modify: `packages/convex/convex/tasks.ts:658-773`

- [ ] **Step 1: Add workspace args and replace team resolution**

Same pattern as Task 2. Add `team_id` and `workspace` to args. Replace the block that reads `user.active_team_id` with workspace-based branching.

**IMPORTANT:** Preserve all existing logic after the query resolution block:
- Status filtering (lines ~697-699 default status filter)
- `include_derived` filter (lines ~702-704)
- `ready` filter with dependency checking (lines ~706-715)
- Full enrichment logic: creator lookup, assignee info, plan info, activeSession mapping (lines ~719-771)
- Return value structure with enriched fields

Only replace the query resolution block (which index to use and how to get the initial `tasks` array).

- [ ] **Step 2: Verify no type errors**

Run: `cd /Users/ashot/src/codecast && npx convex dev --once`

- [ ] **Step 3: Commit**

```bash
git add packages/convex/convex/tasks.ts
git commit -m "feat(convex): add workspace scoping to tasks.webList"
```

### Task 4: Update `docs.webList` to use workspace scoping

**Files:**
- Modify: `packages/convex/convex/docs.ts:294-435`

- [ ] **Step 1: Add workspace args and replace merge logic**

Add `team_id` and `workspace` to args. Replace the dual-fetch + merge + dedupe logic with workspace-scoped queries.

**IMPORTANT:** This function has substantial post-query logic that must be preserved:
- `resolveConvTeamId` for conversation-based team resolution
- `scope` arg handling for project views
- `projectPaths` computation and return value
- Plan title extraction
- Author enrichment
- The return type `{ docs, projectPaths }`

Only replace the section that determines which docs to fetch (the user docs + team docs fetch and merge/dedupe block). Route to either `by_team_id` or `by_user_id` + filter based on workspace args.

- [ ] **Step 2: Verify no type errors**

Run: `cd /Users/ashot/src/codecast && npx convex dev --once`

- [ ] **Step 3: Commit**

```bash
git add packages/convex/convex/docs.ts
git commit -m "feat(convex): add workspace scoping to docs.webList"
```

### Task 5: Update `projects.webList` to accept workspace scoping

**Files:**
- Modify: `packages/convex/convex/projects.ts:134-169`

- [ ] **Step 1: Add workspace args and replace query logic**

Add `team_id` and `workspace` to args. Replace the query resolution to support workspace branching.

**IMPORTANT:** Preserve existing enrichment logic (task counts at lines ~157-168) and status filtering. Only replace the query path that determines how to fetch the initial projects list.

Note: In team workspace, `by_team_id` will return projects from all team members. This is intentional -- team workspace shows shared items.

- [ ] **Step 2: Verify no type errors**

Run: `cd /Users/ashot/src/codecast && npx convex dev --once`

- [ ] **Step 3: Commit**

```bash
git add packages/convex/convex/projects.ts
git commit -m "feat(convex): add workspace scoping to projects.webList"
```

---

## Chunk 2: TeamSwitcher & Frontend Wiring

### Task 6: Add "Personal" entry to TeamSwitcher

**Files:**
- Modify: `packages/web/components/TeamSwitcher.tsx`

- [ ] **Step 1: Rework the useEffect auto-select logic**

The current `useEffect` (lines 33-46) auto-selects a team whenever `activeTeamId` is undefined. This fights the Personal workspace since undefined IS the personal selection.

To distinguish "never selected" from "selected Personal": add a `workspace_initialized` flag to `ClientUI` in the store. Set it to `true` whenever the user makes any workspace selection (including Personal). The `useEffect` only auto-selects a team when `workspace_initialized` is falsy.

```typescript
// In TeamSwitcher:
const workspaceInitialized = useInboxStore((s) => s.clientState.ui?.workspace_initialized);

useEffect(() => {
  if (teams && teams.length > 0 && !workspaceInitialized) {
    // First-time: default to first team
    handleTeamChange(teams[0]._id);
    updateClientUI({ workspace_initialized: true });
  }
}, [teams, workspaceInitialized]);
```

Also add `workspace_initialized?: boolean` to the `ClientUI` type in `packages/web/store/inboxStore.ts`.

- [ ] **Step 2: Update handleTeamChange to accept null**

```typescript
const handleTeamChange = async (teamId: Id<"teams"> | null) => {
  setActiveTeam(teamId);
  updateClientUI({ workspace_initialized: true });
  await saveActiveTeam({ team_id: teamId ?? undefined });
};
```

- [ ] **Step 3: Add Personal entry to the dropdown**

Add before the teams list in the dropdown, after the trigger:

```tsx
<DropdownMenuItem
  onClick={() => handleTeamChange(null)}
  className="flex items-center gap-2"
>
  <User className="h-4 w-4 text-sol-dim" />
  <span>Personal</span>
  {!activeTeamId && <Check className="h-4 w-4 ml-auto" />}
</DropdownMenuItem>
<DropdownMenuSeparator />
```

Import `User` from `lucide-react`.

- [ ] **Step 4: Update the trigger to show "Personal" when no team selected**

```tsx
{activeTeam ? (
  <>
    <TeamIcon icon={activeTeam.icon} color={activeTeam.icon_color} size={16} />
    <span className="truncate max-w-[120px]">{activeTeam.name}</span>
  </>
) : (
  <>
    <User className="h-4 w-4 text-sol-dim" />
    <span>Personal</span>
  </>
)}
```

- [ ] **Step 5: Verify in browser**

Open `http://local.codecast.sh`. Verify:
1. Team switcher shows "Personal" at top with separator below
2. Selecting Personal clears the active team, shows "Personal" in trigger
3. Selecting a team works as before
4. Refreshing the page preserves the selection (including Personal)

- [ ] **Step 6: Commit**

```bash
git add packages/web/components/TeamSwitcher.tsx packages/web/store/inboxStore.ts
git commit -m "feat(web): add Personal workspace entry to TeamSwitcher"
```

### Task 7: Create `useWorkspaceArgs` hook

**Files:**
- Create: `packages/web/hooks/useWorkspaceArgs.ts`

- [ ] **Step 1: Create the hook**

Returns the `team_id` and `workspace` args that all scoped queries need. Returns `"skip"` when workspace state isn't initialized yet (prevents flash of wrong data on first load).

```typescript
import { useInboxStore } from "../store/inboxStore";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

type WorkspaceArgs =
  | { team_id: Id<"teams">; workspace: "team" }
  | { workspace: "personal" }
  | "skip";

export function useWorkspaceArgs(): WorkspaceArgs {
  const activeTeamId = useInboxStore(
    (s) => s.clientState.ui?.active_team_id
  ) as Id<"teams"> | undefined;
  const initialized = useInboxStore(
    (s) => s.clientState.ui?.workspace_initialized
  );

  if (!initialized) return "skip";

  if (activeTeamId) {
    return { team_id: activeTeamId, workspace: "team" as const };
  }
  return { workspace: "personal" as const };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/hooks/useWorkspaceArgs.ts
git commit -m "feat(web): add useWorkspaceArgs hook for workspace-scoped queries"
```

### Task 8: Wire plans page to workspace scoping

**Files:**
- Modify: `packages/web/app/plans/page.tsx`

- [ ] **Step 1: Use useWorkspaceArgs in the plans page**

```typescript
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";

// Inside PlansPage:
const workspaceArgs = useWorkspaceArgs();

const activePlans = useQuery(api.plans.webList,
  workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
);
const donePlans = useQuery(api.plans.webList,
  workspaceArgs === "skip" ? "skip"
    : showDone ? { status: "done", ...workspaceArgs } : "skip"
);
```

- [ ] **Step 2: Verify in browser**

Switch between Personal and a team. Plans should filter accordingly.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/plans/page.tsx
git commit -m "feat(web): scope plans page by workspace"
```

### Task 9: Wire tasks page to workspace scoping

**Files:**
- Modify: `packages/web/hooks/useSyncTasks.ts`

- [ ] **Step 1: Update useSyncTasks to pass workspace args**

```typescript
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncTasks(statusFilter?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const tasks = useQuery(api.tasks.webList,
    workspaceArgs === "skip" ? "skip" : {
      status: statusFilter || undefined,
      ...workspaceArgs,
    }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  useEffect(() => {
    if (tasks) {
      syncTable("tasks", tasks as any);
    }
  }, [tasks, syncTable]);
}
```

- [ ] **Step 2: Verify in browser**

Switch workspaces, verify tasks filter correctly.

- [ ] **Step 3: Commit**

```bash
git add packages/web/hooks/useSyncTasks.ts
git commit -m "feat(web): scope tasks page by workspace"
```

### Task 10: Wire docs page to workspace scoping

**Files:**
- Modify: `packages/web/hooks/useSyncDocs.ts`

- [ ] **Step 1: Update useSyncDocs to pass workspace args**

```typescript
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncDocs(typeFilter?: string, searchQuery?: string, projectFilter?: string, scope?: string) {
  const workspaceArgs = useWorkspaceArgs();
  const queryArgs = workspaceArgs === "skip" ? "skip" as const
    : searchQuery
      ? { query: searchQuery, doc_type: typeFilter || undefined, scope: scope || undefined, ...workspaceArgs }
      : { doc_type: typeFilter || undefined, project_path: projectFilter || undefined, scope: scope || undefined, ...workspaceArgs };

  const result = useQuery(
    searchQuery ? api.docs.webSearch : api.docs.webList,
    queryArgs
  );
  // ... rest unchanged
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/hooks/useSyncDocs.ts
git commit -m "feat(web): scope docs page by workspace"
```

### Task 11: Wire projects queries and prefetch to workspace scoping

**Files:**
- Modify: `packages/web/hooks/usePrefetch.ts`
- Modify: any component calling `api.projects.webList` (search for `useQuery(api.projects.webList`)

- [ ] **Step 1: Update usePrefetch to pass workspace args**

```typescript
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function usePrefetch() {
  const pathname = usePathname();
  const workspaceArgs = useWorkspaceArgs();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnDocsPage = pathname === "/docs" || pathname?.startsWith("/docs/");

  const tasks = useQuery(api.tasks.webList,
    isOnTasksPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const docsResult = useQuery(api.docs.webList,
    isOnDocsPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  // ... rest unchanged
}
```

- [ ] **Step 2: Find and update projects page query calls**

Search for `useQuery(api.projects.webList` across the web package. Add `...workspaceArgs` to each call, handling the `"skip"` case.

- [ ] **Step 3: Commit**

```bash
git add packages/web/hooks/usePrefetch.ts
git commit -m "feat(web): scope prefetch and projects queries by workspace"
```

---

## Chunk 3: Creation Flow & Conversation Archive

### Task 12: Ensure creation mutations respect workspace

**Files:**
- Review: `packages/convex/convex/plans.ts` (create mutation)
- Review: `packages/convex/convex/tasks.ts` (create mutation)
- Review: `packages/convex/convex/docs.ts` (create mutation)

- [ ] **Step 1: Check how create mutations resolve team_id**

The web-facing create mutations likely read `user.active_team_id` to set `team_id` on new items. Since the TeamSwitcher already writes to `user.active_team_id` via `setActiveTeam`, creation should automatically inherit the correct workspace.

Read each create mutation to verify:
- `plans.create` or `plans.webCreate` -- does it use `user.active_team_id`?
- `tasks.create` or `tasks.webCreate` -- same
- `docs.create` or `docs.webCreate` -- same

If they read `user.active_team_id`, they'll work correctly because selecting Personal clears it (undefined = no team_id on the created item). If they use a different mechanism, update them.

- [ ] **Step 2: Test creation in both workspaces**

1. Select Personal workspace, create a task via the web UI. Verify it has no `team_id`.
2. Select a team workspace, create a task. Verify it has the team's `team_id`.
3. Switch workspaces and verify the items appear in the correct workspace.

- [ ] **Step 3: Fix if needed, commit**

```bash
git add packages/convex/convex/plans.ts packages/convex/convex/tasks.ts packages/convex/convex/docs.ts
git commit -m "fix(convex): ensure create mutations respect workspace selection"
```

### Task 13: Scope conversation archive "my" filter by workspace

**Files:**
- Modify: `packages/web/hooks/useConversationsWithError.ts`
- Review: `packages/convex/convex/conversations.ts` (listConversations handler)

- [ ] **Step 1: Analyze current behavior**

Currently (line 27): `activeTeamId: filter === "team" && activeTeamId ? activeTeamId : undefined`. The "my" filter never passes `activeTeamId`, so it returns ALL user conversations regardless of workspace.

Per the spec, conversation archive should be scoped by workspace. The "my" filter needs to pass workspace info too.

- [ ] **Step 2: Pass workspace args for "my" filter**

Update the query call to also pass workspace info when filter is "my":

```typescript
const workspaceArgs = useWorkspaceArgs();
// Build query args based on filter
const queryTeamId = filter === "team" && activeTeamId
  ? activeTeamId
  : workspaceArgs !== "skip" && workspaceArgs.workspace === "team"
    ? workspaceArgs.team_id
    : undefined;
```

Then update the `listConversations` handler in Convex to:
- When `activeTeamId` is provided: filter by that team (existing behavior)
- When a new `workspace: "personal"` arg is provided: filter for conversations with no `team_id`

- [ ] **Step 3: Update `listConversations` backend if needed**

Check if the handler can accept a `workspace` arg and filter conversations with no `team_id` for the personal case. This may require querying `by_user_updated` and filtering in-memory for `!conv.team_id`.

- [ ] **Step 4: Verify and commit**

```bash
git add packages/web/hooks/useConversationsWithError.ts packages/convex/convex/conversations.ts
git commit -m "feat: scope conversation archive by workspace"
```

---

## Chunk 4: Inbox Team Badges

### Task 14: Add team badges to inbox session cards

**Files:**
- Modify: `packages/web/components/ActivityFeed.tsx:229-367`
- Review: `packages/web/hooks/useSyncInboxSessions.ts` (check if session data includes team_id)

- [ ] **Step 1: Check if session data includes team info**

Read `useSyncInboxSessions.ts` and the `listIdleSessions` query to see what fields are returned. If `team_id` is present on sessions, we can look up team info. If not, we may need to join it in the query.

- [ ] **Step 2: Get team info for badge display**

Option A: If sessions have `team_id`, query `api.teams.getUserTeams` (already used by TeamSwitcher) and build a map.
Option B: If the query can be extended, have it return team name/icon/color inline.

- [ ] **Step 3: Add TeamIcon badge to session card header**

In the SessionCard header row, after the project tag, add a small team badge:

```tsx
import { TeamIcon } from "./TeamIcon";

// In the header row:
{item.team_id && teamInfo && (
  <span className="flex items-center gap-1">
    <TeamIcon
      icon={teamInfo.icon}
      color={teamInfo.icon_color}
      size={12}
    />
  </span>
)}
```

- [ ] **Step 4: Verify in browser**

Check that active sessions show their team icon badge. Personal sessions show no badge.

- [ ] **Step 5: Commit**

```bash
git add packages/web/components/ActivityFeed.tsx
git commit -m "feat(web): add team badges to inbox session cards"
```

---

## Chunk 5: CLI & Polish

### Task 15: Update CLI task/plan commands to resolve team from directory

**Files:**
- Modify: `packages/cli/src/index.ts` (search for task create, plan create commands)

- [ ] **Step 1: Find CLI task/plan create commands**

Search `packages/cli/src/index.ts` for where `cast task create` and `cast plan create` are implemented. Find how they currently resolve `team_id` -- likely via the API token which maps to `user.active_team_id` on the backend.

- [ ] **Step 2: Add directory-based team resolution**

Before calling the API, the CLI should:
1. Get `cwd` (current working directory)
2. Query `directory_team_mappings` for the user to find a matching path prefix
3. If found and `auto_share: true`, use that mapping's `team_id`
4. If not found, don't set `team_id` (personal workspace)

Check if the API create endpoints already accept a `team_id` arg. If not, add one. The backend should accept an explicit `team_id` from the CLI and skip its own `user.active_team_id` resolution when provided.

- [ ] **Step 3: Add `--team` flag override**

Add `--team <name>` option to task and plan create commands. When provided, look up the team by name and use its ID, overriding directory resolution.

- [ ] **Step 4: Test**

```bash
cd /Users/ashot/src/codecast && cast task create "Test personal task" -t task -p low
# Should be personal (no team mapping for codecast dir)
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): resolve team from directory mappings instead of active_team_id"
```

### Task 16: Handle workspace switch while viewing detail pages

**Files:**
- Modify: `packages/web/app/plans/[id]/page.tsx`
- Modify: `packages/web/app/tasks/[id]/page.tsx`

- [ ] **Step 1: Add workspace change detection**

When workspace changes, check if the current item belongs to the new workspace. If not, redirect to the list page.

```typescript
import { useWorkspaceArgs } from "../../../hooks/useWorkspaceArgs";

const workspaceArgs = useWorkspaceArgs();

useEffect(() => {
  if (workspaceArgs === "skip" || !plan) return;
  const mismatch =
    (workspaceArgs.workspace === "team" && String(plan.team_id) !== String(workspaceArgs.team_id)) ||
    (workspaceArgs.workspace === "personal" && plan.team_id);
  if (mismatch) router.push("/plans");
}, [workspaceArgs, plan]);
```

Same pattern for tasks detail page, redirecting to `/tasks`.

- [ ] **Step 2: Verify**

Open a plan detail page, switch workspaces, verify redirect.

- [ ] **Step 3: Commit**

```bash
git add packages/web/app/plans/[id]/page.tsx packages/web/app/tasks/[id]/page.tsx
git commit -m "feat(web): redirect on workspace switch from detail pages"
```

### Task 17: Final integration test

- [ ] **Step 1: Test full flow in browser**

1. Open `http://local.codecast.sh`
2. Team switcher shows "Personal" at top with separator
3. Select Personal: plans/tasks/docs show only items with no team_id
4. Select a team: plans/tasks/docs show only that team's items
5. Inbox always shows all active sessions with team badges
6. Create a plan in Personal workspace: no team_id set
7. Switch to team, create a plan: has team_id
8. Switch back to Personal: team plan not visible, personal plan visible
9. Refresh page: workspace selection persists
10. View a plan detail, switch workspace: redirects to list

- [ ] **Step 2: Test CLI**

```bash
cd /Users/ashot/src/codecast
cast task create "Personal test task" -t task -p low
# Should be personal (no team mapping)
```

- [ ] **Step 3: Final commit if any fixes needed**
