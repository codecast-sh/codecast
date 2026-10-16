// A person reports to a person (the org chart's people layer). The fact is one
// field on the report's team membership, `reports_to_user_id`, read by the org
// tree (org.ts) and through it the chart and the inbox's By reports lens. It is
// routing only: who a person reports to never changes what anyone can read.
import { mutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { requireWorkspaceFeature } from "./lib/teamFeatureGuard";
import { refuseUnlessHuman } from "./orgRoles";

type Ctx = { db: any };

// Long enough for any real chain; a corrupt one cannot spin.
const MAX_PERSON_DEPTH = 64;

async function membershipOf(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams">): Promise<any | null> {
  return await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
}

/** The member ids of a team mapped to who each reports to, keeping only a
 *  manager who is still a member. A pointer to someone who left reads as no
 *  manager, so nothing has to chase membership deletes. */
export function personReportsToMap(memberships: Array<{ user_id: any; reports_to_user_id?: any }>): Map<string, string> {
  const members = new Set(memberships.map((m) => String(m.user_id)));
  const out = new Map<string, string>();
  for (const m of memberships) {
    const to = m.reports_to_user_id ? String(m.reports_to_user_id) : null;
    if (to && to !== String(m.user_id) && members.has(to)) out.set(String(m.user_id), to);
  }
  return out;
}

export type ReparentPersonArgs = { team_id: Id<"teams">; user_id: Id<"users">; reports_to_user_id: Id<"users"> | null };

/**
 * Set who `user_id` reports to (null: nobody). Who may: a team admin, the
 * person themself, or the manager they move under; the current manager may
 * also let a report go (set null). Both must be members of the team, and the
 * move may not close a loop.
 */
export async function performReparentPerson(ctx: Ctx, callerId: Id<"users">, args: ReparentPersonArgs): Promise<{ user_id: Id<"users">; reports_to_user_id: Id<"users"> | null; changed: boolean }> {
  const { team_id, user_id } = args;
  const to = args.reports_to_user_id;
  const [caller, subject] = await Promise.all([membershipOf(ctx, callerId, team_id), membershipOf(ctx, user_id, team_id)]);
  if (!caller) throw new Error("Not a member of this team");
  if (!subject) throw new Error("That person is not a member of this team");
  const current: Id<"users"> | null = subject.reports_to_user_id ?? null;
  const isAdmin = caller.role === "admin";
  const me = String(callerId);
  const allowed = isAdmin || me === String(user_id) || (to !== null && me === String(to)) || (to === null && current !== null && me === String(current));
  if (!allowed) throw new Error("Only a team admin, the person, or their new manager can change who someone reports to");
  if (to !== null) {
    if (String(to) === String(user_id)) throw new Error("A person cannot report to themself");
    if (!(await membershipOf(ctx, to, team_id))) throw new Error("A person can only report to a member of the same team");
    const all = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team_id)).collect();
    const up = personReportsToMap(all);
    let cur: string | undefined = String(to);
    for (let depth = 0; cur && depth < MAX_PERSON_DEPTH; depth++) {
      if (cur === String(user_id)) throw new Error("Cycle: that person already reports to them");
      cur = up.get(cur);
    }
  }
  if (String(current ?? "") === String(to ?? "")) return { user_id, reports_to_user_id: to, changed: false };
  await ctx.db.patch(subject._id, { reports_to_user_id: to ?? undefined });
  return { user_id, reports_to_user_id: to, changed: true };
}

// The chart's drag and its menu. A person's act, like every staffing change.
export const reparentPerson = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.id("teams"),
    user_id: v.id("users"),
    reports_to_user_id: v.union(v.id("users"), v.null()),
  },
  handler: async (ctx, { api_token, ...args }) => {
    await refuseUnlessHuman(ctx, { api_token }, "Staffing");
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    await requireWorkspaceFeature(ctx, { team_id: args.team_id, user_id: userId }, "org");
    return performReparentPerson(ctx, userId, args);
  },
});
