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

export async function ownRunAsRoleLeaves(ctx: { db: any }, conversation: any, role: any, addedBy: Id<"users">): Promise<void> {
  if (!role || conversation.standing_role_id || !startedByRole(conversation)) return;
  if ((await listSessionOwnerIds(ctx, conversation._id)).length > 0) return;
  let person: Id<"users"> | undefined = (await buildLadder(ctx, role, Date.now())).firstPersonId;
  if (!person) {
    const runner = await roleRunner(ctx, role);
    if (runner && !(await ctx.db.get(runner))?.is_bot) person = runner;
  }
  if (!person) return;
  await addSessionOwnerRow(ctx, conversation._id, person, addedBy);
  await syncPrimaryOwnerCache(ctx, conversation._id);
}
