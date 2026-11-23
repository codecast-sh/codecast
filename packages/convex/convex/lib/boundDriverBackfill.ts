// One page of migrations:backfillBoundDriver (the comment there says what it
// stamps and why): one role's sessions held as bound, stamped by the rule
// applyHoldChange writes for a new binding.
import { listedOwnerIds } from "@codecast/shared/contracts/sessionOwners";
import { humanStarterUser, ownersFactsOf, writeDriver } from "../sessionOwners";
import { reroutePendingDecisionsForConversation } from "../sessionDecisions";
import { isBoundSession } from "./orgOwnership";

export async function backfillBoundDriverPage(
  ctx: { db: any },
  args: { dryRun?: boolean; role?: string; roleIndex?: number; cursor?: string; numItems?: number },
) {
  const dryRun = args.dryRun ?? true;
  let roles: any[] = (await ctx.db.query("org_roles").collect()).sort((x: any, y: any) => String(x._id).localeCompare(String(y._id)));
  if (args.role) roles = roles.filter((r) => r.handle === args.role!.replace(/^@/, "").toLowerCase());
  const roleIndex = args.roleIndex ?? 0;
  const role = roles[roleIndex];
  if (!role) return { dryRun, stamped: 0, rows: [], next: null };
  const page = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 100 });
  const rows: Array<{ role: string; session: string; driver: string }> = [];
  for (const c of page.page as any[]) {
    if (c.org_role_hold !== "bound" || c.driver_user_id || c.role_started || c.standing_role_id || c.anchor_id || !isBoundSession(c)) continue;
    const person = await humanStarterUser(ctx, c);
    // A starter who no longer owns it does not take the wheel (writeDriver's rule).
    if (!person || !listedOwnerIds(await ownersFactsOf(ctx, c)).includes(String(person._id))) continue;
    rows.push({ role: role.handle, session: c.short_id ?? String(c._id).slice(0, 7), driver: String(person._id) });
    if (dryRun) continue;
    await writeDriver(ctx, c._id, String(person._id));
    // Its open questions leave the paused role and reach the person who drives.
    await reroutePendingDecisionsForConversation(ctx as any, c._id, Date.now());
  }
  const next = !page.isDone
    ? { roleIndex, cursor: page.continueCursor as string }
    : roleIndex + 1 < roles.length ? { roleIndex: roleIndex + 1, cursor: undefined } : null;
  return { dryRun, stamped: rows.length, rows, next };
}
