// Who sent a user message. One answer for every surface that names a sender:
// the transcript's bubbles and sticky banner, the message navigator, and the
// phone's session screen, so a row and its bubble always name the same person.
// Pure: each platform injects its own roster lookup.

export type SenderPerson = { name?: string | null; image?: string | null };

export type SenderContext = {
  ownerId?: string | null;
  ownerName?: string | null;
  ownerImage?: string | null;
  viewerId?: string | null;
  lookup: (userId: string) => SenderPerson | undefined;
};

export type MessageSender = {
  // The account id, `name:<lowercased name>` for a sender known only by the
  // name a wrapper carries, or the owner's id (`owner` when unknown).
  key: string;
  name: string;
  image: string | null;
};

// Precedence: the sending account when the roster can name it (a row the
// viewer just sent has no account on it yet, but is theirs), else the name a
// wrapper carries (`<user-message from="Cam">`), else the session's owner,
// whose own and legacy rows carry no sender. A sending account nobody can
// name, with no wrapper, is "Someone": calling it the owner would say the
// owner wrote it.
export function resolveMessageSender(
  msg: { fromUserId?: string | null; wireFrom?: string | null; pending?: boolean },
  ctx: SenderContext,
): MessageSender {
  const senderId = msg.fromUserId ?? (msg.pending ? ctx.viewerId : undefined) ?? undefined;
  const person = senderId ? ctx.lookup(senderId) : undefined;
  if (senderId && person?.name) return { key: senderId, name: person.name, image: person.image ?? null };
  if (msg.wireFrom) return { key: `name:${msg.wireFrom.toLowerCase()}`, name: msg.wireFrom, image: null };
  if (senderId && senderId !== ctx.ownerId) return { key: senderId, name: "Someone", image: null };
  const owner = ctx.ownerId ? ctx.lookup(ctx.ownerId) : undefined;
  return {
    key: ctx.ownerId ?? "owner",
    name: ctx.ownerName || owner?.name || "Owner",
    image: ctx.ownerImage ?? owner?.image ?? null,
  };
}
