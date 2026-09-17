// The stored shape of a chat message's `mentions` (chat_messages.mentions) and
// the readers of it, shared so server, web and mobile agree on which entry is a
// person, a role or a session.
//
// A bare user id is a person. Every row written before roles and sessions could
// be named holds only this shape, which is why the person case is not an
// object: `mentions.includes(viewerId)` stayed true for every reader.

export type ChatRoleMention = { kind: "role"; role_id: string; short_id: string; handle: string };
export type ChatSessionMention = { kind: "session"; conversation_id: string; short_id: string };
/** A person who exists only in the team's mirrored Slack workspace (no
 *  codecast account to point at): `@<their Slack handle>`. Nothing in codecast
 *  is notified; the line's Slack copy carries a real <@U…> so they are paged
 *  there. `name` is the snapshot the pill renders. */
export type ChatSlackMention = { kind: "slack"; user: string; handle: string; name: string };
export type ChatMentionRef = string | ChatRoleMention | ChatSessionMention | ChatSlackMention;

export function mentionUserIds(mentions: ReadonlyArray<ChatMentionRef> | undefined): string[] {
  return (mentions ?? []).filter((m): m is string => typeof m === "string");
}

export function mentionRoles(mentions: ReadonlyArray<ChatMentionRef> | undefined): ChatRoleMention[] {
  return (mentions ?? []).filter((m): m is ChatRoleMention => typeof m === "object" && m.kind === "role");
}

export function mentionSessions(mentions: ReadonlyArray<ChatMentionRef> | undefined): ChatSessionMention[] {
  return (mentions ?? []).filter((m): m is ChatSessionMention => typeof m === "object" && m.kind === "session");
}

export function mentionSlack(mentions: ReadonlyArray<ChatMentionRef> | undefined): ChatSlackMention[] {
  return (mentions ?? []).filter((m): m is ChatSlackMention => typeof m === "object" && m.kind === "slack");
}

/** Does this row name the person, the role, or the session with this id? A
 *  Slack-only person has no codecast id, so never. */
export function mentionsId(mentions: ReadonlyArray<ChatMentionRef> | undefined, id: string): boolean {
  return (mentions ?? []).some((m) =>
    typeof m === "string" ? m === id
      : m.kind === "role" ? m.role_id === id
      : m.kind === "session" ? m.conversation_id === id
      : false);
}

/** A stable string per entry, for signatures and dedupe. */
export function mentionKey(m: ChatMentionRef): string {
  return typeof m === "string" ? m
    : m.kind === "role" ? `role:${m.role_id}`
    : m.kind === "session" ? `session:${m.conversation_id}`
    : `slack:${m.user}`;
}

/** The 7-character session short id shape (`jx` + 5), the only handle that
 *  resolves to a session. Lowercase already: extractMentionHandles lowercases. */
export const SESSION_SHORT_ID_RE = /^jx[a-z0-9]{5}$/;
