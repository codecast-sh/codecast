// Authorization for a scoped seat in the org: an anchor (a standing agent
// member) or an org role (docs/architecture/org-roles.md S2). Both carry the
// same boundary shape — the human host that runs it, the user a personal seat
// belongs to, and the team a shared seat is scoped to — so one rule answers
// "may this user see it" and "may this user reshape it" for both tables.
//
// Every ACT path gates on this — authentication alone is not enough (waking an
// anchor runs and bills code on the host's daemon; reparenting a role rewires
// the reporting structure for the whole team).

import { Id } from "../_generated/dataModel";

export type ScopedSeat = {
  host_user_id?: Id<"users">;
  scope_user_id?: Id<"users">;
  team_id?: Id<"teams">;
} | null;

// The grant: the host, the personal owner, or a member of the seat's team whose
// membership row `teamRoleAllows` accepts.
export async function roleGrants(
  ctx: { db: any },
  userId: Id<"users">,
  seat: ScopedSeat,
  teamRoleAllows: (m: any) => boolean,
): Promise<boolean> {
  if (!seat) return false;
  if (seat.host_user_id === userId) return true;
  if (seat.scope_user_id && seat.scope_user_id === userId) return true;
  if (seat.team_id) {
    const m = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) =>
        q.eq("user_id", userId).eq("team_id", seat.team_id),
      )
      .first();
    if (m && teamRoleAllows(m)) return true;
  }
  return false;
}

// See / use: any member of the seat's team.
export async function userCanAccessRole(
  ctx: { db: any },
  userId: Id<"users">,
  role: ScopedSeat,
): Promise<boolean> {
  return roleGrants(ctx, userId, role, () => true);
}

// Reshape (rename, reparent, retire, scope edit): the host, the personal
// owner, or a team ADMIN — not every member.
export async function userCanAdminRole(
  ctx: { db: any },
  userId: Id<"users">,
  role: ScopedSeat,
): Promise<boolean> {
  return roleGrants(ctx, userId, role, (m) => m.role === "admin");
}
