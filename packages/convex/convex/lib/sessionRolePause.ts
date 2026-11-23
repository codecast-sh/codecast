// Pausing and resuming a session's role: who drives it, changed by a person
// who owns or runs it (the owners menu, `cast own --drive`/`--pause`). Each
// change moves the wheel (sessionOwners.writeDriver), tells the agent whom it
// reports to now and moves the session's open questions with it.
import type { Id } from "../_generated/dataModel";
import { rolePaused } from "@codecast/shared/contracts";
import { writeDriver } from "../sessionOwners";
import { reroutePendingDecisionsForConversation } from "../sessionDecisions";
import { reportsToOf, tellReportsToChange } from "./reportsTo";
import { refusePausedRoleEdit, takeWheelOnSend } from "./sessionTakeOver";
import { driverOf, mayEditOwners, ownerIdsOrStarter, ownerNamed, resolveOwnableConversation, resolveOwnerRef, type DriverTarget, type SessionDriver } from "./sessionOwnerRules";

// Every driver change outside the reparent core (which tells and reroutes as
// it ends): the wheel moves (sessionOwners.writeDriver), the agent hears whom
// it reports to now (lib/reportsTo), and the session's open questions follow
// it; a paused role hears none (sessionDecisions routeFor).
export async function setDriver(ctx: { db: any }, actorId: Id<"users">, conversationId: Id<"conversations">, userId: string | null, fromSession?: string): Promise<void> {
  const before = await reportsToOf(ctx, conversationId);
  if (!(await writeDriver(ctx, conversationId, userId))) return;
  await tellReportsToChange(ctx, actorId, conversationId, before, fromSession);
  await reroutePendingDecisionsForConversation(ctx, conversationId, Date.now());
}

// Hand the wheel to the filed role or to one of the people who own it. A
// person must already own the session (or be its human starter while nobody
// does); a role must be the one it is filed under.
export async function performSetSessionDriver(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; driver: DriverTarget; from_session?: string },
): Promise<{ ok: true; short_id: string; conversation_id: Id<"conversations">; driver: SessionDriver | null }> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  if (!(await mayEditOwners(ctx, authUserId, conversation))) throw new Error("Only an owner of the session, or the account that runs it, can pause or resume its role");
  await refusePausedRoleEdit(ctx, authUserId, conversation, args.from_session);
  if (args.driver.kind === "none") {
    await setDriver(ctx, authUserId, conversation._id, null, args.from_session);
    const driver = driverOf({ ...conversation, driver_user_id: undefined }, await ownerIdsOrStarter(ctx, conversation));
    return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: driver! };
  }
  if (args.driver.kind === "role") {
    if (!conversation.org_role_id) throw new Error(`Session ${shortId} is not filed under a role, so it has no role to resume`);
    await setDriver(ctx, authUserId, conversation._id, null, args.from_session);
    return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: { kind: "role", role_id: conversation.org_role_id } };
  }
  const ownerIds = await ownerIdsOrStarter(ctx, conversation);
  // The web passes an owner's id; `cast own --drive` passes a person as typed.
  const ref = args.driver.user_id;
  let userId = ownerIds.includes(ref) ? ref : null;
  if (!userId && ref.trim().toLowerCase() !== "me") userId = await ownerNamed(ctx, ownerIds, ref);
  userId ??= String((await resolveOwnerRef(ctx, authUserId, conversation, ref))._id);
  if (!ownerIds.includes(userId)) throw new Error("Only an owner of the session can work in it with its role paused; add them as an owner first");
  await setDriver(ctx, authUserId, conversation._id, userId, args.from_session);
  return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: { kind: "user", user_id: userId as Id<"users"> } };
}

// `cast own <s> --pause @role`: the caller works in the session and its role
// pauses, the composer's take-over (takeWheelOnSend) without a message, so the
// account that runs it becomes an owner first when it is not one. A role a
// person already paused stays as it is: the wheel never moves between people
// here, and no question moves.
export async function performPauseSessionRole(
  ctx: { db: any; scheduler?: any },
  authUserId: Id<"users">,
  args: { session_id: string; from_session?: string },
): Promise<{ ok: true; short_id: string; conversation_id: Id<"conversations">; driver: SessionDriver | null }> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  if (!(await mayEditOwners(ctx, authUserId, conversation))) throw new Error("Only an owner of the session, or the account that runs it, can pause or resume its role");
  await refusePausedRoleEdit(ctx, authUserId, conversation, args.from_session);
  if (!conversation.org_role_id) throw new Error(`Session ${shortId} is not filed under a role, so it has no role to pause`);
  if (!rolePaused(conversation)) await takeWheelOnSend(ctx, conversation, authUserId);
  const after = await ctx.db.get(conversation._id);
  return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: driverOf(after, await ownerIdsOrStarter(ctx, after)) };
}
