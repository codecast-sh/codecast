// One page of ownerMigrations:backfillRoleStarted (the comment there says what
// it stamps and why): one role's sessions, judged by the shared actsForRole.
import { actsForRole } from "@codecast/shared/contracts/sessionOwners";

// Whether a session is a role's start, judged by who started it, never by its
// hold: the session that spawned it (`spawned_by_conversation_id`, or for a
// run's own session the run's spawner) acts for the role, that starter judged
// by the same rule, up to 8 links. One judge per transaction: it caches what
// it read, so the order sessions are judged in never changes the answer.
export function roleStartJudge(ctx: { db: any }) {
  const started = new Map<string, boolean>();
  const spawnerOf = async (c: any): Promise<any> => {
    const run = !c.spawned_by_conversation_id && c.is_workflow_primary && c.workflow_run_id ? await ctx.db.get(c.workflow_run_id) : null;
    const starterId = c.spawned_by_conversation_id ?? run?.spawner_conversation_id;
    return starterId ? ctx.db.get(starterId) : null;
  };
  const startedOf = async (c: any, depth = 0): Promise<boolean> => {
    if (c.role_started) return true;
    if (!c.org_role_id || c.standing_role_id || c.anchor_id || depth > 8) return false;
    const key = String(c._id);
    if (started.has(key)) return started.get(key)!;
    started.set(key, false); // a cycle starts nothing
    const starter = await spawnerOf(c);
    const yes = !!starter && actsForRole({ ...starter, role_started: await startedOf(starter, depth + 1) });
    started.set(key, yes);
    return yes;
  };
  return { startedOf };
}

export async function backfillRoleStartedPage(
  ctx: { db: any },
  args: { team_id: string; dryRun?: boolean; roleIndex?: number; cursor?: string; numItems?: number },
) {
  const dryRun = args.dryRun ?? true;
  // One team's roles only: the team the flag is about to be turned on for.
  const roles: any[] = (await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).collect())
    .sort((x: any, y: any) => String(x._id).localeCompare(String(y._id)));
  const roleIndex = args.roleIndex ?? 0;
  const role = roles[roleIndex];
  if (!role) return { dryRun, stamped: 0, sessions: [] as string[], next: null };
  const page = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 100 });
  const { startedOf } = roleStartJudge(ctx);
  const sessions: string[] = [];
  for (const c of page.page as any[]) {
    if (c.role_started || !(await startedOf(c))) continue;
    sessions.push(c.short_id ?? String(c._id).slice(0, 7));
    if (!dryRun) await ctx.db.patch(c._id, { role_started: true });
  }
  const next = !page.isDone
    ? { roleIndex, cursor: page.continueCursor as string }
    : roleIndex + 1 < roles.length ? { roleIndex: roleIndex + 1, cursor: undefined } : null;
  return { dryRun, role: role.handle as string, stamped: sessions.length, sessions, next };
}

// One page of ownerMigrations:releaseBindingHolds: a live session that a task
// binding filed under a role (org_role_hold "bound") although no role started
// it. Under the owner model the role would own it and its starter would lose
// it, and a binding no longer files such a session (applyHoldChange), so the
// hold comes off and the starter owns it again. Silent: no message to the
// session or the role. Run after backfillRoleStarted, so role_started is true.
export async function releaseBindingHoldsPage(
  ctx: { db: any },
  args: { team_id: string; dryRun?: boolean; roleIndex?: number; cursor?: string; numItems?: number },
) {
  const dryRun = args.dryRun ?? true;
  const roles: any[] = (await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", args.team_id)).collect())
    .sort((x: any, y: any) => String(x._id).localeCompare(String(y._id)));
  const roleIndex = args.roleIndex ?? 0;
  const role = roles[roleIndex];
  if (!role) return { dryRun, released: 0, sessions: [] as string[], next: null };
  const page = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id))
    .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 100 });
  const sessions: string[] = [];
  for (const c of page.page as any[]) {
    if (c.org_role_hold !== "bound" || c.role_started || c.standing_role_id || c.anchor_id) continue;
    if (c.status !== "active" || c.inbox_killed_at) continue;
    sessions.push(c.short_id ?? String(c._id).slice(0, 7));
    if (!dryRun) await ctx.db.patch(c._id, { org_role_id: undefined, org_role_hold: undefined });
  }
  const next = !page.isDone
    ? { roleIndex, cursor: page.continueCursor as string }
    : roleIndex + 1 < roles.length ? { roleIndex: roleIndex + 1, cursor: undefined } : null;
  return { dryRun, role: role.handle as string, released: sessions.length, sessions, next };
}
