// org.where: where one session sits in the organization, for the session
// itself to read (`cast org where`, and the org context injected at session
// start). The work it is bound to, the role that answers for that work by the
// ownership rule (org-staffing.md S26, S35) with the card a role's wake
// carries and the chain above it to a person, the session that spawned it,
// and every other role with what it looks after. An agent cannot send a thing
// to whoever can act on it without seeing who that is.
//
// Folders decide nothing here either: a session bound to no task or plan sits
// under no role, whatever directory it runs in.
import { v } from "convex/values";
import { query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { isWholeWorkspaceRole, ownerOf } from "@codecast/shared/contracts/orgLead";
import type { OrgSeatHow, OrgWhere } from "@codecast/shared/contracts/orgWhere";
import { getAuthenticatedUserId } from "./pendingMessages";
import { computeOrgRoles, requireWorkspaceCaller } from "./org";
import { roleCardOf } from "./agentTasks";
import { sessionWork } from "./lib/orgOwnership";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { activeTeamMembershipFor } from "./lib/access";
import { personName } from "./sessionOwnership";

type Ref = OrgWhere["work"]["task"];

export const where = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), session: v.optional(v.string()) },
  handler: async (ctx, args): Promise<OrgWhere | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv: any = args.session
      ? await findConversationByAnyRefWhere(ctx, args.session, (c: any) => String(c.user_id) === String(userId))
      : null;
    // The session's own team first: the org it works in is the one its work
    // is routed to, whichever team the person is looking at.
    const teamId: Id<"teams"> | undefined = args.team_id ?? conv?.team_id ?? (await activeTeamMembershipFor(ctx, userId))?.teamId;
    if (!(await requireWorkspaceCaller(ctx, args.api_token, teamId))) return null;
    return computeOrgWhere(ctx, userId, teamId, conv);
  },
});

/** The reading behind org.where, for a caller already let into the workspace. */
export async function computeOrgWhere(ctx: { db: any }, userId: Id<"users">, teamId: Id<"teams"> | undefined, conv: any): Promise<OrgWhere | null> {
  const org = await computeOrgRoles(ctx, userId, teamId, Date.now());
  const roles: any[] = org.roles.filter((r: any) => r.status !== "retired");
  if (!roles.length) return null;
  const byId = new Map(roles.map((r) => [String(r._id), r]));

  const work = conv ? await sessionWork(ctx, conv) : {};
  const bound = !!(work.project_id || work.plan_id);
  const [task, plan, project]: any[] = await Promise.all([
    conv?.active_task_id ? ctx.db.get(conv.active_task_id) : null,
    work.plan_id ? ctx.db.get(work.plan_id as any) : null,
    work.project_id ? ctx.db.get(work.project_id as any) : null,
  ]);

  let how: OrgSeatHow = "none";
  let seatRoles: any[] = [];
  const standing = conv?.standing_role_id && byId.get(String(conv.standing_role_id));
  const filed = conv?.org_role_id && byId.get(String(conv.org_role_id));
  if (standing) { how = "standing"; seatRoles = [standing]; }
  else if (filed) { how = "filed"; seatRoles = [filed]; }
  else if (bound) {
    const owner = ownerOf(work, roles);
    if (owner.kind === "owner") { how = "owner"; seatRoles = [owner.role]; }
    else if (owner.kind === "watchers") { how = "shared"; seatRoles = owner.roles; }
  }

  const reportsToName = async (to: any): Promise<string> => {
    if (to?.kind === "role") { const r = byId.get(String(to.role_id)); return r ? `@${r.handle}` : ""; }
    if (to?.kind === "user") return personName(await ctx.db.get(to.user_id));
    return "";
  };
  const chain: string[] = [];
  if (seatRoles.length === 1) {
    const seen = new Set<string>();
    let at = seatRoles[0];
    while (at && !seen.has(String(at._id))) {
      seen.add(String(at._id));
      const name = await reportsToName(at.reports_to);
      if (name) chain.push(name);
      at = at.reports_to?.kind === "role" ? byId.get(String(at.reports_to.role_id)) : null;
    }
  }

  const lead: any = conv?.parent_conversation_id ? await ctx.db.get(conv.parent_conversation_id) : null;
  const person: any = conv ? await ctx.db.get(conv.owner_user_id ?? conv.user_id) : null;
  const ref = (row: any): Ref => (row ? { short_id: row.short_id ?? null, title: row.title ?? "" } : null);
  const seatIds = new Set(seatRoles.map((r) => String(r._id)));

  return {
    workspace: org.workspace,
    session: conv
      ? { short_id: conv.short_id ?? null, title: conv.title ?? null, person: person ? personName(person) : null, lead: lead ? { short_id: lead.short_id ?? null, title: lead.title ?? null } : null }
      : null,
    work: { task: ref(task), plan: ref(plan), project: ref(project) },
    seat: { how, handles: seatRoles.map((r) => r.handle) },
    card: seatRoles.length === 1 ? await roleCardOf(ctx, seatRoles[0]._id) : null,
    chain,
    roles: await Promise.all(roles.map(async (r) => ({
      handle: r.handle,
      name: r.name,
      reports_to: await reportsToName(r.reports_to),
      scope: [...r.scope_names.projects, ...r.scope_names.plans].map((s: any) => s.title).filter(Boolean),
      whole_workspace: isWholeWorkspaceRole(r),
      seat: seatIds.has(String(r._id)),
    }))),
    people: org.people.map((p: any) => ({ name: p.name, role: p.role, is_me: p.is_me })),
  };
}
