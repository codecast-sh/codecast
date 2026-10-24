// The takeover a person's org write sets off, run just after that write
// (takeOverSessionsSoon in orgInit.ts). Finding the sessions reads every
// recent session of the workspace and their messages, which a query can do
// without conflicting with anything. The move then reads only the sessions it
// was handed, by id, so the team's message traffic cannot keep it from
// committing.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { moveTakenOver, takeoverCandidates } from "./orgInit";
import { resolveScope } from "./org";
import { rolesInBoundary } from "./orgRoles";
import { sessionsOwnedBy } from "./lib/orgOwnership";
import { isScopeless } from "./lib/orgScope";

const args = { user_id: v.id("users"), role_id: v.id("org_roles") };

export const candidates = internalQuery({
  args,
  handler: async (ctx, a) => {
    const plan = await takeoverCandidates(ctx as any, a.user_id, a.role_id);
    return plan ? plan.candidates.map((c) => c.raw._id) : [];
  },
});

export const move = internalMutation({
  args: { ...args, session_ids: v.array(v.id("conversations")) },
  handler: async (ctx, a) => {
    const role = await ctx.db.get(a.role_id);
    if (!role || role.status === "retired" || isScopeless(role.scope)) return null;
    const resolved = await resolveScope(ctx as any, a.user_id, { role_id: String(role._id) });
    if (!resolved) return null;
    const roles = await rolesInBoundary(ctx as any, role);
    // The rule is read again on each session as it stands now: one filed,
    // killed or moved since the search stays where it is.
    const rows = (await Promise.all(a.session_ids.map((id) => ctx.db.get(id)))).filter((c: any) => c && !c.inbox_killed_at).map((raw) => ({ raw }));
    const candidates = await sessionsOwnedBy(ctx as any, role, roles, rows);
    return moveTakenOver(ctx as any, a.user_id, { role, roles, resolved, candidates });
  },
});

export const run = internalAction({
  args,
  handler: async (ctx, a): Promise<void> => {
    const session_ids = await ctx.runQuery(internal.orgTakeover.candidates, a);
    await ctx.runMutation(internal.orgTakeover.move, { ...a, session_ids });
  },
});
