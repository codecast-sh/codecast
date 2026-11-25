// A role's reporting line (D2): the roles from a role up to the first person,
// and the workspace's admins, who are asked when a line ends at nobody. A leaf
// (reads only), so the needs-input push and the inbox can resolve who a wait
// reaches without importing the decision machinery.
import type { Doc, Id } from "../_generated/dataModel";
import { roleManagers } from "@codecast/shared/contracts/orgLead";

type Ctx = { db: any };

export type Hop = { role_id: Id<"org_roles">; recommendation?: number; note?: string; at: number; passed_at?: number };

// The ladder (D2): the roles from the asker up to the people its lines end
// at. A role may report to several managers, all equal (org-people.md P3), so
// the walk follows every line, nearest first and the drawn line (reports_to)
// first at each step. A paused or retired role is recorded as a skipped hop so
// the card can show the gap; only active roles may recommend, and only the
// first is told (routeFor). `firstPersonId` is the person the drawn line ends
// at; `people` is every person any line reaches.
export async function buildLadder(
  ctx: Ctx,
  startRole: Doc<"org_roles"> | null,
  now: number,
): Promise<{ hops: Hop[]; firstPersonId?: Id<"users">; people: Id<"users">[]; activeRoles: Doc<"org_roles">[] }> {
  const hops: Hop[] = [];
  const activeRoles: Doc<"org_roles">[] = [];
  const people: Id<"users">[] = [];
  const seen = new Set<string>();
  let firstPersonId: Id<"users"> | undefined;
  // The drawn line first, so its person is found the way it always was.
  for (let cur = startRole, depth = 0; cur && depth < 32; depth++) {
    if (cur.reports_to.kind === "user") { firstPersonId = cur.reports_to.user_id; break; }
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  const queue: Array<Doc<"org_roles"> | null> = [startRole];
  while (queue.length && seen.size < 32) {
    const cur = queue.shift();
    if (!cur || seen.has(String(cur._id))) continue;
    seen.add(String(cur._id));
    if (cur.status === "active") {
      hops.push({ role_id: cur._id, at: now });
      activeRoles.push(cur);
    } else {
      hops.push({ role_id: cur._id, note: `skipped: ${cur.status}`, at: now });
    }
    for (const p of roleManagers(cur)) {
      if (p.kind === "user") { if (!people.some((id) => String(id) === String(p.user_id))) people.push(p.user_id); }
      else queue.push(await ctx.db.get(p.role_id));
    }
  }
  return { hops, firstPersonId, people, activeRoles };
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
