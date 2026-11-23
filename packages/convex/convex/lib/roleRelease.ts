// A run a role started is the role's while no person owns it (shared
// startedByRole, heldByRoleAlone). When the role comes off it (a retire, a
// visibility drop, the role taken off by hand) someone must own it, or it is
// nobody's: a pool machine's bot reads no inbox and a needs-input ring finds
// no person. The person the role answers to takes it first: the person its
// reporting line ends at (buildLadder), else the person whose account runs
// the role. A leaf, so lib/sessionTell can call it from a visibility drop.

import type { Id } from "../_generated/dataModel";
import { startedByRole } from "@codecast/shared/contracts";
import { listSessionOwnerIds, removeSessionOwnerRow, syncPrimaryOwnerCache } from "../sessionOwners";
import { buildLadder } from "./roleLadder";
import { roleRunner } from "./seatPlace";

// A finished hand (completed, or killed) leaves no live work to own: giving
// each of a long-lived role's past hands to a person would flood their Done
// with every hand the role ever ran.
export function releasedRunNeedsOwner(conversation: any): boolean {
  return !conversation.standing_role_id && startedByRole(conversation) && conversation.status !== "completed" && !conversation.inbox_killed_at;
}

/** Give a run the role is leaving to the person the role answers to. Checked
 *  on the row as it is now, since a retire's later batches run after other
 *  writes: still this role's or unfiled (an heir that took it keeps it), live,
 *  and owned by nobody. The row records the role, so an undo that puts the
 *  role back takes it back (returnReleasedRows). */
export async function giveReleasedRun(ctx: { db: any }, conversationId: Id<"conversations">, role: any, addedBy: Id<"users">): Promise<void> {
  const row = role ? await ctx.db.get(conversationId) : null;
  if (!row || (row.org_role_id && String(row.org_role_id) !== String(role._id)) || !releasedRunNeedsOwner({ ...row, org_role_id: role._id })) return;
  if ((await listSessionOwnerIds(ctx, conversationId)).length > 0) return;
  let person: Id<"users"> | undefined = (await buildLadder(ctx, role, Date.now())).firstPersonId;
  if (!person) {
    const runner = await roleRunner(ctx, role);
    if (runner && !(await ctx.db.get(runner))?.is_bot) person = runner;
  }
  if (!person) return;
  const now = Date.now();
  await ctx.db.insert("session_owners", { conversation_id: conversationId, user_id: person, added_by: addedBy, added_at: now, released_from: role._id, ...(String(person) === String(addedBy) ? { seen_at: now } : {}) });
  await syncPrimaryOwnerCache(ctx, conversationId);
}

/** The rows a role's departure gave on this session. */
export async function releasedRowsOf(ctx: { db: any }, conversationId: Id<"conversations">, roleId: string): Promise<any[]> {
  const rows = await ctx.db.query("session_owners").withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId)).collect();
  return rows.filter((r: any) => String(r.released_from ?? "") === String(roleId));
}

/** An undo put the role back: the rows its departure gave go, but for the people in `keep`. */
export async function returnReleasedRows(ctx: { db: any }, conversationId: Id<"conversations">, roleId: string, keep?: Set<string>): Promise<void> {
  const rows = (await releasedRowsOf(ctx, conversationId, roleId)).filter((r) => !keep?.has(String(r.user_id)));
  for (const r of rows) await removeSessionOwnerRow(ctx, conversationId, r.user_id);
  if (rows.length) await syncPrimaryOwnerCache(ctx, conversationId);
}

export async function ownRunAsRoleLeaves(ctx: { db: any }, conversation: any, role: any, addedBy: Id<"users">): Promise<void> {
  if (releasedRunNeedsOwner(conversation)) await giveReleasedRun(ctx, conversation._id, role, addedBy);
}
