# The task graph: blockers, waits, links and readiness

Tasks already carry `blocked_by`/`blocks`. This makes the graph decide what
can be worked next: one definition of "ready", blockers that wait on the
world outside the graph (a PR, CI, a decision, a time), links that record how
work relates without blocking it, and plans that write their own order.

The test for every piece: an agent asking "what can I start?" gets a short,
true answer, and a person looking at a task can see why it is not moving.

## TG1. One readiness function

`packages/shared/tasks/graph.ts` owns the definition. Convex (`tasks.list`,
`tasks.webList`, `tasks.getReadyTasks`), the CLI (`planReadiness.ts`) and the
web all call it; none keeps its own copy.

A task is **unblocked** when every task in `blocked_by` is done or dropped
and every wait in `waits` is met. A task is **ready** when it is unblocked,
its status is `open`, its triage status is active (or unset), it is not
superseded, and its parent is not being worked (`in_progress`/`in_review`)
unless the caller asks for subtasks.

The function is pure. It takes the task and a `statusOf(shortId)` lookup, so
a blocker outside the current page (another project, filtered out, already
done) is resolved by the caller from the database, never inferred from its
absence. A blocker id that resolves to nothing does not block; it is reported
as `missing` so the UI can offer to remove it. A lookup answers `null` for
"looked up, not found" and `undefined` for "not looked up"; the second blocks
(status `unknown`), so a page that left a blocker out degrades to blocked,
never to ready. A caller holding a page takes `{shortIds, ids} =
blockerRefs(page)`, fetches `shortIds` through the short id index and `ids`
(older plan rows name blockers by `_id`) by `_id`, and builds
`statusLookup([...page, ...fetched], searched)` where `searched` holds only
the refs it really looked up. The parent rule follows the same convention:
`parentStatusOf` answers `null` for a parent looked up and gone (an orphan,
ready) and `undefined` for one not looked up (not ready, `parent_unknown`).
On the server both are read by `graphOutside` (`lib/taskGraph.ts`), which
keeps a row only when it is in the referencing task's workspace: a ref into
another workspace stays unknown and blocks, so readiness never reveals
whether a task the caller cannot read has finished. `plans.get` returns
those rows for its tasks as `graph_outside`, which `planReadiness` takes, and
`tasks.list` attaches `ready` and `open_blockers` to every row (none on a
closed one, which waits on nothing), so the CLI's blocked tags and counts
never read the raw `blocked_by`.

`blockersHoldingBack(task, statusOf)` returns what holds the task back as
typed entries (`{kind: "task", ref}` or the wait itself). Readiness, the
CLI's "blocked by" lines, the row tooltip and the task page all render from
that one list; `blockerEntriesOf` is the whole Blocked by, cleared and
missing entries included, for a surface that lists history. A plan's tasks
are judged together by `planVerdicts` (`shared/tasks/planVerdicts.ts`),
which the CLI's plan commands and the plan's fenced task list share.

"Ready" in the CLI matches `cast task ready`. The web says **unblocked**,
because `readiness` already names the line's grounding verdict (LE5).

## TG2. Waits: blockers outside the graph

A wait is a blocker on something that is not a task. Kinds:

| kind | met when | fails when |
|---|---|---|
| `pr_merged` | the PR merges | the PR closes without merging |
| `pr_checks_green` | the PR's `checks_state` becomes `success` | the PR merges or closes before its checks go green; red checks on an open PR stay waiting (the chip shows red) |
| `decision` | the `sd-N` decision is answered | it is dismissed or withdrawn |
| `time` | the clock passes `at` | never |

Waits live on the task row (`tasks.waits`), so they sync to every client with
the row and have exactly one home. Each entry: `id` (stable within the task),
`kind`, its target (`repository` + `pr_number`, `decision`, or `at`),
`state` (`waiting | met | failed`), `created_at`, `created_by`, `settled_at`,
and a short `note` written when it settles ("merged", "answered: Ship it",
"closed without merging"). `created_in` is the conversation `_id` of the
session that set the wait while holding another task (its own session, not
one it can merely read): that session parks on the wait and is woken by it.
A session holding this task, one holding no task (wiring the graph), one
reviewing the task it holds, and a task's create leave it unset. A session that adds a wait already set becomes
its setter when the wait has no setter yet and can still wake it: it is
waiting, or it is met, not yet told, and the task is still blocked. The add
answers `parked` when the caller is the setter of a wait that can still wake it,
and then adds the task to the caller's `conversations.parked_on_task_ids`
(newest last, at most ten), so while any wait on a listed task still owes it
a wake the session carries `parked_wake_kind` "wait", which files it Dormant
under a dormant pin or claim. A setter whose held task lists the task in
`blocked_by` gets `parked: "close"` and `owns` (whether it is that task's
owning session, which its unblocking wakes). A caller that is not the setter
(it joins a wait another session set) but whose held task lists the task gets
`parked: "held"`: its own blocker stamp parks it, and the wait tells it
nothing. The recompute
drops a task from the list once nothing there is owed. A "wait" stamp, which
rests on a webhook or a job that can be lost, files Dormant for 72 hours of
quiet at most; a "blocker" stamp (an open task in the held task's
`blocked_by` that a live session holds) is recomputed on every task write, so
it has no such limit. An open blocker task nobody holds is closed only by a
person or a webhook that can be lost, so it stamps "wait", with the 72 hours
(a later binding of it does not restamp, which errs toward surfacing; a
holder that leaves it, is killed or turns to review it restamps the dependents stamped
"blocker", so none stays exact once its blocker task is unheld). `setter_told_at` marks that the met wait's setter was
dealt with: told, or passed over (killed, refusing messages, a done pin that
answers its latest turn,
or the owner, who heard another way). A met or failed wait stays on the row as history
until someone removes it; a failed wait keeps blocking. Adding a wait on the
target of a failed one replaces it, so a PR reopened after it closed is
waited on again by adding it again.

`waiting_since` (indexed, sparse) is set while any wait is `waiting` and
cleared otherwise. It is never written directly: every change to `waits`
goes through one helper (`writeWaits` in `convex/lib/waitWrite.ts`) that
recomputes it and links each new wait from its target: the PR row's or the
decision row's `waiting_task_ids`. Events find their tasks through that back
reference, so an event reads only its own tasks, never a scan.

### Settling

- PRs: `patchPullRequest` (`prShepherd.ts`) is the one writer of a PR row,
  reached by webhooks and by the refresh and reconcile paths alike. When a
  PR with waiting tasks changes `state` or `checks_state`, it schedules
  `taskWaits.settlePr`, so a failure there never rolls back the webhook. The
  job reads the PR as it stands and settles each wait on it by the table
  above, so a missed or repeated event settles the same way, and prunes the
  back reference to the tasks still waiting. A wait matches on the normalized
  repository and number, and only for a task routed to the PR's team or
  owned by one of its members.
- Decisions: `settleResolution` (`sessionDecisions.ts`) schedules
  `taskWaits.settleDecision` when the decision has waiting tasks, as does the
  org proposals' card withdraw, so a failure there never rolls back the
  answer. The job reads the decision as it stands (one reopened since settles
  nothing) and carries who resolved it, so a person answering or a session
  withdrawing is not told of their own act. Purging a session fails the waits
  on its open decisions in the purge itself, since the row goes with it. The
  note carries the answer ("answered: Ship it") only when
  everyone who can read the task can read the decision; otherwise it says
  "answered", because the note reaches the task's history, its comment, the
  owner's wake and the bell. `reopenCore` puts a met decision wait back to
  `waiting`, notes it on the task and wakes the owner.
- Time: creating a `time` wait schedules one `runAt` job. The job re-reads
  the task and settles the wait only if it still exists and is still
  waiting, so removing a wait needs no cancellation.
- Creating a wait checks the target first: a PR already merged or a decision
  already answered is met at once (and says so). A PR codecast cannot see
  (no app installation, not in `pull_requests`) is refused with the reason;
  a wait that can never settle is a trap.

### When a task unblocks

The moment a task's last blocker clears (a wait settles or is removed, an
edge is removed by `removeDep` or an `update` that overwrites `blocked_by` or
`blocks`, or a task in its `blocked_by` closes, via `afterStatusMove`, a
cascade close, an org proposal's close or an issue sync's close),
`onUnblocked` runs once:

1. a system comment on the task: "Unblocked: PR #42 merged".
2. If a session owns the task (`conversations.active_task_id`), that session
   gets a message saying what cleared and that the task is ready. This is how
   an agent parks: it sets a wait on its own task and ends its turn.
3. Every met wait on the row with a `created_in` and no `setter_told_at`
   wakes that session, one message per session naming its waits, and is then
   stamped, whether or not the wake reached it. A wait met while something
   else still blocked the task is told here, by whichever change cleared the
   last blocker, and a stamped wait wakes nobody at a later unblock. The
   owner is not told twice, and a killed session or one whose done pin
   answers its latest turn is not woken (a done pin older than that turn
   answered an earlier one, so that session is woken). A wait met the moment its own setter sets it is
   stamped then. A setter whose own held task still lists this task in
   `blocked_by` is told what still holds that task, since nothing may close
   it (a PR merged outside a flow closes none): with an owning session, ask it
   to close the task when its work is done (that owner is told to continue at
   the same moment) and pin dormant; with none, close a finished task itself,
   or pin blocked so a person moves it. Its held task unblocking wakes it as
   that task's owner. A setter whose held task is held back by anything else
   (another open task, a waiting wait) is told what it still waits for, and to
   pin dormant naming it, rather than to continue. Either way it is promised
   the held task's wake only when it owns that task; otherwise the text says
   the session holding it is woken.
4. Unless the owner was woken, a `task_unblocked` notification to the
   assignee when the assignee is a person. A setter's wake does not count:
   the setter continues its own work, not this task.

A closing task finds its dependents as supersede does (`dependentRefs`): its
`blocks` mirror, then any plan mate whose `blocked_by` names it, so a row
written without the mirror is still told.

A change someone made themselves neither rings their bell nor wakes the
session that made it. The wake is keyed on what cleared the task, so the
same event is delivered once.

A failed wait posts a `blocker` comment instead and wakes the owner and its
setter the same way, because someone has to re-plan: the owner is told how to
remove or replace the wait, and the setter to replan its own work and leave
the task's blockers to its owner, or, with no owning session, that nobody else
will replan it (when its held task still waits on this one closing: to replan
with this task's owning session or drop the dependency, and with no owning
session, to close a finished task or pin blocked; and when anything else holds
its held task back, what that is, beside the replan and with no order to pin
dormant). Setters of the task's met waits are not
told: the task may still unblock once the owner replaces the failed wait, and
the "wait" stamp's 72 hours bound one that never does. A task closed while a
wait on it is still owed to its setter tells that setter once that the wait
will not wake it (closed as done: check whether its work can go ahead;
otherwise: replan), unless the setter closed it, and stamps the wait. A
setter whose own held task still lists the task in `blocked_by` is passed
over on a close: when nothing else blocks its held task, the close releases
that task and wakes it as the owner in the same call, and otherwise it is
woken when the held task's last blocker clears; a removal tells it the wait is
gone and that the held task still waits for this one to close: with an owning
session, it pins dormant naming the task and ends its turn; with none, it
closes a finished task or pins blocked. Removing a wait whose setter
was still owed (waiting, or met and not stamped) tells that setter the wait
is gone, unblocked or not, unless the setter removed it, or owns the task and
heard of the unblock. A setter told both of a removal and of the unblock it
caused gets one message, and a setter of several waits that fail together
gets one message. Re-adding a met checks
wait keeps the replaced wait's setter when it was still owed, whoever
re-adds it (a failed wait's setter was already told to re-plan, so it is not
carried); the caller becomes the setter only when there is none. A reopened or restated decision wakes only the
task's owner, never a wait's setter.

## TG3. One grammar for blocker refs

`parseBlockerRef` in `packages/shared/tasks/graph.ts`, used by the CLI flags,
the web's add-blocker palette and the server:

| input | means |
|---|---|
| `ct-123` | task blocker (`blocked_by`) |
| `#42`, `owner/repo#42`, a PR URL | `pr_merged` |
| the same with `:checks` (alias `:ci`) | `pr_checks_green` |
| `sd-412` | `decision` |
| `30m`, `2h`, `3d`, an ISO date or datetime | `time` |

A bare `#42` resolves its repository from the task's project, then the
caller's git remote (CLI), and fails with the candidates when ambiguous.

A date or a datetime without a zone is wall time in the `timeZone` passed to
the parser. Convex runs in UTC, so a server parse takes the person's zone
from the client; otherwise "09:00" lands hours off. `ct-0`, `sd-0` and `#0`
are refused. A past time is refused too, except when removing: a met time
wait stays as history, so it can be removed by the time it names.

Every `blocked_by` and `blocks` a write stores goes through the same grammar
(`storedGraphRefs` in `lib/taskGraph.ts`, used by `create`, `update` and a
plan fork), because a ref that names no task reads as missing and blocks
nothing: a task ref is stored as its canonical short id (`CT-012` is
`ct-12`), a tasks `_id` as is, and anything else is refused, except that
`create` turns a wait-shaped `blocked_by` ref into a wait, as an older CLI
still sends one.

## TG4. Edges that cannot loop

`addDep`, `create` with `blocked_by`, and `update` with `blocked_by` reject
an edge that closes a loop. The error names the path in waits-on order and
says which way an edge points, since the usual cause is one named backwards:
"ct-9 already waits on ct-5 (ct-9 → ct-7 → ct-5, each waiting on the next);
this edge would close a loop. Blocked by names what a task needs: if ct-9
needs ct-5, that edge already exists." The check is
`dependencyLoopChecker` in `graph.ts`, run by `assertDependencyEdges`
(`lib/taskGraph.ts`) over the workspace's open edges, and by the web palette
over the store's. Topological order (`getDependencyChain`, the plan graph) is
`graph.ts` `topologicalOrder` / `topoLayers` over the same edges. A short id
and the `_id` an older plan row names a task by are one edge: an add never
stores the second form, a remove takes both, and an update that swaps one
form for the other changes no mirror.

An edge joins two tasks of one workspace, and so does a parent link: a
reparent checks the parent against the child's access key, never its routing
team. When a task's key moves (a conversation's visibility,
`recomputeWorkspaceForConversation`, or the `teamScopeSweep` reconciler),
`taskLinks.cutCrossedEdges` removes every edge that now crosses, with the
dependent's history and a note, and tells a dependent the cut releases; a
subtask whose parent now sits elsewhere returns to the top level the same
way. Readiness cannot read across, so the link would hold it forever. For
the same reason readiness judges each ref against the workspace of the task
naming it, even when a mixed page (the web's team view) holds the row.

## TG5. Links that do not block

- `found_during` (task short id, indexed): the task this one was found while
  working on. The server fills it on create when the creating session is
  bound to a task and the new task is not that task's own subtask or plan
  step; `--found-during` sets it explicitly and `--found-during none` skips
  it. The task page shows "Found during ct-12", and the source task lists
  what was found while working on it.
- `superseded_by` (task short id): this task was replaced. Superseding drops
  the old task with a note and **moves its dependents**: anything blocked by
  the old task becomes blocked by the replacement, because a dropped blocker
  would otherwise silently release them. Marking a duplicate does the same
  through the same helper (`redirectDependents`), and so does dropping a
  task that carries `duplicate_of`, by any path, so a dependent added after
  the mark or given back by a reopen still moves to the canonical.
- `related` (task short ids, mirrored on both sides like `blocks`): see-also.

## TG6. Plans that write their own order

`cast plan create --steps -` and `cast plan steps <plan> -` read steps from
stdin, one per line. Lines separated by a blank line form waves: steps in a
wave are independent, and every step in a wave waits on every step of the
wave before it. `cast plan steps` appends after the plan's current last wave.

```
Design the schema

Build the API
Build the UI

Review in the real app
```

The plan guidance in `snippets.ts` and the `cast-plan` skill teach this form
and the one rule agents get backwards: say what a step *needs* ("Review needs
Build"), never what comes first.

`cast plan template save <plan>` stores a plan's steps and edges as a
`plan_templates` row, so a plan worth repeating can be instantiated again.

## TG7. Claiming the frontier

`cast task ready --claim` picks the highest-priority ready task matching the
filters and claims it for the calling session in one mutation (status
`in_progress`, ownership, pulse), so two agents pulling from the same queue
never take the same task. The frontier is read first, outside the claim's
transaction; the mutation re-reads only the candidate rows (with their
blockers and parents), re-checks them and starts the first that passes, so
an unrelated task write never invalidates a claim and two racing claims
still conflict on the same row.

A claim picks the task for the caller, so it takes only what is already
theirs to pick up: unassigned work, or work assigned to the caller or the
role its session works for. A blocking decision holds a task against a
person's claim as well as a session's (a person moves past a hold only by
starting the task by name), an ephemeral task is claimed only by the session
that filed it, and a stale task only with `--stale`. The pulse and the plan
binding are written whatever the output mode, `--json` included.

`cast task ready` sorts by priority, then plan order, and folds tasks nobody
has touched in 30 days into a count (`--stale` lists them), so the frontier
reads as the work that is live.

## TG8. Execution hints

Tasks keep `model` and gain `effort` (`low | medium | high | xhigh | max`).
`cast task create/update --model --effort` set them. A model and effort are
fixed at launch, so every spawn for a task reads them: `cast plan orchestrate`
and `autopilot` through `resolveTaskModel`, and the server's
`spawnSessionForTask` (`cast task start --spawn`, the board's assign to agent,
issue sync) on the start it queues for the daemon. `--spawn` also takes
`--isolated`, `--worktree <name>`, `--device <name>` and `--as <definition>`,
sent only when given (issue-sync.md S7.2).

## TG9. Short-lived tasks

`ephemeral: true` marks operational bookkeeping with no value once done (a
routine's checklist, a probe). Ephemeral tasks work like any task but stay
out of the board's default views, the feed and notifications, and leave the
ready frontier of everyone but their owner: the session that filed one, else
the person who did (`ownsEphemeral`, which readiness and the claim share;
every session runs under its person's token, so the user alone would hand one
session's checklist to the whole fleet). `cast task create --ephemeral`
sets it; `cast task keep <id>` clears it. Nothing is deleted.

## TG10. Context survives compaction

A SessionStart job, independent of stable mode, reads the hook input's
`source`. On `compact` and `resume`, if the session is bound to a task (task
pulse), it prints a compact block: the task, its status, its open blockers
and waits, the last progress comment, and the plan. Startup sessions are
left alone; the bound task is already in front of them.

## TG11. A history that covers the graph

Every change to `blocked_by`, `waits`, `found_during`, `superseded_by`,
`related` and `labels` writes `task_history`, through one helper
(`recordTaskChange`) that the existing status/priority/title/assignee writes
also use. Edge and mirror writes go through `writeEdges` (`lib/taskGraph.ts`)
and wait writes through `writeWaits`, which both call it; `tasks.update`
records a `blocked_by` overwrite with the other fields it patches. History stores a wait
being set as "Waiting on PR #42"; the task timeline renders each change as
a clause after who made it (`graphChange` in `@codecast/shared/tasks`):
"made it wait on PR #42", "found it while working on ct-12". A met wait that
unblocks the task posts the comment "Unblocked: PR #42 merged". Stored text about a time wait (the
history line, the "Unblocked" comment) is written with `absolute: true`,
"Oct 14, 2026 09:00 UTC", because Convex has no viewer zone and the text is
read later; relative words ("Thu 09:00") are only for live rendering.

## TG12. Surfaces

- **Task page.** One editable "Blocked by" row lists task blockers and waits
  together, each with its live pill (`EntityIdPill`, `PrStatusChip`, a time
  pill), its state, and a remove control; "Add blocker…" opens the palette,
  which accepts task search and any TG3 ref. "Blocks", "Found during",
  "Found here" and "Related" sit beside it. A superseded task shows the
  replacement at the top.
- **Task rows.** A blocked task shows one glyph distinct from the session
  count, with a tooltip that names what it waits on.
- **Tasks board.** An "Unblocked" view next to Active.
- **Plan graph.** Waits appear as small nodes feeding their task; colors use
  sol tokens.
- **Mobile.** The task screen lists blockers and waits, read-only.
- **CLI.** `cast task show` and `context` print blockers, waits and links in
  the same order as the web.
