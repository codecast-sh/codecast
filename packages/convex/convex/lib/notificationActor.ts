// Who a notification is FROM, for bells, banners and digest titles.
//
// Chat stores Slack-unmapped lines under the workspace bridge user
// ("Union (Slack)") and snapshots the real person on the message as
// `external_author`. The bell used to look up the bridge and name it. The
// snapshot on the notification row is the override; for rows written before
// that field was filled, the message's `external_author` is the same face.

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
} | null | undefined;

export function displayNotificationActor(
  n: NotificationActorFields,
  actor: ActorUser,
  message?: MessageFace,
): { name: string | undefined; avatar: string | undefined } {
  let name = n.actor_name;
  let avatar = n.actor_avatar;
  if (!name && actor?.bot_kind === "slack" && message?.external_author?.name) {
    name = message.external_author.name;
    avatar = avatar || message.external_author.avatar_url;
  }
  return {
    name: name || actor?.name || actor?.github_username,
    avatar: avatar || actor?.github_avatar_url || actor?.image,
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
