// Who a notification is FROM, for bells, banners and digest titles.
//
// Chat stores Slack-unmapped lines under the workspace bridge user
// ("Union (Slack)") and snapshots the real person on the message as
// `external_author`. The bell used to look up the bridge and name it. The
// snapshot on the notification row is the override; for rows written before
// that field was filled, the message's `external_author` is the same face.
//
// A line a codecast session typed (origin "agent") is stored under the human
// the session ran as. The bell names the session (the row's actor_name), and
// must not wear that human's photo: it carries the session instead, so every
// client draws the session's agent mark, as the chat transcript does.

export type NotificationActorFields = {
  actor_name?: string;
  actor_avatar?: string;
};

export type ActorUser = {
  name?: string;
  github_username?: string;
  github_avatar_url?: string;
  image?: string;
  bot_kind?: string;
} | null | undefined;

export type MessageFace = {
  external_author?: { name?: string; avatar_url?: string } | null;
  origin?: string;
  origin_session_id?: string;
  origin_session_title?: string;
  origin_agent_type?: string;
  author_kind?: string;
} | null | undefined;

export type NotificationSession = { id: string; agent_type: string };

/** The session that typed a chat line, when one did. An anchor reply
 *  (author_kind "agent") is a bot with its own identity, not a session. */
export function sessionOfMessage(message: MessageFace): NotificationSession | null {
  if (!message || message.origin !== "agent" || !message.origin_session_id || message.author_kind === "agent") return null;
  return { id: message.origin_session_id, agent_type: message.origin_agent_type || "claude_code" };
}

export function displayNotificationActor(
  n: NotificationActorFields,
  actor: ActorUser,
  message?: MessageFace,
): { name: string | undefined; avatar: string | undefined; session: NotificationSession | null } {
  const session = sessionOfMessage(message);
  if (session) {
    return { name: n.actor_name || message?.origin_session_title || "Agent session", avatar: undefined, session };
  }
  let name = n.actor_name;
  let avatar = n.actor_avatar;
  if (!name && actor?.bot_kind === "slack" && message?.external_author?.name) {
    name = message.external_author.name;
    avatar = avatar || message.external_author.avatar_url;
  }
  return {
    name: name || actor?.name || actor?.github_username,
    avatar: avatar || actor?.github_avatar_url || actor?.image,
    session: null,
  };
}

/** Rows written before the snapshot was stored baked the bridge name into
 *  `message`. Swap that prefix for the person the bell now names. */
export function rewriteNotificationMessage(
  message: string,
  displayName: string | undefined,
  liveName: string | undefined,
): string {
  if (!displayName || !liveName || displayName === liveName) return message;
  if (!message.startsWith(liveName)) return message;
  return displayName + message.slice(liveName.length);
}
