import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import type { Id } from "./_generated/dataModel";
import { allRolesInBoundary, CHIEF_OF_STAFF_HANDLE, chiefOfStaffIn } from "./lib/orgAccess";
import { performStaff } from "./orgRoles";

// One agent at the root (docs/architecture/org-staffing.md S22). A workspace
// that has a standing agent (an anchors row with no role pointer) and no root
// role gets one: the anchor's session is seated as the Chief of Staff through
// the same seating `cast org staff` uses (S16), so nothing restarts and every
// alias keeps working. Personal workspaces too. Idempotent: a seated anchor
// carries `org_role_id` and is passed over on the next run.
//
// `planRootSeats` is the read-only half: it names every workspace the run
// would touch and why some are left alone, so the run can be read before it
// is made. `seatRootRoles` applies that plan, all or nothing: a seating that
// fails throws out of the mutation, so no workspace is left with a Chief of
// Staff row and no seat; the plan is read first, and a failed run is fixed
// and run again.

export type RootSeatAction =
  | "seat"          // a live anchor with a session and no root role: seat it
  | "retired_root"  // the same, where a person retired an earlier root and kept the agent: seated under a fresh root
  | "seated"        // already a role's seat (org_role_id set)
  | "no_session"    // the anchor never came online; nothing to seat
  | "dead_session"  // its session completed; the row is a leftover
  | "two_roots";    // a root role already stands in another session; a person decides

export type RootSeatRow = {
  anchor_id: Id<"anchors">;
  workspace: string;
  kind: "team" | "user";
  host: string;
  conversation: string | null;
  action: RootSeatAction;
  root_role?: string;
  /** The retired root this seat replaces (`retired_root` only). */
  retired_root?: { short_id: string; handle: string };
};

export const ROOT_SEAT_ACTIONS_THAT_SEAT: ReadonlySet<RootSeatAction> = new Set(["seat", "retired_root"]);

async function nameOf(ctx: { db: any }, id: Id<"users"> | undefined): Promise<string> {
  const u = id ? await ctx.db.get(id) : null;
  return u?.name || u?.github_username || u?.email || String(id ?? "?");
}

export async function planRootSeats(ctx: { db: any }): Promise<RootSeatRow[]> {
  const anchors: any[] = await ctx.db.query("anchors").collect();
  const out: RootSeatRow[] = [];
  for (const a of anchors) {
    if (a.status === "decommissioned") continue;
    const boundary = a.team_id ? { team_id: a.team_id } : { scope_user_id: a.scope_user_id };
    const workspace = a.team_id ? ((await ctx.db.get(a.team_id))?.name ?? String(a.team_id)) : `${await nameOf(ctx, a.scope_user_id)} (personal)`;
    const conv = a.conversation_id ? await ctx.db.get(a.conversation_id) : null;
    const row: RootSeatRow = {
      anchor_id: a._id,
      workspace,
      kind: a.scope_type,
      host: await nameOf(ctx, a.host_user_id),
      conversation: conv?.short_id ?? null,
      action: "seat",
    };
    const chief = await chiefOfStaffIn(ctx, boundary);
    if (chief) row.root_role = chief.short_id;
    if (a.org_role_id) row.action = "seated";
    else if (!conv) row.action = "no_session";
    else if (conv.status === "completed") row.action = "dead_session";
    else if (chief?.anchor_id && String(chief.anchor_id) !== String(a._id)) {
      const seat = await ctx.db.get(chief.anchor_id);
      if (seat && seat.status !== "decommissioned") row.action = "two_roots";
    }
    // A root a person retired while keeping the agent: the workspace still
    // gets a named root (S22), but the plan says which seat it replaces.
    if (row.action === "seat" && !chief) {
      const retired = (await allRolesInBoundary(ctx, boundary)).filter((r) => r.handle === CHIEF_OF_STAFF_HANDLE && r.status === "retired").sort((x, y) => (y.updated_at ?? 0) - (x.updated_at ?? 0))[0];
      if (retired) { row.action = "retired_root"; row.retired_root = { short_id: retired.short_id, handle: retired.handle }; }
    }
    out.push(row);
  }
  return out;
}

export async function performSeatRootRoles(ctx: any, dryRun: boolean): Promise<{ dry_run: boolean; rows: RootSeatRow[]; seated: number }> {
  const rows = await planRootSeats(ctx);
  let seated = 0;
  if (!dryRun) {
    for (const row of rows) {
      if (!ROOT_SEAT_ACTIONS_THAT_SEAT.has(row.action)) continue;
      const a = await ctx.db.get(row.anchor_id);
      // The host is the person the role reports to and the one who seats
      // it: the seating note reads as theirs, and the role's admin is the
      // person who already runs the agent. A failure here propagates, so
      // the whole run rolls back with it.
      const out = await performStaff(ctx, a.host_user_id, { team_id: a.team_id ?? undefined, seat: "existing", project_path: a.project_path ?? undefined });
      row.root_role = out.role.short_id;
      row.action = "seated";
      seated++;
    }
  }
  return { dry_run: dryRun, rows, seated };
}

// Read only: which workspaces the run would touch, and why the rest are left.
// `npx convex run orgRootSeat:rootSeatPlan` (through packages/convex/deploy.sh's env).
export const rootSeatPlan = internalQuery({
  args: {},
  handler: async (ctx) => planRootSeats(ctx),
});

// Run once: `npx convex run orgRootSeat:seatRootRoles '{"dry_run":true}'`, then without.
export const seatRootRoles = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => performSeatRootRoles(ctx, !!args.dry_run),
});
