// Who an addressed decision reaches (docs/architecture/org-staffing.md S33,
// `cast decide --to`). A leaf under sessionDecisions.

import type { Id } from "../_generated/dataModel";
import { teamVisibleConvTeam } from "../privacy";

// The people a `to` names, inside the session's workspace: a team session
// resolves against its members, a personal one against its owner. A ref that
// names nobody is an error, never a silent drop onto the default route.
export async function resolveAskedPeople(ctx: { db: any }, conversation: any, to: string[]): Promise<{ people: Id<"users">[] } | { error: string }> {
  const teamId = teamVisibleConvTeam(conversation);
  const candidates: any[] = [];
  if (teamId) {
    const rows = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
    for (const m of rows) { const u = await ctx.db.get(m.user_id); if (u && !u.is_bot) candidates.push(u); }
  } else {
    const u = await ctx.db.get(conversation.owner_user_id ?? conversation.user_id);
    if (u) candidates.push(u);
  }
  const people: Id<"users">[] = [];
  for (const raw of to) {
    const needle = raw.trim().replace(/^@/, "").toLowerCase();
    if (!needle) continue;
    const hit = candidates.find((u) => String(u._id) === raw.trim() || (u.email ?? "").toLowerCase() === needle || (u.name ?? "").toLowerCase() === needle || (u.email ?? "").toLowerCase().split("@")[0] === needle);
    if (!hit) return { error: `--to ${raw}: no person by that name or email in this workspace` };
    if (!people.some((id) => String(id) === String(hit._id))) people.push(hit._id);
  }
  if (!people.length) return { error: "--to names nobody" };
  return { people };
}
