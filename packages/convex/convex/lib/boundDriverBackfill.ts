// One page of ownerMigrations:backfillBoundDriver (the comment there says what it
// stamps and why): one role's sessions held as bound, stamped by the rule
// applyHoldChange writes for a new binding.
import { listedOwnerIds } from "@codecast/shared/contracts/sessionOwners";
import { humanStarterUser, ownersFactsOf, writeDriver } from "../sessionOwners";
import { reroutePendingDecisionsForConversation } from "../sessionDecisions";
import { isBoundSession } from "./orgOwnership";
import { roleStartJudge } from "./roleStartedBackfill";

// What filed a session under the role last, as the org log has it: a binding
// files through the reparent core, a row of kind session whose write sets the
// role; a takeover folds the session into the row of the change that caused
// it (a scope, hire or retire row), listed in effects.takeover.sessions.
// releaseFolderHeld reads takeovers the same way.
const filesUnder = (row: any, conversationId: string, roleId: string): "binding" | "takeover" | null => {
  const t = row.effects?.takeover;
  if (t && String(t.role_id) === roleId && (t.sessions ?? []).some((s: any) => String(s?.conversation_id) === conversationId)) return "takeover";
  const sets = (row.writes ?? []).some((w: any) => w.table === "conversations" && String(w.id) === conversationId && String(w.after?.org_role_id ?? "") === roleId);
  return sets && row.kind === "session" ? "binding" : null;
};

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
  const roleId = String(role._id);
  const page = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 100 });
  const { startedOf } = roleStartJudge(ctx);
  // The role's workspace log, read once a page and only when a candidate needs it.
  let log: any[] | null = null;
  const filedByTakeover = async (c: any): Promise<boolean> => {
    const entries: any[] = log ??= await ctx.db.query("org_changes").withIndex("by_workspace_seq", (q: any) => q.eq("workspace", role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`)).collect();
    let last: "binding" | "takeover" | null = null;
    for (const row of entries) last = filesUnder(row, String(c._id), roleId) ?? last;
    return last === "takeover";
  };
  const rows: Array<{ role: string; session: string; driver: string }> = [];
  for (const c of page.page as any[]) {
    if (c.org_role_hold !== "bound" || c.driver_user_id || c.role_started || c.standing_role_id || c.anchor_id || !isBoundSession(c)) continue;
    // Its driver changed since the field shipped (a Resume among them): that choice stands.
    if (c.driver_changed_at) continue;
    // A role's own hand bound to its task is the role's to drive.
    if (await startedOf(c)) continue;
    const person = await humanStarterUser(ctx, c);
    // A starter who no longer owns it does not take the wheel (writeDriver's rule).
    if (!person || !listedOwnerIds(await ownersFactsOf(ctx, c)).includes(String(person._id))) continue;
    // A takeover by the rule put the role in charge on purpose.
    if (await filedByTakeover(c)) continue;
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
