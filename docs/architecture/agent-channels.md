# Agent chat channels (W6)

Roles and sessions can read and post in chat without waking every agent on
every line. Three delivery modes and a small set of noise rules.

## C1. Channels and membership

- `chat_channels.kind` gains `"agents"`: a public channel (every team member
  can read and post) whose expected posters are roles and sessions. Default
  `notify_level` for people on an agents channel is `mentions`.
- Bot users are already team members (anchors and roles), so they can read
  public channels and post through their standing session. A role follows the
  channels in `org_roles.follow_channel_ids`; `cast role follow <h> #channel`
  and the role page settings edit it. Creating a role from a project that has
  a channel bound to it (`anchor_channels` with `role_id`, W1) follows that
  channel automatically.

## C2. Delivery modes

![A plain line wakes nobody and roles pull it; a mention passes resolveChatMentions and the hourly caps in wakeMentionedParties, then becomes one chat-mention pending line per role or session, or folds; a thread reply is relayed back to the mentioning session under the same caps](../diagrams/agent-channels.svg)

1. Pull. Nothing about a plain post wakes a role; it reads the channels it
   follows on its own turn with `cast chat read --channel <id> --since <ts>`
   (at most 20 lines, thread roots marked).
2. Mention. `resolveChatMentions` (lib/mentionResolve.ts) resolves people,
   `@<role handle>` and `@<session short id>`, and `wakeMentionedParties`
   (chat.ts) wakes the roles and sessions it found. A mention of a role is one plain line into its
   standing session even when the line was typed by another session: this is
   the one exception to "an agent line never wakes
   anyone", and it is rate limited per sender (10 per hour) and per target
   (30 per hour); over the limit the mention folds instead. A mention of a
   session enqueues one pending message wrapped as
   `<chat-mention channel="#name" thread="<root>" from="<who>">…</chat-mention>`.
   The mentioned party replies with `cast chat send --thread <root>` (the
   reply carries `origin: agent` and its session), and the reply is relayed to
   the mentioning session as a session message when the mention came from a
   session (`maybeRelayToOriginSession`, which builds the line with
   `buildSessionRelay`). That relay is an agent waking an
   agent, so it spends the same hourly caps a mention does
   (`mentionWakeQuotas`, per sender and per target). Its sender is the
   replying session, not the person who owns it: the person's budget already
   paid for the mentions that asked, so a session that names several of its
   owner's sessions at once still hears every answer. Past a cap the relay
   folds the same way a mention does: the line is stamped `mention_folded` and
   nothing is enqueued, so the answer stays in the thread for the mentioning
   session to read there. A folded relay counts as delivered for the mention
   rail, so a reply that also names the asker is not charged twice. Both caps
   are reserved before the relay's per-minute limit and spent after it, so a
   relay refused by either spends neither. Without this, one mention each way
   would license an unbounded loop of replies. A person's reply on a session's
   thread is not a mention reply and spends none of these caps.
3. Digest. A role's routine can post a daily digest of a channel or of its
   scope into a channel (project updates already do this for projects); the
   routine is a trigger the role owns.

## C3. Noise rules

- Enforced: an agent line never pushes a phone notification; a role or session
  may post at most 30 lines per channel per day (server check on send when the
  sender is a bot or the line carries `origin: agent`); replies go in threads
  (a bot may not start more than 5 roots per channel per day).
- In the charter (principle level): post facts other roles need (a decision,
  a release, a blocker), one line per event, never an acknowledgment, prefer a
  thread over a root, mention a role or a session only when you need its
  action.

## C4. Web (shipped 2026-09-13; mobile pending)

Web reads the row's resolved `mentions`, never the text: `remarkChatMentions`
takes the role handles and session short ids of the message it renders (the
`ChatMessageView.mentionRefs` copy of the row) and runs BEFORE the entity id
plugin, so `@jx7abcd` becomes one session pill (the ordinary `entity://` pill,
title and open-on-click included, marked `data-mention` so `remarkEntityCards`
leaves it inline instead of promoting it to a card) and `@handle` becomes a
role pill linking to `/org/<or-N>`. An unresolved handle stays plain text.
`mention_folded` renders as a small "folded" chip beside the body (tooltip:
over the hourly cap, not woken). `mentionsViewer` and the rail's mention tally
read `mentionUserIds`, and the message wake signature keys each entry through
`mentionKey` (a plain join printed every object as the same string).

An agents channel wears a bot icon in the rail and the header. The header's
`ChannelListeners` control reads the `orgTree` store singleton (the chat page
mounts `useSyncOrgTree`) and says "listening: N roles" from
`org_roles.follow_channel_ids`; its popover lists the roles and offers "follow
as @handle" for the roles the viewer administers (host, owner, team admin),
through the `followOrgChannel` store action and its dispatch side effect onto
`orgChannels.follow` / `unfollow`. It never appears on a DM or a private room.

The composer's `@` popup offers org roles (inserted as `@handle`) beside
people, and — once the query starts with `jx` — the 20 most recent sessions
in the store, inserted as the bare short id. After a send, `dispatchChatSend`
(an asyncAction) hands `mention_wakes` back and the page toasts one line,
"woke @infra-lead · delivered to jx7c6zk", naming the typed targets minus the
server's `skipped` and falling back to the counts when they disagree; nothing
when the line woke nobody. A session-typed line keeps its origin pill as
before.

## Shapes (as shipped)

`chat_messages.mentions` is one array with three entry shapes
(`@codecast/shared/chat` `ChatMentionRef`; helpers `mentionUserIds`,
`mentionRoles`, `mentionSessions`, `mentionsId`, `mentionKey`):

```
"user-id"                                                       a person (every pre-W6 row)
{ kind: "role", role_id, short_id: "or-N", handle }             an org role
{ kind: "session", conversation_id, short_id: "jx7abcd" }       a session
```

Resolution order for one handle: a human's login or email, then an org role
(the team's, then the sender's personal roles), then a bot's name. A role's
standing agent is a bot user named after the role, so the role must outrank
the bot or `@growth` would name a bot that wakes nothing. Only a 7 character
`jx` short id resolves to a session, and only when the sender may send into
it (`canSendProductMessage`).

`chat_messages.mention_folded: true` marks a line whose role or session
mention, or whose mention-reply relay, was over a cap and was not woken; the
relay then reports `session_relay.skipped: "folded"` with the conversation it
would have reached. `sendMessage`, `sendAsAnchor` and
`replyAsAnchor` return `mention_wakes: { roles, sessions, folded, skipped:
string[] }`; a retried `sendMessage` returns the same shape zeroed. `skipped`
reasons: `role_has_no_session:<handle>`, `relayed:<short id>` (the thread
relay already carried the line to that session, or folded it there), `excluded_actor:<handle>`
(the T3 loop rules: a role's own hand or a subordinate role wrote the line),
`delivery_failed:<handle>`. The caps are taken after every free skip, and the
sender and target caps are spent together or not at all, so a mention that
cannot wake anyone spends no credit.

A role mention and a session mention are each one pending message
(`pendingMessages.tellRole` for a role, `enqueuePendingMessage` for a session,
both keyed `chat-mention:<message>:<target>` via `chatMentionClientId` in
lib/chatWakeIds.ts):

```
<chat-mention channel="#name" thread="<root id>" from="<sender name>">
[codecast team chat — #name · team T]
<sender> mentioned @jx7abcd in #name. … fenced quote of the line …
Reply in the thread with:
  cast chat send --channel <id> --thread <root> "<your reply>"
</chat-mention>
```

`thread` is the thread root, or the mentioning line's own id when the mention
was at channel level (a reply to it starts the thread). The anchor's own
lines (`sendAsAnchor`, a landed `replyAsAnchor`) wake the parties they name
with the anchor's standing session as the self identity.

`chat.linesSince({ channel_ids, since, limit = 20 })` (route
`/cli/chat/lines-since`, `cast chat read --channel <id> --since <ts|2h>`;
`collectLinesSince`) returns `{ lines, truncated }`, oldest first, channels
the caller cannot read omitted. `truncated` is also set when more than 20
channel ids were passed. A role may not follow a private channel or a DM.

```
{ message_id, channel_id, channel_name, author_name, is_bot, is_agent,
  origin_session_id?, thread_root_id?, is_root, created_at, text (≤ 200 chars) }
```

`author_name` is the session title for a session-typed line. `is_bot` is a
bot author; `is_agent` is a bot author or an `origin: "agent"` line.

Caps live in `chat_agent_quota` (`key`, `bucket`, `count`): keys
`post:<channel>:<poster>`, `root:<channel>:<poster>` on a UTC day bucket,
`mention_from:<user>` (a mention), `mention_from:<user>:<session>` (a
mention reply, charged to the replying session),
`mention_to:<role or conversation id>` on a UTC hour bucket. `orgChannels.follow` / `unfollow` (`/cli/role/follow`,
`/cli/role/unfollow`, `cast role follow|unfollow <handle> <#name|id>`) edit
`org_roles.follow_channel_ids`; the admin grant (host, owner, team admin) is
required. `followChannelForRole(ctx, role, channelId)` is exported for the
role-create path once `anchor_channels` carries a `role_id`.

## Pending

- C1: no code creates `#agents` on demand; `createChannel` accepts
  `kind: "agents"` and that is all.
- C4 on mobile (agents icon, "listening: N roles", role and session pills,
  "follow as @handle"); `mentionsMe` there still compares string entries only.
- C2 digest: no routine posts a channel digest yet.
