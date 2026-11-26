# Session owners

A session belongs to its owners. A person's inbox is exactly the sessions they
own, and a wait goes to whoever owns it: an agent owner answers it, and people
hear it only when it reaches them. The model is a team feature, so a team
without it runs exactly as main.

## Who owns a session

A session's owners are:

- **people**: its `session_owners` rows, in the order they were added. An
  agent account is never one.
- **one role**: `conversations.org_role_id`.
- **its parent session**, until released: the session it is nested under as
  a worker (`parent_conversation_id`): a Claude Code subagent, a
  `cast spawn --subagent` worker, a workflow station, a Ship session, a hand a
  role started, or a session a person dropped it onto in the sidebar
  (`adopt_parent`). A person's release, or a takeover, writes
  `parent_released_at`. A killed or deleted parent counts as released.
- **its implicit starter**: the human who started it (its author, else its
  runner, never an agent account), only while it has no people, no role and
  no parent, and never when a role started it (`role_started`).

A session another one only spawned (`spawned_by_conversation_id` alone: a
plain `cast spawn`, an agent-team teammate) is that session's peer. The
spawner never owns it, and nothing draws it as a child: no Parent link (off
the model the link stays), no row in the spawner's agents band. Its starter
owns it like any session they start, so one marker decides both nesting and
ownership.

A peer a bot-run session spawned has no human of its own, so it takes its
spawner's owners (`ownPeerByItsSpawnersHuman`, at spawn and at an agent-team
link): the spawner's people get owner rows, or, when a role alone owns the
spawner, the peer is that role's start (same team only). A spawner that is
itself a worker passes on its parent's owners, up the chain.

The agent owner is the role, else the parent session. Taking a session over
removes every agent owner and makes the taker an owner.

An adopt (a card dropped on the middle of another row in the inbox sidebar,
`lib/adoptDrop`) makes the target the session's agent owner: it nests the
session under the target, clears any release, takes its role off and takes
the dropper's own owner row off; other people's rows stay. It never sets
`is_subagent`, but the session is now the target's worker, so it goes down
with the target's kill or dismiss. It still runs its own process, so the
adopt stamps `adopted_at` (a detach clears it) and `isSubagentConversation`
reads it: a usage-limit revive, auto-recovery and the blocked push treat it as
a top-level session, and the waiting chime stays silent for it. The session is told whom it reports to, and
a wait standing on it is handed to the target (`rehandWait`) without ringing
its people again.

It is refused when:

- the target is the session itself, or nested under it (the parent chain,
  followed up to 50 links);
- the target is closed, killed, deleted, off the model, or unreadable to the
  dropper;
- the dropper neither owns nor runs the session, or neither owns nor runs the
  target;
- the target's runner cannot open the session;
- the session is a role's standing session;
- the session is nested by how it was started: a subagent (Task or
  `--subagent`), a workflow station, or a plan handoff. A detach refuses the
  same.

Undo puts the session back under its previous parent when that parent was
live, unreleased and one the dropper may hand work to; under a released or dead
parent, or none, it detaches it. It restores the old role and the dropper's
row, adding them back first when they do not run the session. When the old
parent is someone else's, or it had both a role and a parent, no undo is
offered.

A role becomes an owner only by a deliberate filing (the owners menu, a drag
onto the role on the org chart, a scope takeover) or by starting the session.
A task binding never files a session no role started (`applyHoldChange`), so
`cast task start` leaves a person's session theirs.

The rules live in one pure module, `packages/shared/contracts/sessionOwners.ts`:
`ownersOf`, `agentOwnerOf`, `waitAudience`, `mayEditOwners` and
`applyOwnersChangeTo` with its refusals. The convex writes
(`sessionOwnership.applyOwnersChange`), the inbox scan, the needs-input push
and the web store all call it, so a client paints a change the way the server
applies it. A restored owner row (the undo of a remove) is held to the add
rules, and its `added_by` is whoever restores it.

## The flag

The feature is `session_owners`. It is read from the session's own team,
never the viewer's. A personal session (no team) is under the model when the
account that runs it belongs to any team with the flag
(`ownersModelOn` in shared `sessionOwners`; convex `ownersModelOn`, memoized
per team or runner for one call by `lib/inboxOwners.ownersModelOnMemo`).

With the flag off, every path is main's: the row shape, membership,
placement, the needs-input push and the dedupe key. The server stamps
`owners_model: true` only on a row the model applies to, and every reader
branches on `underOwnersModel(row)` (`=== true`), so a missing field reads as
off.

## Inbox membership

`isInboxMember(row, viewer)` (shared `inboxProjection`): the viewer holds an
owner row (`owned_by_me`), or is its `implicit_owner`, or its current wait
escalated to them (`wait_up_person`, and no message since:
`waitReachedPeople`). The server scan drops every candidate that fails it,
whoever runs it, and the client's `isForeignRow` applies the same function to
the same fields: the row decides. A client's owners change paints those
stamps (and `org_role_id`, `owner_session_id`) on the row under field locks,
which the change's acknowledgement settles (web `settleOwnersAck`).

A member takes a seat in the selection (`selectWorkingSet`, shared with the
client; `inWorkingSet` takes the viewer). Under the model, beside the usual
windows:

| Window | Seat | Server read | Sort | Cap |
|---|---|---|---|---|
| owned | an owner row (`owned_by_me`) | the viewer's newest owner rows | owner rows | 200 |
| nested | a subagent the viewer runs, released, owned as its implicit starter (`nestedSeat`) | `by_user_subagent_released` | `parent_released_at` desc | 25 |
| escalated | a current wait that reached the viewer, within 30 days (`escalatedSeat`) | `by_wait_up_person` | `wait_up_at` desc | 200 |

Each window reads only rows that are the viewer's, so a cap counts members,
and an overflow names the window in `truncated`. A subagent never takes a
recent seat. A row only the escalated window seats costs the scan no reads:
it skips the children scan and the liveness read, because a current
escalation waits on a person by definition.

A listed session's children that it still owns (no role, not released) come
with it as child rows stamped `owner_session_id` and `owned_by_me: false`, at
no extra read. They are members of nobody's inbox: the client drops them from
the viewer's scope and nests them under that session's card only
(`ownedChildrenOf` in web `store/inboxStore.ts`), where the card's subagent
line and rows draw them.

The scan and `getInboxSessionsByIds` admit an escalated row only through
`checkConversationAccess` (`privacy.conversationAccessMemo` for the scan, the
same answer with the team grant memoized). So a row that only fell past the
window's cap keeps its claim on the client.

### Row fields

A row under the model carries these fields. A row off the model carries none
of them (`INBOX_MODEL_ONLY_ROW_FIELDS`), so its shape is main's, and sync-log
cargo never lands them on such a row (`web/lib/syncLogCargo`):

| Field | Meaning |
|---|---|
| `owners_model` | the marker |
| `implicit_owner` | the implicit starter |
| `owner_session_id` | the parent session that owns it, null once released |
| `role_started` | a role started it |
| `owners_changed_at` | the last owner write (a refetch trigger) |
| `parent_released_at` | when it was released from its parent |
| `wait_up_at`, `wait_up_count`, `wait_up_person` | the current escalation: when, the message count it covers, and the person no owner row names |
| `needs_input_notified_key` | the waiting episode its people were covered for, `"<message_count>:<kind>"` |

`owned_by_me` is a viewer stamp, as on main. A row names no owner list: who
owns it is the owners read (below).

## Who hears a wait

`waitAudience` is the single rule for the push and the inbox.

1. **An agent owner that can hear it answers it, and nobody is rung.**
   - A role hears through its route up (`agentTasks.routeUpWaitingSession`).
   - A parent session is told directly: a frame is queued as its next turn
     (`lib/agentOwnerWaits.routeWaitToAgentOwner`), once per ask
     (`hand_wake_notified_key`).
   - The row files under Working, "With <owner>" (`agentAnswersRow`).
   - A session waiting on its own open decision tells no agent: a decision
     goes to people.
2. **Otherwise the wait escalates** (`lib/inboxOwners.escalateWait`). This
   happens when the agent cannot be reached (a killed, closed or away parent,
   or a role with no listener), or when it passes the wait up (`cast own <s>
   --pass-up`, from its own session or by a person owner). The row is stamped
   `wait_up_at`, `wait_up_count` and `wait_up_person`. The next message ends
   the escalation and clears the stamps.
3. **The people**, in order:
   1. the person owners;
   2. else the implicit starter;
   3. else the human who started it (unless a role started it);
   4. else the fallback person: where its role's line ends, then a workspace
      admin, then the person who runs it.

   `wait_up_person` is the one of these that no owner row names.
4. **Never someone who cannot open the session.**
   - Agent accounts, people who left its team, and anyone `checkConversationAccess`
     denies are excluded. An escalation grants no access.
   - When a stamped person loses access, `rerouteEscalatedWait` hands the wait
     on and schedules the check that rings the new person. It runs on a
     conversation visibility change (`patchConversationVisibility`), on a
     member's visibility change (`teams.applyMembershipVisibilityChange`, paged
     through `notifications.rerouteMemberEscalations`), on a leave
     (`handOnEscalatedWaits`), and as the needs-input check's first step.
5. **A child no window seats** escalates its waits so the escalated window
   lists it (`unseatedChild`): a dead parent's, until its release is written,
   and a released subagent its runner did not start.

### The episode key

Under the model, `needs_input_notified_key` means "this episode's people were
covered":

- The needs-input check stamps it before delivering, once past the agent's
  stand-down, whatever the person's notification settings.
- The daemon's own push (`createSessionNotification`, `performDaemonSessionPush`)
  stamps it only when it delivered to someone. A push an agent owner answered
  stamps nothing.
- The key alone decides whether the check stands down (`dup`). The
  daemon-permission stand-down applies only off the model.
- A reroute clears it, because the person it named was rung and the new one
  was not.

So every escalation rings its person exactly once, whichever way it came.
`escalatedAsks(row)` reads the key's kind, so an escalated permission prompt
or open question files under Questions without any liveness.

## A dead parent

A killed or deleted parent counts as released. Its children fall back to their
people and their implicit starter.

`notifications.releaseDeadParentChildren` is a scheduled job, paged 50 children
a call over the sessions nested under the parent, that runs 60 s after
the death so the kill cascade finishes first. It writes `parent_released_at`
on each child under the model that is active with a live process or a
standing wait, and runs the needs-input check again for each child with a
standing wait. Finished and idle children stay unreleased and in nobody's
inbox.

These schedule the job:

- a root kill;
- a cascaded child with children of its own;
- the delete paths: `deleteConversationBySessionIdCore`, `deleteByProjectHash`
  and the path delete.

## The owners read and the web store

`sessionOwnership.listOwners` reads one session's owners, and
`listOwnersFor({ conversation_ids })` reads up to 60 sessions at once. An id
the caller cannot read is dropped.

On web, the one home of who owns a session is the `sessionOwners` collection
(`store/sessionOwnersSlice`), one row per conversation:

| Field | Role |
|---|---|
| `people_ids` | the fact a change paints |
| `role`, `parent_session` | the facts a change paints |
| `people_info` | detail, keyed by id, never enumerated |
| `implicit_starter`, `starter_id`, `role_started`, `can_edit`, `owners_changed_at` | detail |

Two feeders fill it:

- `useSyncSessionOwners`, the open conversation's read;
- `useSyncVisibleSessionOwners`, the cards in the viewport.

The card feeder settles the visible ids for 400 ms, splits them into chunks
of 5 with fixed membership (`lib/ownerChunks`), and subscribes one
`listOwnersFor` per chunk, so a scroll re-reads only the chunks it changed.
`applySessionOwners` paints an owner change on the press and rides dispatch
to `applyOwnersChange`.

## Read budget

The inbox scan stays under half of Convex's 4,096 db calls on an account with
every window full. The flag-on case adds 100 pending decisions, 26 released
subagents and 201 standing escalations.

| Case | Web | CLI |
|---|---|---|
| Flag off | 1076 | 1757–1792 |
| Flag on | 1107 | 1838–1873 |

Measure from `packages/convex`:

```bash
bun test convex/conversations.inboxReadBudget.test.ts
```

It prints each run's calls. The CLI count drifts with the clock, so take the
minimum and maximum over 8 runs. The test asserts:

- the 2048 budget;
- each model window lists its cap;
- team membership is read once per team;
- no conversation is read twice in one execution (the shared memo,
  `inboxMemoGet`).

## Turning it on for a team

The feature is in development: only staff can turn it on (`inDevelopment`),
and any admin can turn it off.

1. Deploy convex first, with `packages/convex/deploy.sh`.
2. Stamp `role_started` on the team's older role sessions, which predate the
   field. It pages that team's roles only, one role's page per transaction.
   - Dry run: it names each session it would stamp and writes nothing. Pass
     back `next` (`roleIndex`, `cursor`) until it is null to read every page.
   - Real run: `"dryRun":false`. It schedules its own next page.
   - Rerun: it must stamp 0.

   ```bash
   packages/convex/run.sh ownerMigrations:backfillRoleStarted '{"team_id":"<id>","dryRun":true}'
   packages/convex/run.sh ownerMigrations:backfillRoleStarted '{"team_id":"<id>","dryRun":false}'
   ```
3. Take a task binding's role off the team's live sessions no role started
   (`org_role_hold` "bound", not `role_started`): under the model the role
   would own them and their starter would lose them, and a binding no longer
   files such a session. Dry run first, then `"dryRun":false`; a rerun
   releases 0.

   ```bash
   packages/convex/run.sh ownerMigrations:releaseBindingHolds '{"team_id":"<id>","dryRun":true}'
   ```
4. Count stale primary-owner caches: sessions whose `owner_user_id` has no
   owner row behind it, which would list for nobody. It reads the team's
   sessions, then each member's personal sessions, one page per call.

   ```bash
   packages/convex/run.sh ownerMigrations:countOwnerCacheWithoutRows '{"team_id":"<id>"}'
   ```

   - Pass back `"cursor"` (the reply's `continueCursor`) and `"member"` (the
     reply's `member`) on each next call.
   - Stop when `isDone` is true.
   - Add up `stale` across pages; `examples` names the first few. Resolve
     them before going on.
5. Turn the flag on:

   ```bash
   packages/convex/run.sh teamFeatures:setTeamFeatureInternal '{"team_id":"<id>","feature":"session_owners","enabled":true}'
   ```

6. Give the team's older bot-spawned peers an owner. A session another one
   only spawned, on an agent account with no human of its own, takes its
   spawner's owner at spawn (`ownPeerByItsSpawnersHuman`); one spawned before
   the flag was on has none and lists for nobody. It runs after the flag,
   since the owner rule reads it. Dry run first: it names each peer and the
   owner it would get. Pass back `next` until it is null; a real run pages on
   its own, and a rerun owns 0.

   ```bash
   packages/convex/run.sh ownerMigrations:backfillPeerOwners '{"team_id":"<id>","dryRun":true}'
   ```

Turning it off is the same call with `"enabled":false`, never a code revert.
It restores the behaviour, but not the data the model wrote: owner rows
(an implicit starter's, a taker's, a starter row on a move), roles a takeover
removed, and `parent_released_at` all stay.
