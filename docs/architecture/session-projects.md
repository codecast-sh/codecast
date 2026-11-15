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
2. the project of the task it is bound to (`active_task_id`): the task's
   own `project_id`, else the project of the plan the task is filed under
   (`plan_id`); else the project of the plan it is bound to
   (`active_plan_id`);
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
  loads the parent chain, its tasks, and their plans, then applies the rule.
- Web: `workProjectsBySession` (`store/workProjects.ts`) for the inbox chips,
  the project page, the counts and the org lenses.
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
transaction, in the composer's workspace, with the first message as its
description. It is named after the first message at once and takes its main
session's generated title when that lands (`projects.title_from_session`,
cleared by a rename).
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

## SP6. Shared project context

Every session in a project starts out knowing the project. Anything one
session records for all of them reaches every one.

- **Instructions.** `projects.instructions` is free text, capped at
  16,000 UTF-8 bytes (`PROJECT_INSTRUCTIONS_MAX`), counted the way the hook budgets count. It is edited in the About
  view and with `cast project update --instructions <text>` or
  `--instructions-file <path|->`. Sessions get it word for word.
- **Memory is the project's pinned docs.** There is no new table: a pinned
  doc with the project's `project_id` is memory. `cast project remember
  [<project>] "<fact>"` creates one through `docs.create` (`pinned: true`, in
  the project's workspace). With no project named, it uses the calling
  session's derived project. `cast project memory` lists the memory, and
  `cast project forget <doc>` unpins a doc without deleting it. The About
  view lists the memory: each doc opens whole and can be unpinned there. The
  folder-keyed `project_memory` table is a different feature (automatic
  corrections) and is not used here.
- **The block.** `computeProjectContext` (`convex/projectContext.ts`) reads
  the charter's goal and success metrics, the instructions, and the memory
  index (pinned docs the reader may open: the first
  `PROJECT_MEMORY_SHOWN` with a one-line gist, then a count). It also names
  the main session (SP4) and whether the reader is it.
  `projectContextBlock` (`packages/shared/contracts/projectContext.ts`)
  renders all of this once. The block says, as principles, that the memory
  is shared and is added to when every session should know something, and
  that findings which change the project's direction go to the main session.
- **Delivery.** `org.where` carries the context as `project_context`, for
  the session's project by SP1's rule. It
  answers in a workspace with no roles too, as long as the session has a
  project. Because it rides that read, the daemon's per-launch read
  (`prepareLaunchStableContext`) brings it to a brand-new session on its
  first turn: a web composer session born with `project_id`, or a `cast
  spawn` worker inheriting through its parent. `stableContext.ts` prints it
  after the org block. The cache filled for a new session
  (`whereForNewSession`) drops it, because another session's project is not
  this one's. The instructions in the block are cut to fit the hook's
  9,000-byte budget (`fitProjectContextBlock`), and `cast project show` prints
  them whole. After compaction or a resume, the task context hook prints the
  block again from `/cli/projects/context` (`projectContext.forSession`), in
  the room the task block leaves under the same budget, and stable context
  leaves it out so it does not appear twice. `org.where` and `forSession`
  read the project through `projectContext.sessionProject`, which applies
  SP1 and nothing else, so the block, the inbox chips, the project page,
  Outputs and the counts all name the same project for a session.
- **Planning first.** When the project has no goal and the reader is its
  main session, the block says the goal and the success checks are not set.
  It tells the session to work them out with the person before building, and
  to record them with `cast project update`.
- **Working on.** The org block's "Working on" names the derived project, so
  a session that joined a project, or inherited one through its parent,
  shows it.
