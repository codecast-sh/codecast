// A run a role started is the role's while no person owns it (shared
// startedByRole, heldByRoleAlone). When the role comes off it (a retire, a
// visibility drop, the role taken off by hand) someone must own it, or it is
// nobody's: a pool machine's bot reads no inbox and a needs-input ring finds
// no person. The person the role answers to takes it first: the person its
// reporting line ends at (buildLadder), else the person whose account runs
// the role. A leaf, so lib/sessionTell can call it from a visibility drop.

import type { Id } from "../_generated/dataModel";
import { startedByRole } from "@codecast/shared/contracts";
import { addSessionOwnerRow, listSessionOwnerIds, syncPrimaryOwnerCache } from "../sessionOwners";
import { buildLadder } from "./roleLadder";
import { roleRunner } from "./seatPlace";

// A finished hand (completed, or killed) leaves no live work to own: giving
// each of a long-lived role's past hands to a person would flood their Done
// with every hand the role ever ran.
export function releasedRunNeedsOwner(conversation: any): boolean {
  return !conversation.standing_role_id && startedByRole(conversation) && conversation.status !== "completed" && !conversation.inbox_killed_at;
}

/** Give a run the role is leaving to the person the role answers to, when no
 *  person owns it. The caller has checked releasedRunNeedsOwner on the run as
 *  it was filed. */
export async function giveReleasedRun(ctx: { db: any }, conversationId: Id<"conversations">, role: any, addedBy: Id<"users">): Promise<void> {
  if (!role || (await listSessionOwnerIds(ctx, conversationId)).length > 0) return;
  let person: Id<"users"> | undefined = (await buildLadder(ctx, role, Date.now())).firstPersonId;
  if (!person) {
    const runner = await roleRunner(ctx, role);
    if (runner && !(await ctx.db.get(runner))?.is_bot) person = runner;
  }
  if (!person) return;
  await addSessionOwnerRow(ctx, conversationId, person, addedBy);
  await syncPrimaryOwnerCache(ctx, conversationId);
}

export async function ownRunAsRoleLeaves(ctx: { db: any }, conversation: any, role: any, addedBy: Id<"users">): Promise<void> {
  if (releasedRunNeedsOwner(conversation)) await giveReleasedRun(ctx, conversation._id, role, addedBy);
}
