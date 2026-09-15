# Roles as standing agents (W1)

Extends docs/architecture/org-roles.md (S1 to S7). A role becomes a live agent:
a standing session with a bot identity, a charter, a brief, a wake rail, trust
stages and caps. Everything reuses the anchor machinery; a role IS an anchor row
with a scope and a parent.

## T1. Provisioning reuses anchors

`orgRoles.provision({ role_id, model?, project_path?, agent_type? })`:

- Generalize `provisionAnchor` (anchors.ts) into a shared `provisionStandingAgent`
  used by both. Differences for a role: `users.bot_kind = "role"`, the anchors
  row carries `org_role_id`, `findExistingAnchor` is keyed on `org_role_id` for
  roles (one standing agent per role) and unchanged for the workspace anchor.
- The conversation gets `acting_user_id = bot`, `anchor_id`, `persistent: true`,
  and a new field `standing_role_id = role_id` (this row IS the role's session).
  Inbox placement treats `standing_role_id` exactly as `anchor_id` (hidden unless
  hard blocked or asking a person). `org_role_id` on a conversation keeps its
  S1 meaning: a hand or any session that reports to the role.
- `org_roles.anchor_id` is set; `anchors.org_role_id` is the back link.
- The root of a workspace is the existing team or personal anchor. `org.tree`
  renders it as the root role. `cast anchor` verbs keep working for it.
- Bootstrap: extend `bootstrapMessage` with role options: name, handle, scope
  names, parent name, trust stage, and the four rules below. Keep it principle
  level. The role's memory is its brief, not files: replace the memory bullet
  with "your brief is your memory; update it with `cast brief edit` at the end
  of any turn that changed your understanding". Delegation bullet: "a hand is a
  session you start with `cast spawn`; it reports to you and shows under you
  on the org page".

New fields:

```
org_roles
  anchor_id?          Id<anchors>
  charter_doc_id?     Id<docs>       doc_type "charter"
  brief_doc_id?       Id<docs>       doc_type "brief"
  trust               "understand" | "decide" | "direct"   default understand
  caps                { hands_per_day, wakes_per_day, tokens_per_day }  defaults 6, 40, 400000
  counters            { day: string(YYYY-MM-DD), hands, wakes, tokens }
  coalesce_ms         number   default 120000
  last_wake_at?       number
  last_frame_seq?     number   change_log seq the last delivered frame covered
  follow_channel_ids? Id<chat_channels>[]
conversations
  standing_role_id?   Id<org_roles>   index by_standing_role
  usage_totals?       { input, output, cache_read, cache_write, updated_at }
anchors
  org_role_id?        Id<org_roles>
docs.doc_type        + "charter" | "brief"   (schema, CLI DOC_TYPE_ICONS, CreateDocModal, entityOptions)
```

## T2. Charter and brief

- Charter: a doc the humans own. Created at provision from a template that
  states the role's job in one paragraph, its scope, and the four rules. Any
  session carrying `standing_role_id` or `org_role_id` may not write a charter
  doc (server check in docs.update keyed on the stored doc_type).
- Brief: a doc the role owns. Body = narrative (first line is the state line,
  then `Status:`/`Next:`/`Blocked:` lines, then a few paragraphs with evidence
  links as short ids). `cast brief` prints facts + narrative; `cast brief edit -`
  writes the narrative and mirrors the first line into the standing session's
  thread state through the existing `stateCommand` path (one field, two verbs).
- Facts are never stored: `org.brief({ role_id })` computes them from the
  same membership as `org.tree` plus tasks and plans in scope: counts by
  status and priority, plans with progress, hands with their state lines,
  decisions open and answered today, tokens and wakes today versus caps.
- The brief's first line and counts render on the role node in the org page
  and as the board line on the scope page (W3).

## T3. The wake rail

Tables:

```
role_wake_outbox
  role_id, kind: "immediate" | "fold" | "passive", cause: string,
  ref?: { table: string; id: string; short_id?: string }, actor_conversation_id?,
  created_at, due_at, flushed_at?, wake_id?
  indexes by_role_flushed [role_id, flushed_at], by_due [flushed_at, due_at]
role_wakes
  role_id, short_id "rw-N", causes: string[], status: "delivered" | "dropped" | "held",
  frame_chars, pending_message_id?, created_at
  index by_role_created [role_id, created_at]
```

Flow, modeled on pushRouter.enqueuePush + flush:

1. `orgEvents.enqueue(ctx, roleId, { kind, cause, ref, actor })` inserts a row.
   immediate: due now, schedule `internal.orgWakes.flush({ role_id })` at 0.
   fold: due now + coalesce_ms; schedule a flush at due only if no unflushed
   row for the role is already due earlier (one indexed read).
   passive: insert only, never schedule.
2. `flush` (internalAction): load role, anchor, conversation. Gates in order:
   role status paused or retired: hold (return, rows stay); over wakes or
   tokens cap and no immediate row: hold; managed session reports an active
   agent status: reschedule in 30s (max 20 times, then deliver anyway).
3. Build the frame through `internal.orgWakes.frameFor({ role_id })` (a query):
   sections `You`, `Why you are awake` (one line per outbox row, passive rows
   marked), `Your scope now` (facts as in T2, as a diff against
   `last_frame_seq` when it exists), `Hands say` (each hand's state line),
   `Channels` (W6, when the role follows any), `Charter` (hash; full text only
   after a restart). Budget 3000 characters of facts; overflow becomes a count.
   The opening tag names the role and the time, and carries the cause count
   and how many of those groups an earlier flush held back (a cap, a pause;
   the outbox row's `held_at`, which marks the group `(held)` in the Why
   list): `<role-wake or-8 at="…" causes="9" held="2">`. `deliver` stamps the
   wake's short id in as `wake="rw-N"` once the log row exists. The web reads
   these off the tag; a frame from before them counts its Why lines.
4. If the frame carries no fact newer than `last_frame_seq` and no immediate
   row, log the wake as dropped and clear the rows.
5. Otherwise one mutation `orgWakes.deliver`: insert the pending message via
   `deliverToAnchor(ctx, anchorId, frame, clientId = wake short id)`, mark the
   rows flushed with the wake id, insert `role_wakes`, bump `counters.wakes`,
   set `last_wake_at` and `last_frame_seq`. The frame text is stored on the
   pending row as today's rail requires (echo adoption matches stored text).

Wake sources and their kinds:

| Source | Where it is emitted | Kind |
|---|---|---|
| A person messages the role (role page composer, `cast role wake`, `cast send @handle`, a human chat mention) | the send path when the target is a standing session | immediate |
| A hand needs input or pinned blocked | the daemon status path that already marks `awaiting_input` / a blocked thread state, when the conversation has `org_role_id` | immediate |
| A hand settled done, or a decision the hand raised was answered | settle path; `sessionDecisions.resolve` | passive |
| A task or plan in scope changed | the single post write chokepoint tasks and plans already funnel through (the task_history writer and plan progress recompute); resolve roles by scanning `org_roles.by_team` (or by_scope_user) and matching `scope` in memory | fold |
| A decision routed to this role (W2) | `sessionDecisions.route` | immediate |
| Another role or session sent instructions (`cast send`) | send path | immediate |
| A routine fired | `agentTasks` fire path when the target conversation has `standing_role_id`: insert an immediate row with the prompt as cause instead of enqueuing the prompt directly | immediate |
| A subordinate posted a digest | project_updates insert of kind digest by a bot user | fold |
| The charter changed | docs.update on a charter doc | immediate |

Loop rules: a role's own writes (actor is its standing session or one of its
hands) never insert rows for that role. A subordinate role's writes never
insert rows for its parent; the parent reads the subordinate's brief line. A
parent's writes inside a subordinate's scope do insert rows for the
subordinate.

## T4. Trust, caps, identity, pause, restart

- Trust stages gate actions server side: `understand` refuses hand starts by
  the role (spawn path checks `standing_role_id` on the spawner) and refuses
  `decide answer`; `decide` allows answers within grants (W2); `direct` allows
  hand starts within caps. Stage changes are human only (role page or
  `cast role trust <h> <stage>`), logged in `task_history` style rows on the
  role (`org_role_history` optional; a doc entry on the charter is enough).
- Caps: `hands_per_day` checked in the spawn path when the spawner carries a
  standing or hand pointer; `wakes_per_day` in flush; `tokens_per_day` in flush
  and spawn using `conversations.usage_totals` summed over the role's standing
  session and hands for the day. Usage writer: extract `message.usage` from
  Claude JSONL assistant records in packages/cli/src/parser.ts, send it with
  the message sync, and roll it up into `usage_totals` on the conversation in
  the message insert path. Other backends: absent, and the role page shows
  "tokens not counted for N sessions".
- Identity: one server side actor resolver. For task comments, task status and
  assignee changes, plan entries, doc writes, project updates and chat sends
  that carry a calling conversation whose row has `standing_role_id`, the actor
  is the anchor's bot user. Hands keep the host as actor. Implement it once in
  a helper (`lib/actor.ts`) and call it from those write paths.
- Pause: `orgRoles.pause` sets status paused; flush holds; hands under the role
  receive one interrupt ("stop at a safe point"); the spawn path refuses new
  hands under a paused role. Resume flushes held rows as one wake.
- Restart: `orgRoles.restart` calls the existing `restartSession` on the
  standing conversation; the first frame after a restart carries the brief in
  full and the charter text.

## T5. CLI

```
cast role create <name> --handle <h> [--project <ref>]... [--plan <ref>]... [--reports-to @handle|me] [--charter -] [--model m] [--no-session]
cast role ls | show <h> | wake <h> "msg" | pause <h> | resume <h> | retire <h> | restart <h> | trust <h> <stage> | caps <h> --hands n --wakes n --tokens n
cast brief [<h>] [--json]            # facts + narrative; inside a role, its own
cast brief edit -                    # narrative from stdin (inside a role, or --for <h> as the parent)
cast role wakes <h> [-n 20]          # the wake log
```

Routes `/cli/role/*`, `/cli/brief/*` in http.ts, next to `/cli/anchor/*`.

## T6. Web

Role page `/org/<or-id>` (shared with the scope page, W3) gets: the brief
(facts block + narrative, editable narrative for the parent or a seat holder),
the charter (editable by humans), hands with state, wakes log with causes and
frame size (the Wakes tab, `?tab=wakes&wake=rw-N` lands on one wake), routines (the role's triggers), settings (trust stage with the
unlock sentence, caps, model, host, reports to, retire). The org page node
gets a "Talk" action that opens the standing session in the conversation view.

In the conversation view a frame renders as the wake card
(`components/RoleWakeCard.tsx`, parsed by `components/roleWake.ts`): the role
and handle linking to its page, the wake id, "woke on N changes, M held" with
a held backlog tag, each section folded behind its line count (Why open), task
and plan ids as live pills, and the role's controls (open, pause or resume
through `updateOrgRole`, caps, the wake log). A raw frame in the transcript is
a regression.

## Wake sources (as shipped, W1)

Every row of the T3 table has a chokepoint today. The emitting site is the
one place each event passes through; nothing else inserts outbox rows.

| Source | Emitted from | Kind | Loop rule |
|---|---|---|---|
| A person messages the role (`cast role wake`, `cast send @handle`, the composer) | `pendingMessages.enqueuePendingMessage`: a `human` send, a `from_conversation_id` send, or `origin: "scheduler"` on a conversation with `standing_role_id`. The row is inserted as status `held` (the daemon and the retry cron read `pending` only) and its id rides the outbox row; the flush writes the frame into it and releases it as `pending`, so the daemon never delivers the raw message ahead of the frame. When no outbox row is inserted (retired role, no anchor, the sender is its own hand) the row is released at once | immediate | a send from the role's own hand is excluded |
| A hand needs input or is hard blocked | `notifications.performNeedsInputCheck` (open question, permission prompt, stopped, unresponsive on a conversation with `org_role_id`, one row per waiting episode via `hand_wake_notified_key`); `conversations.performSetThreadState` with `--status blocked` | immediate | the hand is the SUBJECT of the event and is passed as no actor, so the own-writes rule does not drop it |
| A hand settled done | `conversations.performSetThreadState` with `--status done` | passive | the hand is the subject, no actor |
| A decision the hand raised was answered | `sessionDecisions.settleResolution`: every ladder role and the asker's role | passive | |
| A task or plan in scope changed | `functions.ts` post write hook: every insert or patch to `tasks` or `plans` in a mutation is collected (`orgEvents.makeOrgWriteTrackedDb`) and resolved against `org_roles.by_team` / `by_scope_user` with `rowInScope` after the handler returns (`flushOrgWrites`) | fold | the actor is named once, by `lib/access.resolveSessionConversation` (`markOrgActor`), for every writer that resolves its calling session and RUNS it; projectUpdates.post marks its own resolved row |
| A decision routed to this role | `sessionDecisions.wakeLadder` (the ask path) | immediate | the asking session is the actor |
| Another role or session sent instructions | `enqueuePendingMessage` (see row one) | immediate | subordinate to parent excluded |
| A routine fired | `agentTasks.dispatchCloudTriggers` (cloud) inserts the row with the prompt as cause instead of a pending message; the daemon path goes through `sendMessageToSession` with `origin: "scheduler"` and lands in row one | immediate | |
| A subordinate posted a digest | `projectUpdates.post` with kind `digest` from a session | fold | poster's role and its parent excluded |
| The charter changed | `docs.update` on a doc whose stored type is `charter` | immediate | |
| The scope changed | `orgRoles.performUpdateRole` when `scope` differs | immediate | |
| A chat mention of the role | `chat.ts` role mention path (replaces the `deliverToAnchor` call) | immediate | the mentioning session is the actor |
| A restart | `orgRoles.performRestartRole`, cause prefixed `restart:` so the next frame carries the charter and brief in full | immediate | |

Enqueue dedupes per ref: a fold or passive row for a (table, id) that
already waits unflushed is refreshed in place (newest cause, first due time
kept), so a task moved seven times by seven mutations is one line in one
frame and one wake per window (ct-51491). Immediate rows never fold.

Flush: `orgWakes.performFlush` (an internal mutation, scheduled by
`orgEvents.scheduleFlush`). A due immediate or fold row takes every waiting
row with it: enqueue arms one flush per coalesce window, so a fold row that
landed while an earlier one waited rides the frame that is going out anyway
(delivered up to `coalesce_ms` early, still one wake). A fold or passive row
is one per (table, id) per window: a repeat for a ref that already waits
patches that row's cause and bumps its `count`, keeping the first due time,
so a task moved seven times is one line ("... (changed 7 times)") and one
wake, never seven rows (ct-51491). Gates in order: paused or retired holds; over `wakes_per_day` or
`tokens_per_day` holds system rows (an immediate row still passes) and
re-arms at the next UTC day; an active agent reschedules in 30s up to 20
times. A frame with no fact newer than `last_frame_seq` and no immediate row
is logged as dropped.

Frame: `orgWakes.buildFrame`, sections `You`, `Why you are awake` (the rows
grouped by (table, id) at render, newest first, the latest cause with the
counts summed, so a backlog released by a resume is one line per work item;
15 lines, then one count line), `Your scope now` (plans active or draft only,
8 lines; changes since the last frame, 12 lines; each overflow is one count
line, and the 3000 character budget stays the ceiling), `Hands say` (each hand's pin, its task's status, execution status
and review verdict), `Channels` (when the role follows any), `Charter`
(hash; full text plus the brief after a restart). Facts come from
`org.computeBriefFacts`, which reuses `resolveScope` and
`computeScopeSummary` (W3) and adds hands, changes since the last frame,
decisions on the ladder and today's usage against the caps.

Actor: `lib/actor.resolveActor`. Identity follows the token: a conversation
the caller does not run (its `user_id` is another account) is an ordinary
session, so a teammate naming a standing session's id does not sign as the
role. The charter guard (`docs.refuseRoleCharterWrite`, on `docs.update` and
`docs.patch`) applies the same ownership check; the CLI stamps the calling
session on `cast doc edit`. Trust, caps, scope and the charter field are
human only on the server's own evidence (`orgRoles.refuseUnlessHuman`): the
call must carry a browser auth identity and no api token, so a hand that
strips its session variables and calls with its host's token is still
refused; the web role page is the one door. Retire (`performRetireRole`)
tears the seat down: live hands get one interrupt, the standing session's
routines are cancelled, its held turns dropped, its anchor decommissioned
(kill command, bot off the roster), and its unflushed outbox rows deleted.
A hand's first turn opens with the unattended mandate and a briefing that
names `cast task handoff`, `cast task verdict` and `cast decide --task`
(`spawn.handBriefing`, written where the hand pointer is written). Usage: `messages.rollUpUsage` from the CLI
parser's `usageOf` on Claude assistant records, into
`conversations.usage_totals` and the role's daily token counter. One turn
spans several JSONL records that share `message.id` and repeat the usage
block, so a turn counts once per id (`api_message_id` on the wire,
`usage_totals.last_api_message_id` across batches) and only for rows the
sync inserted, never for a resync that patches existing rows.

Not counted: sessions on backends other than Claude carry no usage; the
brief reports them as `uncounted_sessions`.
