# Org roles and the org page

The reporting structure of a workspace: people, the roles they created, the
standing anchors, and every session, drawn as one tree and edited by
reparenting. This document is the contract the backend and the web page are
built against. Sections are numbered so code can cite them.

## S1. What a role is in this slice

A role is a named seat in the reporting structure with a scope. In this slice
a role has no standing session: it is a node that sessions and other roles
report to, and the scope it owns. Standing sessions, wakes, briefs and decision
routing come later and attach to the same row (`anchor_id` is reserved for
that).

Every session already reports to a person through `session_owners`. This slice
adds one optional pointer, `conversations.org_role_id`, meaning "this session
reports to this role". A session with the pointer still has its owners; the
role sits between the session and the person in the tree.

## S2. Table `org_roles`

```
org_roles
  short_id        string            "or-N" from counters.nextShortId
  scope_type      "team" | "user"   ACCESS boundary, exactly as anchors carry it
  team_id?        Id<teams>         set when scope_type = team (routing AND the membership grant)
  scope_user_id?  Id<users>         set when scope_type = user (the personal owner)
  host_user_id    Id<users>         the person who created it and would host its session
  name            string            display, e.g. "Head of Growth"
  handle          string            unique inside the access boundary; [a-z0-9-]{2,32}
  scope           { project_ids: Id<projects>[]; plan_ids: Id<plans>[] }
                                    empty arrays = the whole workspace
  reports_to      { kind: "user"; user_id: Id<users> } | { kind: "role"; role_id: Id<org_roles> }
  status          "active" | "paused" | "retired"
  charter?        string            short free text for now; becomes a doc later
  anchor_id?      Id<anchors>       reserved: the standing session, when one is provisioned
  created_by      Id<users>
  created_at      number
  updated_at      number
indexes
  by_team           [team_id]
  by_scope_user     [scope_user_id]
  by_team_handle    [team_id, handle]
  by_scope_user_handle [scope_user_id, handle]
  by_short_id       [short_id]
```

No `workspace` key. Access is the anchor rule: a personal role is visible to
its owner; a team role is visible to every member of the team; reshaping (rename,
reparent, retire, scope edit) is allowed for the host, the personal owner, or a
team admin. Export `anchorGrants` style helpers as `roleGrants` in
`convex/lib/orgAccess.ts` and use them from both `orgRoles.ts` and the
session reparent path. The change log tracks the table (`makeChangeTrackedDb`
sees it automatically once the table is in the schema); the web feeds from the
`org.tree` query, not from a per row collection.

`conversations.org_role_id?: Id<org_roles>` with index `by_org_role
[org_role_id]`. It is written only by the session reparent core
(`sessionOwnership.performReparentSession`, re-exported from `orgRoles`, the
one place `session_owners` and `org_role_id` change together; org-staffing.md
S11) and by `retire`; it is not in the dispatchable conversation field manifest.

## S3. Query `org.tree`

One query returns the whole tree for the active workspace, sized for the page.

```
org.tree({ team_id?: Id<teams> })   // absent = the caller's personal workspace
→ {
  workspace: { kind: "team" | "user"; id: string; name: string },
  people: OrgPerson[],
  roles:  OrgRole[],
  anchors: OrgAnchor[],
  generated_at: number,
}

OrgPerson = {
  user_id, name, image?, role: "admin" | "member" | "owner", is_me: boolean,
  presence?: "online" | "away" | "offline",
  counts: StateCounts,            // over sessions that report DIRECTLY to this person (no role)
  sessions: OrgSession[],         // top TOP_N of those, ordered needs_input, working, dormant, done, idle, then updated_at desc
  total: number,                  // all direct sessions, for the "+N more" cluster
}
OrgRole = org_roles row + {
  counts: StateCounts, sessions: OrgSession[], total: number,   // sessions whose org_role_id = this role
  standing: OrgStandingState & { conversation_id?, short_id? } | null,   // the role's standing agent, by the anchor naming the role or the role naming the anchor
  scope_names: { projects: {id, title, short_id?}[]; plans: {id, title, short_id}[] },
}
OrgAnchor = OrgStandingState & {
  anchor_id, name, bot_user_id, host_user_id, scope_type, team_id?, scope_user_id?,
  conversation_id?, short_id?, status,
}
OrgStandingState = {           // the standing session's pinned state (cast state), one derivation with a brief's hands
  state?: WorkState,           // observed; absent when the row fell outside the recency window
  state_line: string | null,   // first line of the pinned state, label dropped: what it is working on
  state_status: "working" | "blocked" | "done" | "dormant" | null,   // declared: who acts next. THE NODE'S COLOUR
  state_at: number | null,
}
OrgSession = {
  _id, short_id, title, agent_type, state: WorkState, updated_at,
  owner_user_id?, org_role_id?, subagent_count: number, is_anchor: boolean,
  project_path?, git_branch?,
}
StateCounts = { working, needs_input, done, dormant, idle }
TOP_N = 8
```

Rules:

- Membership: the workspace's conversations with `status = "active"`, not
  killed (`inbox_killed_at` absent), not dismissed, not subagents
  (`isOrphanOrSubagent` false), updated in the last 30 days. Team workspace:
  scan `by_team_user_updated` per member with the cutoff; personal: the
  caller's own rows by `by_user_updated`. Cap total rows read at 3000 and set
  `truncated: true` on the response when the cap hits.
- `work_state` comes from `classifyWorkState` exactly as `scanInboxConversations`
  computes it. Do not write a second classifier: factor the per row input
  builder out of `scanInboxConversations` if it is not already a function, and
  call it.
- `subagent_count`: rows whose `nestParentIdOf` resolves to the session, counted
  in the same scan (subagents are read, counted, and not emitted).
- A session with `org_role_id` set to a role the caller can see is filed under
  that role; otherwise under its primary owner (`owner_user_id`, falling back
  to `user_id`). An anchor's standing session is emitted once under `anchors`,
  never as a person's session.
- People are the team's members (team workspace) or the caller alone (personal).
  A member with no sessions still appears.
- Roles are all non retired `org_roles` visible to the caller in this workspace.

## S4. Query `org.sessionsUnder`

Paged list for the cluster expand and the scope panel.

```
org.sessionsUnder({ parent: { kind: "user"; user_id } | { kind: "role"; role_id },
                    team_id?, cursor?: string, limit?: number })
→ { sessions: OrgSession[]; next_cursor?: string }
```

Same membership and ordering as S3. This is a per view query (plain
`useQueryNoThrow`), not a registry feed.

## S5. Mutations (`convex/orgRoles.ts`)

```
orgRoles.create({ name, handle, team_id?, scope?, reports_to?, charter? })
   scope defaults to empty; reports_to defaults to { kind: "user", user_id: caller }.
   Refuses a duplicate handle in the boundary; refuses reports_to pointing at
   a role in another boundary.
orgRoles.update({ role_id, name?, handle?, scope?, charter?, status? })
orgRoles.reparent({ role_id, reports_to })
   Refuses a cycle (walk up from the target through role parents, max depth 32).
orgRoles.retire({ role_id })
   Sets status retired and clears org_role_id on every session filed under it
   (by_org_role), so those sessions fall back to their owner.
orgRoles.reparentSession({ conversation_id, target, note?, from_session? })
   target: { kind: "user"; user_id } | { kind: "user"; owners: string[]; mode: "set" | "add" | "remove" } | { kind: "role"; role_id }
   user target: the ownership gesture (the same core `cast own`, `cast disown` and
   the owners picker call): the owner rows change, the session reports to the
   person the act named (`add` re-homes under the added person), and org_role_id
   is cleared. A `remove` leaves the reporting line to whoever remains.
   role target: set org_role_id; owners unchanged. The caller must be an owner of
   the conversation (a person target: the ownership rule, any teammate who can
   see it) or able to reshape the target role.
   Every move that changes the reporting line tells the session once
   ("You now report to <name>. <note>", org-staffing.md S11) and returns
   `told: { sessions, roles }`; `orgRoles.reparent` returns the same after
   waking the role.
```

Every mutation takes `api_token?` like the anchor mutations so the CLI can call
it. Each write bumps `updated_at`.

## S6. Client

Registry key `orgTree`: singleton, `hydration: { phase: "deferred", merge: "fill" }`,
feeds `["org.tree"]`, classified `shared`. The feeder is
`hooks/useSyncOrgTree.ts` (mirror `useSyncSessionThreads.ts`). The page reads
the store, never the query.

Actions in the store (`action()`): `reparentOrgSession`, `reparentOrgRole`,
`createOrgRole`, `updateOrgRole`, `retireOrgRole`. Each patches the `orgTree`
singleton optimistically (move the session between `sessions` arrays and adjust
`counts`, or move the role's `reports_to`) and dispatches the mutation.

Route `/org` (`app/org/page.tsx`), components under `components/org/`:

- `OrgGraph.tsx`: React Flow canvas. Node types `person`, `role`, `anchor`,
  `session`, `cluster`. Edge type: smooth step, parent above child.
- `orgLayout.ts`: a tidy tree layout (post order subtree widths, siblings
  spaced, parents centered over children). No new dependency.
- `OrgNodeCards.tsx`: the five cards. Every session card carries the inbox
  work state stripe colour (`THREAD_STATE_STATUS_META` / the inbox bucket
  colours), a subagent count badge, and the agent icon. A cluster card shows
  "+N sessions" with a five number state tally and expands in place.
- `OrgScopePanel.tsx`: the right panel for the selected node. Role: scope
  projects and plans (chips, editable), sessions under it, tasks in scope from
  the `tasks` store filtered by `project_id`/`plan_id`, docs in scope from
  `docs`, all sorted by `updated_at` into one feed. Person: counts and
  sessions. Session: title, state, agent, open link, and its parent.
- Reparenting: drag a session or role card and drop it on a person or role;
  `getIntersectingNodes` finds the target on `onNodeDragStop`; a confirm
  popover names the move; the store action runs. The same move is available
  from a context menu ("Move to…", a picker over people and roles) using
  `SessionMenuItems` where a session is the subject.
- Collapse: every person and role node has a collapse toggle; the default view
  shows people expanded with their top sessions and clusters, roles expanded.
- Palette: `/org` entry. Sidebar: entry next to Team.

## S7. CLI (optional in this slice)

`cast org ls|show <or-id>|create <name> --handle <h> [--project <ref>]...
[--reports-to @handle|user]|reparent <or-id|session> --to <target>|retire`.
Routes under `/cli/org/*` map one to one onto S5.
