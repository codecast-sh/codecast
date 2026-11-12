// The one write of a conversation's visibility fields (CLAUDE.md "Workspace
// access vs routing"): it patches the row, drops the session from a role its
// team can no longer see, records the authority event and rewrites the stored
// workspace key of every linked work item.
//
// It lives apart from lib/access.ts on purpose. Dropping a session from its
// role reaches sessionOwnership, which reaches most of the function modules;
// with this function inside access.ts, the 64 modules that import access.ts
// for a read check all joined one import cycle, and every function in them
// loaded the same 3.26 MB bundle (ct-92329). Keep access.ts free of imports
// that lead back into the function modules.
import type { Scheduler } from "convex/server";
import { Id } from "../_generated/dataModel";
import { roleDropForVisibility } from "./sessionTell";
import { recomputeWorkspaceForConversation } from "./access";
import { recordAuthorityEvent } from "./authorityEvents";
import { invalidateForConversation } from "./changesDirty";
import { restampDecisionTeams } from "./decisionTeam";

type AccessCtx = { db: any; scheduler?: Scheduler };

/**
 * Patch a conversation's visibility fields AND propagate the resulting access
 * key to linked work items in one call. Every visibility-changing write
 * (share, unshare, lock private, late path restamp, reparent) MUST go through
 * here — a raw ctx.db.patch of is_private / team_visibility / team_id /
 * auto_shared leaves linked tasks/plans/docs with a stale stored key.
 * Returns the number of work items rewritten.
 */
export async function patchConversationVisibility(
  ctx: AccessCtx,
  conversation: {
    _id: Id<"conversations">;
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
  updates: Record<string, any>,
  /** Who moved it; the owner when the caller does not know (a sweep, a late
   *  path restamp). Every visibility move is an authority event. */
  actor: Id<"users"> = conversation.user_id,
): Promise<number> {
  // A team role may hold only a session its team can see: a session that
  // stops being visible leaves the role, and its escalation, in this same
  // patch (org-roles-run-work.md R1, revised).
  // A static import. The Convex runtime refuses a dynamic import() ("dynamic
  // module import unsupported"), which took every share, unshare, lock-private
  // and retroactive directory share down with it from 2026-09-22. Nothing
  // under sessionOwnership imports this module, and convex/moduleLoad.test.ts
  // imports every entry to keep it that way.
  const drop = await roleDropForVisibility(ctx, { ...conversation, ...updates });
  await ctx.db.patch(conversation._id, drop ? { ...updates, ...drop.patch } : updates);
  if (drop) await drop.tell();
  const after = { ...conversation, ...updates };
  const VIS = ["is_private", "team_visibility", "team_id", "auto_shared"] as const;
  const pick = (row: Record<string, any>) => Object.fromEntries(VIS.filter((k) => k in updates).map((k) => [k, row[k]]));
  await recordAuthorityEvent(ctx, {
    kind: "conversation_visibility_changed",
    actor_user_id: actor,
    conversation: after,
    detail: { before: pick(conversation), after: pick(after) },
  });
  await invalidateForConversation(ctx, after);
  await refreshViewingAccess(ctx, after);
  // A decision's team is routing (lib/decisionTeam.ts): it follows the conversation to its new team.
  if ("team_id" in updates && String(updates.team_id ?? "") !== String(conversation.team_id ?? "")) await restampDecisionTeams(ctx, conversation._id);
  return recomputeWorkspaceForConversation(ctx, after);
}

// Presence rows naming this conversation carry a copy of its access fields
// (viewingAccessStamp); a visibility move rewrites them in the same mutation,
// so the roster's gate never runs on a stale copy.
async function refreshViewingAccess(
  ctx: AccessCtx,
  conv: { _id: Id<"conversations">; team_id?: Id<"teams">; is_private?: boolean; team_visibility?: string },
): Promise<void> {
  const rows = await ctx.db
    .query("user_presence")
    .withIndex("by_viewing_conversation", (q: any) => q.eq("viewing_conversation_id", conv._id))
    .collect();
  const moved: Record<string, any> = {};
  if ("team_id" in conv) moved.team_id = conv.team_id;
  if ("is_private" in conv) moved.is_private = conv.is_private !== false;
  if ("team_visibility" in conv) moved.team_visibility = conv.team_visibility;
  for (const row of rows) {
    if (!row.viewing_access) continue;
    await ctx.db.patch(row._id, { viewing_access: { ...row.viewing_access, ...moved } });
  }
}
