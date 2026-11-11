import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import type { Id } from "../_generated/dataModel";

// The anchors a caller may see/act on: their personal anchor plus the team anchor
// of every team they belong to, deduped and excluding decommissioned. Shared by
// listAnchors and the Slack channel listing so the two can't drift.
export async function visibleAnchorsForUser(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<any[]> {
  const personal = await ctx.db
    .query("anchors")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  // The org feature is per team, default off (teams.features.org): a team
  // with it off shows none of its seats, and the personal workspace shows its
  // own seats only while some team of the person's has it on (the shared
  // workspaceFeatureEnabled rule). Bot users reach every roster, chat member
  // list and face row through this function, so this is where they stop.
  const teams = await Promise.all(memberships.map((m: any) => ctx.db.get(m.team_id)));
  const orgOnFor = new Set(
    teams.filter((t: any) => t && workspaceFeatureEnabled([t], t._id, "org")).map((t: any) => t._id.toString()),
  );
  const personalOrgOn = workspaceFeatureEnabled(teams, null, "org");
  const teamAnchors: any[] = [];
  for (const m of memberships) {
    if (!orgOnFor.has(m.team_id.toString())) continue;
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_team", (q: any) => q.eq("team_id", m.team_id))
      .collect();
    teamAnchors.push(...rows);
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of [...(personalOrgOn ? personal : []), ...teamAnchors]) {
    if (a.status === "decommissioned") continue;
    if (seen.has(a._id.toString())) continue;
    seen.add(a._id.toString());
    out.push(a);
  }
  return out;
}
