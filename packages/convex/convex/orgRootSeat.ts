import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import type { Id } from "./_generated/dataModel";
import { chiefOfStaffIn } from "./lib/orgAccess";
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
// is made. `seatRootRoles` applies that plan.

export type RootSeatAction =
  | "seat"          // a live anchor with a session and no root role: seat it
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
};

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
    out.push(row);
  }
  return out;
}

export async function performSeatRootRoles(ctx: any, dryRun: boolean): Promise<{ dry_run: boolean; rows: RootSeatRow[]; seated: number; errors: Array<{ anchor_id: string; error: string }> }> {
  const rows = await planRootSeats(ctx);
  const errors: Array<{ anchor_id: string; error: string }> = [];
  let seated = 0;
  if (!dryRun) {
    for (const row of rows) {
      if (row.action !== "seat") continue;
      const a = await ctx.db.get(row.anchor_id);
      try {
        // The host is the person the role reports to and the one who seats
        // it: the seating note reads as theirs, and the role's admin is the
        // person who already runs the agent.
        const out = await performStaff(ctx, a.host_user_id, { team_id: a.team_id ?? undefined, seat: "existing", project_path: a.project_path ?? undefined });
        row.root_role = out.role.short_id;
        row.action = "seated";
        seated++;
      } catch (e: any) {
        errors.push({ anchor_id: String(row.anchor_id), error: e?.message ?? String(e) });
      }
    }
  }
  return { dry_run: dryRun, rows, seated, errors };
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
