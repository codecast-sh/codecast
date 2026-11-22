// One page of migrations:backfillRoleStarted (the comment there says what it
// stamps and why): one role's sessions, judged by the shared actsForRole.
import { actsForRole } from "@codecast/shared/contracts";

export async function backfillRoleStartedPage(
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
  const started = new Map<string, boolean>();
  const startedOf = async (c: any, depth: number): Promise<boolean> => {
    if (c.role_started) return true;
    if (!c.org_role_id || c.standing_role_id || c.anchor_id || c.org_role_hold === "bound" || depth > 8) return false;
    const key = String(c._id);
    if (started.has(key)) return started.get(key)!;
    started.set(key, false); // a cycle starts nothing
    const run = !c.spawned_by_conversation_id && c.is_workflow_primary && c.workflow_run_id ? await ctx.db.get(c.workflow_run_id) : null;
    const starterId = c.spawned_by_conversation_id ?? run?.spawner_conversation_id;
    const starter = starterId ? await ctx.db.get(starterId) : null;
    const yes = !!starter && actsForRole({ ...starter, role_started: await startedOf(starter, depth + 1) });
    started.set(key, yes);
    return yes;
  };
  const rows: Array<{ role: string; session: string }> = [];
  for (const c of page.page as any[]) {
    if (c.role_started || !(await startedOf(c, 0))) continue;
    rows.push({ role: role.handle, session: c.short_id ?? String(c._id).slice(0, 7) });
    if (!dryRun) await ctx.db.patch(c._id, { role_started: true });
  }
  const next = !page.isDone
    ? { roleIndex, cursor: page.continueCursor as string }
    : roleIndex + 1 < roles.length ? { roleIndex: roleIndex + 1, cursor: undefined } : null;
  return { dryRun, stamped: rows.length, rows, next };
}
