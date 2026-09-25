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
  names, parent name, trust stage, and the rules below. Keep it principle
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
  states the role's job in one paragraph, its scope, and the rules. Any
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

## T3. What reaches a role

A role wakes through triggers and messages and nothing else (org-staffing.md
S25). Its scheduled wake is one recurring trigger on its standing session
(`lib/orgRoutine.ts`: the daily check for a role, the weekly company review
for the chief of staff), armed at provision and refreshed to the current
prompt through `orgRoles.ensureRoleRoutine`; the person sees it on the
Triggers page and the role page's Triggers tab, and role pause and resume
pause and resume every trigger on the seat. Everything that asks the role for
its attention is a plain pending message into the standing session through
`pendingMessages.tellRole`: a person's line, a chat mention, a decision on its
ladder, a hand that is hard blocked, a task handed to it, a routine firing.
Nothing is wrapped, held or coalesced. A change in the role's area (a task or
plan in scope, the charter, the scope, the line, authority, who reports to it)
wakes nothing: the role reads it at its next run with `cast brief`, whose
"changed since" section is clocked on the role's last read of its brief from
its own session (`org_roles.checked_at`, stamped by the `/cli/brief/get` route
through `orgRoles.markBriefRead`).

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
the charter (editable by humans), hands with state, the seat's triggers (the
Triggers tab, `ScopeTriggersTab`: the same rows and verbs as the Triggers
page), settings (trust stage with the unlock sentence, caps, model, host,
reports to, retire). The org page node gets a "Talk" action that opens the
standing session in the conversation view. A message to a role renders in
the conversation as the plain message it is.

## What reaches a role (as shipped, S25)

| Event | Emitted from | Reaches the role as |
|---|---|---|
| A person messages the role (`cast role wake`, `cast send @handle`, the composer) | `pendingMessages.enqueuePendingMessage` | the message, as written |
| A chat mention of the role, by a person or a session | `chat.ts` mention path, `tellRole` | a `<chat-mention>` line, the same shape a mentioned session gets |
| A decision routed to the role | `sessionDecisions.wakeLadder`, `tellRole` | one line naming the decision and the commands |
| A hand needs input or is hard blocked | `notifications.performNeedsInputCheck` (one line per waiting episode via `hand_wake_notified_key`); `conversations.performSetThreadState` with `--status blocked` | one line naming the hand |
| A task handed to the role | `tasks.announceAssignment`, `tellRole` | one line naming the task |
| A routine fired | `agentTasks.dispatchCloudTriggers`; the daemon path through `sendMessageToSession` with `origin: "scheduler"` | the `<scheduled-task>` message every session gets |
| A task or plan in scope changed; the charter, scope, line, authority or reports changed; a hand settled done; a decision was answered | nothing | read at the next run with `cast brief` |

Each line into a standing session counts as one of the role's wakes today
(`counters.wakes`, bumped in `enqueuePendingMessage`); org.health reads the
week's wakes as the standing session's user turns (`orgHealth.readTurnsSince`).

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
routines are cancelled, its held turns dropped, and its anchor decommissioned
(kill command, bot off the roster).
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
