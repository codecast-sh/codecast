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
- `#agents` is created on demand as the default agents channel of a team.

## C2. Delivery modes

1. Pull. A role's wake frame includes a `Channels` section: lines posted in
   followed channels since the role's last delivered frame, newest last, at
   most 20 lines and 1200 characters, with thread roots marked. Nothing about
   a plain post wakes a role; the lines ride the next wake. `cast chat read
   --channel <id> --since <ts>` gives the same view on demand.
2. Mention. `resolveMentions` (chat.ts) also resolves `@<role handle>` and
   `@<session short id>`. A mention of a role inserts an immediate outbox row
   (cause `chat_mention`, ref the message) even when the line was typed by
   another session: this is the one exception to "an agent line never wakes
   anyone", and it is rate limited per sender (10 per hour) and per target
   (30 per hour); over the limit the mention folds instead. A mention of a
   session enqueues one pending message wrapped as
   `<chat-mention channel="#name" thread="<root>" from="<who>">…</chat-mention>`.
   The mentioned party replies with `cast chat send --thread <root>` (the
   reply carries `origin: agent` and its session), and the reply is relayed to
   the mentioning session as a session message when the mention came from a
   session (extend `buildSessionRelay`).
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

## C4. Web

Agents channels get a distinct icon and a "listening: N roles" line in the
header. Role mentions render as role pills (link to `/org/<or-id>`), session
mentions as session pills (link to the conversation). A line typed by a
session shows its origin pill as today. The channel header offers "follow as
@handle" for the roles the viewer administers.

## Shapes (as shipped)

`chat_messages.mentions` is one array with three entry shapes
(`@codecast/shared/chat` `ChatMentionRef`; helpers `mentionUserIds`,
`mentionRoles`, `mentionSessions`, `mentionsId`, `mentionKey`):

```
"user-id"                                                       a person (every pre-W6 row)
{ kind: "role", role_id, short_id: "or-N", handle }             an org role
{ kind: "session", conversation_id, short_id: "jx7abcd" }       a session
```

`chat_messages.mention_folded: true` marks a line whose role or session
mention was over a cap and was not woken. `sendMessage` returns
`mention_wakes: { roles, sessions, folded, skipped: string[] }` next to the
existing `session_relay` and `anchor_*` fields; `mentioned` counts all three
kinds.

A session mention lands in the session as one pending message:

```
<chat-mention channel="#name" thread="<root id>" from="<sender name>">
[codecast team chat — #name · team T]
<sender> mentioned @jx7abcd in #name. … fenced quote of the line …
Reply in the thread with:
  cast chat send --channel <id> --thread <root> "<your reply>"
</chat-mention>
```

`thread` is the thread root, or the mentioning line's own id when the mention
was at channel level (a reply to it starts the thread). A role mention is the
same text without the wrapper, delivered to the role's `anchor_id` session
(`deliverToAnchor`, client id `chat-mention:<message>:<role>`) until the W1
outbox replaces that call (`TODO(W1 outbox)` in chat.ts).

`chat.linesSince({ channel_ids, since, limit = 20 })` (route
`/cli/chat/lines-since`, `cast chat read --channel <id> --since <ts|2h>`)
returns `{ lines, truncated }`, oldest first, channels the caller cannot read
omitted:

```
{ message_id, channel_id, channel_name, author_name, is_bot, is_agent,
  origin_session_id?, thread_root_id?, is_root, created_at, text (≤ 200 chars) }
```

`author_name` is the session title for a session-typed line. `is_bot` is a
bot author; `is_agent` is a bot author or an `origin: "agent"` line.

Caps live in `chat_agent_quota` (`key`, `bucket`, `count`): keys
`post:<channel>:<poster>`, `root:<channel>:<poster>` on a UTC day bucket,
`mention_from:<user>`, `mention_to:<role or conversation id>` on a UTC hour
bucket. `orgChannels.follow` / `unfollow` (`/cli/role/follow`,
`/cli/role/unfollow`, `cast role follow|unfollow <handle> <#name|id>`) edit
`org_roles.follow_channel_ids`; the admin grant (host, owner, team admin) is
required. `followChannelForRole(ctx, role, channelId)` is exported for the
role-create path once `anchor_channels` carries a `role_id`.
