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

// The one seat per company that reviews the chart (org-staffing.md S6, S12).
// A leaf constant so anchors.ts and mentionResolve.ts can name the seat
// without importing orgRoles.ts, which imports both of them.
export const CHIEF_OF_STAFF_HANDLE = "chief-of-staff";

// A role ref from the CLI is "or-N" or a raw id; the web passes ids.
export async function resolveRoleRef(ctx: { db: any }, ref: string): Promise<any | null> {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return null;
  const byShort = await ctx.db
    .query("org_roles")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed))
    .first();
  if (byShort) return byShort;
  const id = typeof ctx.db.normalizeId === "function" ? ctx.db.normalizeId("org_roles", trimmed) : trimmed;
  if (!id) return null;
  try { return await ctx.db.get(id); } catch { return null; }
}

// The role behind a ref, gated: "access" for any member of its boundary,
// "admin" for the host, the personal owner or a team admin.
export async function requireRole(ctx: { db: any }, userId: Id<"users">, ref: string, gate: "access" | "admin"): Promise<any> {
  const role = await resolveRoleRef(ctx, ref);
  if (!role) throw new Error("Role not found");
  const ok = gate === "admin" ? await userCanAdminRole(ctx, userId, role) : await userCanAccessRole(ctx, userId, role);
  if (!ok) throw new Error(gate === "admin" ? "Only an admin (or the host) can reshape this role" : "Role not found");
  return role;
}

// Live roles in an access boundary: a team's, or a person's own.
export async function rolesInBoundary(ctx: { db: any }, seat: { team_id?: any; scope_user_id?: any }): Promise<any[]> {
  const rows: any[] = seat.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", seat.team_id)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", seat.scope_user_id)).collect();
  return rows.filter((r) => r.status !== "retired");
}

// Every live role answering to a handle in one boundary. A retired role keeps
// its handle (the handle is freed for reuse on purpose), and the handle index
// orders equal keys by creation, so `.first()` hands back the OLDEST row: after
// a retire and a hire again that is the retired seat. Every lookup by handle
// goes through here so none of them can name a dead role.
export async function liveRolesByHandle(ctx: { db: any }, boundary: { team_id?: any; scope_user_id?: any }, handle: string): Promise<any[]> {
  const h = handle.replace(/^@/, "").trim().toLowerCase();
  if (!h || (!boundary.team_id && !boundary.scope_user_id)) return [];
  const rows: any[] = boundary.team_id
    ? await ctx.db.query("org_roles").withIndex("by_team_handle", (q: any) => q.eq("team_id", boundary.team_id).eq("handle", h)).collect()
    : await ctx.db.query("org_roles").withIndex("by_scope_user_handle", (q: any) => q.eq("scope_user_id", boundary.scope_user_id).eq("handle", h)).collect();
  return rows.filter((r) => r.status !== "retired");
}

export async function liveRoleByHandle(ctx: { db: any }, boundary: { team_id?: any; scope_user_id?: any }, handle: string): Promise<any | null> {
  return (await liveRolesByHandle(ctx, boundary, handle))[0] ?? null;
}

// The company's chief of staff, when one stands in the boundary.
export async function chiefOfStaffIn(ctx: { db: any }, seat: { team_id?: any; scope_user_id?: any }): Promise<any | null> {
  return liveRoleByHandle(ctx, seat, CHIEF_OF_STAFF_HANDLE);
}
