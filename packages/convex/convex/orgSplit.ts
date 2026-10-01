// Split a role into two leads (docs/architecture/org-staffing.md S34): one
// gesture, on the role page or `cast role split`, that turns one role into two
// roles with disjoint scopes split by projects or plans, both reporting where
// the original did, each receiving the knowledge handoff of S32 for its half.
// The original gives up its area at once (so the halves own it from this
// moment), keeps its session for the handoff, and retires when the handoff
// lands or its deadline passes. A person's act, like every staffing change.

import { mutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { requireRole } from "./lib/orgAccess";
import { getAuthenticatedUserId } from "./pendingMessages";
import { performCreateRole, performProvisionRole, performRetireRole, refuseUnlessHuman, resolveScopeRef, standingConversationOf } from "./orgRoles";
import { beginAreaHandoff, type AreaMove } from "./orgHandoff";
import { EMPTY_SCOPE } from "./lib/orgScope";

export type SplitHalf = { name: string; handle: string; avatar?: string; refs: string[] };
export type SplitArgs = {
  role_id: string;
  halves: [SplitHalf, SplitHalf] | SplitHalf[];
  standing_session?: "keep" | "retire";
  from_session?: string;
  api_token?: string;
  human_decision?: string;
};

type Resolved = { kind: "project"; id: Id<"projects"> } | { kind: "plan"; id: Id<"plans"> };
const key = (r: { kind: string; id: unknown }) => `${r.kind}:${String(r.id)}`;

/** The two scopes a split names, checked against the original's: disjoint,
 *  each non empty, and together the whole of it. Pure over resolved refs so
 *  the CLI and the page can preview the same partition. */
export function partitionScopes(
  original: { project_ids: unknown[]; plan_ids: unknown[] },
  halves: Array<{ handle: string; items: Resolved[] }>,
): Array<{ project_ids: Id<"projects">[]; plan_ids: Id<"plans">[] }> {
  if (halves.length !== 2) throw new Error("A split makes exactly two roles");
  if (halves[0].handle === halves[1].handle) throw new Error("The two roles need different handles");
  const all = new Set([...original.project_ids.map((id) => `project:${String(id)}`), ...original.plan_ids.map((id) => `plan:${String(id)}`)]);
  if (!all.size) throw new Error("This role names no area to split: give it projects or plans first, or hire two roles instead");
  const seen = new Map<string, string>();
  for (const h of halves) {
    if (!h.items.length) throw new Error(`@${h.handle} would own nothing: name at least one project or plan for it`);
    for (const it of h.items) {
      const k = key(it);
      if (!all.has(k)) throw new Error(`${k} is not in the role's area; a split only divides what the role has`);
      const other = seen.get(k);
      if (other && other !== h.handle) throw new Error(`${k} is named for both @${other} and @${h.handle}; the halves must not overlap`);
      seen.set(k, h.handle);
    }
  }
  const left = [...all].filter((k) => !seen.has(k));
  if (left.length) throw new Error(`Say where ${left.join(", ")} goes: every project and plan of the role lands in one of the two`);
  return halves.map((h) => ({
    project_ids: h.items.filter((i): i is Extract<Resolved, { kind: "project" }> => i.kind === "project").map((i) => i.id),
    plan_ids: h.items.filter((i): i is Extract<Resolved, { kind: "plan" }> => i.kind === "plan").map((i) => i.id),
  }));
}

export async function performSplitRole(ctx: any, userId: Id<"users">, args: SplitArgs): Promise<any> {
  await refuseUnlessHuman(ctx, args, "Splitting a role");
  const role = await requireRole(ctx, userId, args.role_id, "admin");
  if (role.status === "retired") throw new Error("That role is retired");
  if (role.handing_over) throw new Error(`@${role.handle} is already handing its area over; wait for that to close or close it first`);
  if (isHeadOfPeopleRole(role) || role.chief) throw new Error("The Head of People and a Chief of Staff own no area to split: hire leads for the areas instead");
  // Refs resolve inside the original's boundary, the way `cast role scope` reads them.
  const halves = [] as Array<{ handle: string; items: Resolved[] }>;
  for (const h of args.halves) {
    const items: Resolved[] = [];
    for (const ref of h.refs) items.push(await resolveScopeRef(ctx, role, /^(project|plan):/.test(ref) ? ref : `project:${ref}`));
    halves.push({ handle: h.handle, items });
  }
  const scopes = partitionScopes(role.scope, halves);
  const now = Date.now();
  const standing = await standingConversationOf(ctx, role);
  // The original lets go of its area first, so the halves are born owning it
  // by the rule (a role born beside another that lists the same project
  // would be one of two watchers, and nobody would own it).
  await ctx.db.patch(role._id, { scope: EMPTY_SCOPE, updated_at: now });
  await ctx.db.insert("org_role_history", { role_id: role._id, user_id: userId, actor_type: "user", action: "split", field: "scope", old_value: JSON.stringify({ project_ids: role.scope.project_ids.map(String), plan_ids: role.scope.plan_ids.map(String) }), new_value: JSON.stringify({ project_ids: [], plan_ids: [] }), created_at: now });
  const created: any[] = [];
  const moves: AreaMove[] = [];
  for (let i = 0; i < 2; i++) {
    const h = args.halves[i];
    const made = await performCreateRole(ctx, userId, {
      name: h.name,
      handle: h.handle,
      team_id: role.team_id ?? undefined,
      scope: scopes[i],
      reports_to: role.reports_to,
      charter: role.charter ?? undefined,
      review_backend: role.review_backend ?? undefined,
      avatar: h.avatar,
      host_user_id: role.host_user_id,
      handoff: false,
    });
    // The halves start work on their own as the original did, and run on
    // the same line.
    await ctx.db.patch(made._id, { trust: role.trust, caps: role.caps, line_workflow_slug: role.line_workflow_slug, line_merge: role.line_merge, tenure: role.tenure, updated_at: now });
    let seated: any = null;
    if (standing) {
      seated = await performProvisionRole(ctx, userId, { role_id: String(made._id), project_path: standing.project_path ?? undefined, agent_type: standing.agent_type ?? undefined, model: standing.model ?? undefined }).catch((err: any) => ({ error: err?.message ?? String(err) }));
    }
    const row = await ctx.db.get(made._id);
    created.push({ ...row, provisioned: seated && !seated.error, provision_error: seated?.error ?? null });
    for (const id of scopes[i].project_ids) moves.push({ project_id: id, from: role, to: row });
    for (const id of scopes[i].plan_ids) moves.push({ plan_id: id, from: role, to: row });
  }
  // The knowledge handoff to each half (S32), with the retire waiting on it.
  const handoff = await beginAreaHandoff(ctx, userId, await ctx.db.get(role._id), moves, "split", { now, retire: { standing_session: args.standing_session } });
  const retired = handoff ? null : await performRetireRole(ctx, userId, { role_id: String(role._id), standing_session: args.standing_session, handoff: "skip" });
  return {
    original: { _id: role._id, short_id: role.short_id, handle: role.handle, name: role.name },
    roles: created.map((r) => ({ _id: r._id, short_id: r.short_id, handle: r.handle, name: r.name, scope: r.scope, provisioned: r.provisioned, provision_error: r.provision_error })),
    handoff: handoff ? { deadline: handoff.deadline, receivers: handoff.receivers, trigger_id: handoff.trigger_id } : null,
    retired: !!retired,
  };
}

export const split = mutation({
  args: {
    api_token: v.optional(v.string()),
    from_session: v.optional(v.string()),
    role_id: v.string(),
    halves: v.array(v.object({ name: v.string(), handle: v.string(), avatar: v.optional(v.string()), refs: v.array(v.string()) })),
    standing_session: v.optional(v.union(v.literal("keep"), v.literal("retire"))),
  },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performSplitRole(ctx, userId, { ...args, api_token });
  },
});
