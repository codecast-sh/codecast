// One page of ownerMigrations:backfillRoleStarted (the comment there says what it
// stamps and why): one role's sessions, judged by the shared actsForRole.
import { actsForRole } from "@codecast/shared/contracts";
import { ownerRowsOf, removeSessionOwnerRow, syncPrimaryOwnerCache } from "../sessionOwners";
import { reroutePendingDecisionsForConversation } from "../sessionDecisions";

// The spawn wrote its row in the transaction that made the session.
const SPAWN_ROW_WINDOW_MS = 60_000;

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
  const spawnerOf = async (c: any): Promise<any> => {
    const run = !c.spawned_by_conversation_id && c.is_workflow_primary && c.workflow_run_id ? await ctx.db.get(c.workflow_run_id) : null;
    const starterId = c.spawned_by_conversation_id ?? run?.spawner_conversation_id;
    return starterId ? ctx.db.get(starterId) : null;
  };
  const startedOf = async (c: any, depth: number): Promise<boolean> => {
    if (c.role_started) return true;
    if (!c.org_role_id || c.standing_role_id || c.anchor_id || c.org_role_hold === "bound" || depth > 8) return false;
    const key = String(c._id);
    if (started.has(key)) return started.get(key)!;
    started.set(key, false); // a cycle starts nothing
    const starter = await spawnerOf(c);
    const yes = !!starter && actsForRole({ ...starter, role_started: await startedOf(starter, depth + 1) });
    started.set(key, yes);
    return yes;
  };
  const rows: Array<{ role: string; session: string; dropped_owners: string[] }> = [];
  for (const c of page.page as any[]) {
    if (c.role_started || !(await startedOf(c, 0))) continue;
    // The spawn rules before role_started (retainSessionCreator, inheritRunOwners,
    // the line) gave the person whose account ran the spawner a row of their
    // own, written as the session was made. A run a role started takes no
    // person owner, so that row goes with the stamp. A row anyone else gave,
    // one written later (a take-over, Take ownership), and every row of a
    // session somebody drives stay: those are a person's choice, not the spawn's.
    const spawnerRunner = String((await spawnerOf(c))?.user_id ?? "");
    const madeAt = c._creationTime ?? c.started_at ?? 0;
    const retained = c.driver_user_id ? [] : (await ownerRowsOf(ctx, c._id))
      .filter((r) => r.user_id === spawnerRunner && r.added_by === spawnerRunner && r.added_at <= madeAt + SPAWN_ROW_WINDOW_MS);
    rows.push({ role: role.handle, session: c.short_id ?? String(c._id).slice(0, 7), dropped_owners: retained.map((r) => r.user_id) });
    if (dryRun) continue;
    await ctx.db.patch(c._id, { role_started: true });
    for (const r of retained) await removeSessionOwnerRow(ctx, c._id, r.user_id as any);
    if (retained.length) await syncPrimaryOwnerCache(ctx, c._id);
    // Its open questions leave the person they were asked of (a dropped row,
    // or the runner as its implicit starter) and reach the role's line.
    await reroutePendingDecisionsForConversation(ctx as any, c._id, Date.now());
  }
  const next = !page.isDone
    ? { roleIndex, cursor: page.continueCursor as string }
    : roleIndex + 1 < roles.length ? { roleIndex: roleIndex + 1, cursor: undefined } : null;
  return { dryRun, stamped: rows.length, rows, next };
}
