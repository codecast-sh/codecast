# Sessions in projects

A project is a workspace for the work in it: its tasks, plans and docs, and the
sessions doing that work. This page covers how a session comes to be in a
project. Plan pl-994 builds the rest on it: a project's default session, the
inbox filter, and the project page that shows everything running in it.

## SP1. One stored fact, the rest derived

`conversations.project_id` holds a project only where a person or the project
itself decided it: the composer's pick, a move (`cast project join`, the
web's move), a project's default session. Nothing copies it onto another row.

Every reader derives a session's project with one rule,
`sessionProjectId` in `packages/shared/contracts/sessionProject.ts`:

1. the session's own `project_id`;
2. the project of the task (`active_task_id`), else the plan
   (`active_plan_id`), it is bound to;
3. its parent's project, by the same rule: `parent_conversation_id` (a worker,
   a fork), else `spawned_by_conversation_id` (any `cast spawn`).

So a project's workers, and their workers, belong to it without a write, and
follow it when the session at the top moves. A worker bound to a task in
another project works in that task's project. A parent missing from the
reader's data, or a cycle, gives no answer rather than a guess.

The parent link is broader than nesting (`nestParentIdOf`): a plain spawn and
a fork never nest under their starter in the inbox, but both continue its work.

## SP2. The folder decides nothing

A project is a stream of work, not a checkout. Several projects share one
repository, and one project reaches several, so a session's folder never puts
it in a project (the same rule the scope feed follows, scopes-and-feed.md F1).
Folder chips and project chips stay separate filters in the inbox.

## SP3. Readers

- Server: `effectiveSessionProjectId(ctx, conv)` (`convex/sessionProjects.ts`)
  loads the parent chain and its tasks and plans, then applies the rule.
- Scope feed: `sessionsInScope` (`convex/org.ts`) counts a session in scope
  when its project is a scope project, over the org scan, so a parent costs no
  read.
- The one write: `sessionProjects.setSessionProject({ session, project_id })`,
  any session reference, `null` to take it out. The caller must be able to
  open the session and read the project.

## SP4. A project's default session

A project's default session is its seated lead's standing session, else its
canonical session (`projects.default_session_id`): the first session its own
composer started (`createSession` with `project_id` and `project_default`),
or the session the new-session composer's "new project" switch started:
`createSession` with `new_project` makes the project in the session's own
transaction, named after the first message, in the composer's workspace.
A session born in a team project routes to that team when its folder names
none; who may read it still follows the folder. Hiring a lead whose scope
holds exactly one project with a canonical session adopts that session as
the seat (`projectSessionToSeat` in `convex/orgRoles.ts`), falling back to a
fresh seat when it cannot be adopted.

## SP5. The project page and the inbox filter

The project page opens on its default session, whole, with its own header
(`components/projects/ProjectSession.tsx`), or the composer that starts it.
Every other session in the project is the inbox beside the page: the Inbox
toggle in the project header (`ProjectInboxFilter`) presses the project's
chip there, so the page never lists the sessions a second time. The other
views (Tasks, Timeline, About, Flow, Expectations) sit in one menu in the
header. In the inbox a project is a chip on the folder chip axis under the
key `pj:<id>` (`store/workProjects.ts`): folder and project chips stay
separate, and share include, exclude, shift-add and history.
