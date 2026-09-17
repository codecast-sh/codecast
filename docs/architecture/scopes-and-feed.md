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

F4 moved the header and the tabs described here. The page is the role's
conversation; what follows is the panel beside it, and the header is what sits
above both.

- Header: name, handle, trust stage pill, host and model, the state stripe,
  reports to, and the controls that are not a message (Pause, Resume, Retire).
  Talk and Wake are gone: the composer is Talk, and a line sent in it is the
  same pending message a wake enqueues. Today's counters live on the panel's
  tab counts, so the header stays two lines.
- Board line: the brief's first line with the fact counts beside it.
- The panel's tabs: Feed (default; kind filter chips, infinite scroll,
  thumbnails for images and pages), Tasks (the existing task board filtered to
  the scope, reusing the `/tasks` list component with a scope filter), Plans,
  Docs, Sessions (the hands, grouped by who acts next per F4.3), Decisions
  (open and answered, stacks), Brief and Charter, Settings (scope editor with
  project and plan pickers and overlap warnings, trust, caps, model, reports
  to, channels the role follows, retire).
- The root anchor has the same page at `/org/workspace`.
- Phone: header collapses to name and stripe; tabs scroll; the feed is the
  page.

## F4. The scope is a conversation (W3 F4)

Written 2026-09-17, after the founder asked what codecast should take from
Claude's projects becoming conversations. The research is in
`/tmp/projvid/claude-projects-report.md`; what follows is the part of it that
is ours to take, and the part that is not.

What they got right is not the feature list, which we already have. It is that
there is exactly one place to type. A project is a conversation with a
coordinator; every other surface is a panel beside it, and the panel is where
state lives, not where you act. Our scope page is the opposite shape: eleven
tabs, and talking to the role is a Talk button that navigates away. A person
opening `/org/or-7` has to know what a feed, a line, a brief and a charter are
before they can do anything. That is the same complaint the founder made about
the staffing pane, one level up.

So the scope page opens as the role's conversation, with the board beside it.

### F4.1 One composer, one panel

- The scope page's default view is the role's standing conversation, rendered
  inline with `AnchorConversation` (the component the anchor page and the
  proposal thread already use, so this is a mount, not a new view). It is the
  real conversation, so it survives a reload and a person reads and writes
  there exactly as in a session.
- The eleven tabs become one panel on the right, open by default, closed and
  reopened by a control in the header. The panel keeps its tabs; it stops
  being the page. On a narrow window the panel is a sheet the conversation
  hands to and takes back, the way the proposal pane does on the phone.
- The header keeps the face, the name, who the role reports to and the state
  stripe. Talk and Wake leave the header: the composer is Talk, and Wake is
  what sending a line does.
- The panel's dot says a hand under this scope is waiting on a person, which
  is the one thing a closed panel must still tell you.

### F4.2 A message says where it went

The routing is the whole trust mechanism, and it is one line of prose, not a
new surface. When a person writes in a scope, the role either answers there or
starts a hand, and it says which in its own words. A hand it starts renders
under the person's message as a card carrying the session's title and its live
work state, and a follow up the role matched to an existing hand says so on the
person's own message. This is a render of rows we already have (a hand is a
conversation with `org_role_id`; the pill already carries live state), so what
is new is that the role is told to state the routing, and that the person can
correct it in plain words ("answer that here", "put this in the pricing thread",
"ask me before you start one").

As shipped (2026-09-17): the telling is the "When a person writes to you"
section of `bootstrapMessage` (convex/anchors.ts) and rule 5 of the charter
template (`ROLE_RULES`, convex/orgRoles.ts), which rides every restart frame.
The card is derived from rows, never from the prose: `org.handsStartedBy`
reads the hands the standing session spawned (`by_spawned_by`, `org_role_id`
set) with their live state, the view cuts them to the turn's window (this wake
until the next turn boundary) and reads `cast send <id>` targets off the turn's
tool calls (`roleWake.ts` `handsStartedInTurn`, `sentToRef`), and `RoleWakeCard`
renders the strip under the frame. A hand the role claims but never started
renders nothing.

### F4.3 The panel answers who acts next

The Sessions tab lists hands. It should group them the way the inbox groups
sessions, because the question a person has is never "what sessions exist here"
but "what is waiting on me in this area": waiting on you, working, parked,
done. The grouping is `work_state`, which every row already carries, and the
order is the inbox's order. A row shows the hand's title, its one line state,
its task's open and closed subtask counts when it has them, and its age.

### F4.4 The brief is the scope's memory, said in plain words

Their project memory is a list of files a person can read, edit and delete,
written by the assistant as it works, and the gesture is conversational:
remember this, forget that. We have the same thing already and hid it behind a
tab called Brief. Take the gesture, not the store: a person telling a role to
remember a decision in the conversation writes the brief, and the panel's Brief
tab is where they read and correct it. Nothing new is stored.

As shipped (2026-09-17): the bootstrap's memory bullets say what belongs in
the brief (standing facts, decisions with their reason, who to ask, pitfalls,
how the people here want the role to work) and what does not (status, a log,
anything a task or plan holds), and that remember and forget are brief writes
made in the same turn and said in the reply; forgetting removes the line rather
than noting that it was forgotten. The write path is the existing
`cast brief edit -` (orgRoles.performBriefEdit). Dry runs against the old and
new text live in /tmp/scopeconv/dryrun.

### F4.5 What we are not taking

Their project belongs to one person, cannot be shared, runs only in the cloud,
and dies with its threads. Ours is a team's, holds humans in its reporting
structure, and a role outlives the projects in its scope (that is what standing
tenure means). So the conversation is a front door to a scope, never the
boundary of it: the org above it stays, the same scope stays reachable by
every person who can see it, and a hand stays a first class session with its
own page. We do not collapse a scope into one coordinator's thread, and we do
not invent a per project memory separate from the brief.
