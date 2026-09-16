import { deliverSessionNotification } from "./notifications";
import { listSessionOwnerIds } from "./sessionOwners";

export async function notifySessionAssigned(
  ctx: any,
  conversationId: any,
  recipientIds: any[],
  actorUserId: any,
  note?: string,
): Promise<number> {
  if (recipientIds.length === 0) return 0;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return 0;

  const actor = await ctx.db.get(actorUserId);
  const actorName = actor?.name || actor?.email || "A teammate";
  const label =
    (conversation.title || "").trim() ||
    conversation.short_id ||
    "a session";

  let delivered = 0;
  for (const recipientId of recipientIds) {
    if (recipientId.toString() === actorUserId.toString()) continue;
    const ok = await deliverSessionNotification(
      ctx,
      recipientId,
      conversationId,
      "session_assigned",
      "Session assigned to you",
      `${actorName} assigned you "${label}"${note ? ` — “${note}”` : ""}`,
    );
    if (ok) delivered++;
  }
  return delivered;
}

export async function notifySessionOwnershipChanged(
  ctx: any,
  conversationId: any,
  change: { added: any[]; removed: any[]; owners: Array<{ user_id: string; name: string | null; email: string | null }> },
  actorUserId: any,
): Promise<number> {
  if (change.added.length === 0 && change.removed.length === 0) return 0;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return 0;
  const actor = await ctx.db.get(actorUserId);
  const actorName = actor?.name || actor?.email || "A teammate";
  const label = conversation.title?.trim() || conversation.short_id || "this session";
  const added = new Set(change.added.map(String));
  const removed = new Set(change.removed.map(String));
  const names = change.owners.map((owner) => owner.name || owner.email || "a teammate");
  const addedNames = change.owners.filter((owner) => added.has(owner.user_id)).map((owner) => owner.name || owner.email || "a teammate");
  const action = added.has(String(actorUserId)) && added.size === 1
    ? `${actorName} took ownership of "${label}".`
    : addedNames.length > 0
      ? `${actorName} added ${addedNames.join(", ")} as ${addedNames.length === 1 ? "an owner" : "owners"} of "${label}".`
      : `${actorName} changed the owners of "${label}".`;
  const recipients = new Set([String(conversation.user_id), ...change.owners.map((owner) => owner.user_id), ...removed]);
  let delivered = 0;
  for (const recipient of recipients) {
    if (recipient === String(actorUserId) || added.has(recipient)) continue;
    const effect = removed.has(recipient)
      ? "You were removed as an owner."
      : recipient === String(conversation.user_id)
        ? "It still runs on your account and machine."
        : "You remain an owner.";
    const message = `${action} ${effect} ${names.length ? `Owners: ${names.join(", ")}.` : "No owners are assigned."}`;
    if (await deliverSessionNotification(ctx, recipient, conversationId, "session_assigned", "Session ownership changed", message)) delivered++;
  }
  return delivered;
}

export async function notifySessionExecutionTaken(
  ctx: any,
  conversation: { _id: any; user_id: any; owner_user_id?: any; title?: string; short_id?: string },
  actorUserId: any,
  destination: string,
  source?: string,
  stopRequested = false,
): Promise<number> {
  if (String(conversation.user_id) === String(actorUserId)) return 0;
  const actor = await ctx.db.get(actorUserId);
  const actorName = actor?.name || actor?.email || "A teammate";
  const label = conversation.title?.trim() || conversation.short_id || "this session";
  const owners = await listSessionOwnerIds(ctx, conversation._id);
  const recipients = new Set([conversation.user_id, conversation.owner_user_id, ...owners].filter(Boolean).map(String));
  let delivered = 0;
  for (const recipient of recipients) {
    if (recipient === String(actorUserId)) continue;
    const message = `${actorName} took over execution of "${label}". The session is moving ${source ? `from ${source} ` : ""}to ${destination} under ${actorName}'s account and billing.${stopRequested ? " The previous machine has been told to stop its copy." : ""} Assigned owners are unchanged.`;
    if (await deliverSessionNotification(ctx, recipient, conversation._id, "session_assigned", "Session execution taken over", message)) delivered++;
  }
  return delivered;
}

