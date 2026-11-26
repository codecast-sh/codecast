// A role's reporting line (D2): the roles from a role up to the first person,
// and the workspace's admins, who are asked when a line ends at nobody. A leaf
// (reads only), so the needs-input push and the inbox can resolve who a wait
// reaches without importing the decision machinery.
import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

export type Hop = { role_id: Id<"org_roles">; recommendation?: number; note?: string; at: number; passed_at?: number };

// The ladder (D2): the roles from the asker up to the first person. A paused
// or retired role is recorded as a skipped hop so the card can show the gap;
// only active roles may recommend, and only the first is told (routeFor).
export async function buildLadder(
  ctx: Ctx,
  startRole: Doc<"org_roles"> | null,
  now: number,
): Promise<{ hops: Hop[]; firstPersonId?: Id<"users">; activeRoles: Doc<"org_roles">[] }> {
  const hops: Hop[] = [];
  const activeRoles: Doc<"org_roles">[] = [];
  const seen = new Set<string>();
  let cur = startRole;
  let firstPersonId: Id<"users"> | undefined;
  while (cur && !seen.has(cur._id) && seen.size < 32) {
    seen.add(cur._id);
    if (cur.status === "active") {
      hops.push({ role_id: cur._id, at: now });
      activeRoles.push(cur);
    } else {
      hops.push({ role_id: cur._id, note: `skipped: ${cur.status}`, at: now });
    }
    if (cur.reports_to.kind === "user") {
      firstPersonId = cur.reports_to.user_id;
      break;
    }
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  return { hops, firstPersonId, activeRoles };
}

export async function workspaceAdmins(ctx: Ctx, teamId: Id<"teams"> | undefined): Promise<Id<"users">[]> {
  if (!teamId) return [];
  const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const admins: Id<"users">[] = [];
  for (const m of members) {
    if (m.role !== "admin") continue;
    const u = await ctx.db.get(m.user_id);
    if (u && !u.is_bot) admins.push(m.user_id);
  }
  return admins;
}
