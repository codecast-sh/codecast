// The wheel changes hands by sending (shared/contracts/sessionOwners
// takeOverBySend): a person who owns a session, or whose account runs it, and
// writes into it while a role or another person drives becomes its driver.
// The paused role keeps its place among the owners but may no longer write
// into the session; it asks the person who drives, in its own thread.

import type { Id } from "../_generated/dataModel";
import { actsForRole, rolePaused } from "@codecast/shared/contracts";
import { takeOverBySend } from "@codecast/shared/contracts/sessionOwners";
import { addSessionOwnerRow, ownersFactsOf, syncPrimaryOwnerCache, writeDriver } from "../sessionOwners";
import { personName } from "./sessionTell";
import { internal } from "../_generated/api";

/** A person's own message into the session takes the wheel (takeOverBySend),
 *  in the transaction that queues it. The web store paints the same rule. */
export async function takeWheelOnSend(ctx: { db: any; scheduler?: { runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown> } }, conversation: any, senderId: Id<"users">): Promise<void> {
  if (conversation.standing_role_id) return;
  const sender = await ctx.db.get(senderId);
  if (!sender || sender.is_bot) return;
  const facts = await ownersFactsOf(ctx, conversation);
  const next = takeOverBySend(facts, String(senderId), Date.now());
  if (!next) return;
  const added = next.rows.filter((r) => !facts.rows.some((x) => x.user_id === r.user_id));
  for (const r of added) await addSessionOwnerRow(ctx, conversation._id, r.user_id as Id<"users">, (r.added_by ?? senderId) as Id<"users">);
  if (added.length) await syncPrimaryOwnerCache(ctx, conversation._id, (next.primary_id ?? undefined) as Id<"users"> | undefined);
  // The paused role hears none of its open questions now (sessionDecisions
  // routeFor). Scheduled: the send path cannot import the decision module.
  if (await writeDriver(ctx, conversation._id, String(senderId))) {
    await ctx.scheduler?.runAfter(0, internal.sessionDecisions.rerouteSessionDecisions, { conversation_id: conversation._id });
  }
}

/** The sender acts for the role a person paused on the target: its standing
 *  session, or a session it started and still drives. */
export function actsForPausedRole(sender: any, target: any): boolean {
  if (!sender || !actsForRole(sender) || !rolePaused(target)) return false;
  return String(sender.standing_role_id ?? sender.org_role_id) === String(target.org_role_id);
}

/**
 * Why a send from a role into a session filed under it is refused: a person
 * took the wheel, so the role is paused there. The sender acts for the role
 * (its standing session, or a session it started and still drives). A role's
 * hand reporting to the session that started it still reaches it, and a send
 * into the role (`cast role wake`) is never this. Null when the send may go.
 */
export async function pausedRoleRefusal(ctx: { db: any }, sender: any, target: any): Promise<string | null> {
  if (!actsForPausedRole(sender, target)) return null;
  if ([sender.parent_conversation_id, sender.spawned_by_conversation_id].some((id) => id && String(id) === String(target._id))) return null;
  const [role, driver] = await Promise.all([ctx.db.get(target.org_role_id), ctx.db.get(target.driver_user_id)]);
  const name = personName(driver);
  const handle = role?.handle ? `@${role.handle}` : "the role";
  const short = target.short_id ?? String(target._id).slice(0, 7);
  // A person's own session a task binding filed under the role was never the
  // role's to drive; anything else the role drove until a person took it.
  if (target.org_role_hold === "bound" && !target.role_started) {
    return `Not sent. ${name} drives ${short}: it is their session, filed under ${handle} by its task. Ask them in your own thread (cast decide reaches them).`;
  }
  return `Not sent. ${name} drives ${short} now, so ${handle} is paused there. If ${name} needs to hear this, ask them in your own thread (cast decide reaches them); they can make ${handle} driver again from the session's owners.`;
}
