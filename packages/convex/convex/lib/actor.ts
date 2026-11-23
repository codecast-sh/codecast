// The one server side actor resolver (docs/architecture/org-roles-standing.md
// T4). A write that carries a calling conversation is recorded under the
// identity that conversation speaks as:
//
// - a role's standing session (conversations.standing_role_id) acts as the
//   role's bot user: task comments, status and assignee changes, plan entries,
//   doc writes, project updates and chat lines all wear the role's name;
// - a hand (conversations.org_role_id, a session that reports to a role)
//   keeps its host as the actor, and is still known to belong to the role so
//   the wake rail's loop rules can tell "the role's own work" from a
//   stranger's;
// - anything else is the person whose token made the call.
//
// One function, called from every write path, so the answer to "who did
// this" cannot drift between tables.

import { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };

export type Actor = {
  // The user the write is recorded under.
  user_id: Id<"users">;
  // Display name for author fields that store a string.
  name: string | undefined;
  kind: "user" | "role" | "hand" | "run";
  // The role the calling conversation belongs to (standing or hand), if any.
  role: Doc<"org_roles"> | null;
  anchor: any | null;
  conversation: any | null;
  // kind "run": the workflow run whose own session made the call. Its user_id is its owner (the machine's account).
  run?: Doc<"workflow_runs">;
};

/** The run a run's primary session speaks for, when the run still names it as its primary. */
async function runOfPrimary(ctx: Ctx, conversation: any): Promise<Doc<"workflow_runs"> | null> {
  const run = conversation?.workflow_run_id ? await ctx.db.get(conversation.workflow_run_id) : null;
  return run && String(run.primary_conversation_id ?? "") === String(conversation._id) ? run : null;
}

/** How a run signs what it writes: its flow's label ("Ship run"), else its name. */
export async function runVoiceName(ctx: Ctx, run: { workflow_id?: Id<"workflows"> | null; workflow_name?: string | null }): Promise<string> {
  const flow = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  const name = String(flow?.label || run.workflow_name || "Workflow").trim();
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} run`;
}

// The role a conversation belongs to: the one it IS (standing session) or the
// one it reports to (hand). Null for an ordinary session.
export async function roleOfConversation(ctx: Ctx, conversation: any): Promise<Doc<"org_roles"> | null> {
  const roleId = conversation?.standing_role_id ?? conversation?.org_role_id;
  return roleId ? await ctx.db.get(roleId) : null;
}

/** The role behind a run: its spawner is the role's standing session (L9). */
export async function roleOfRun(ctx: { db: any }, run: { spawner_conversation_id?: Id<"conversations"> | null; primary_conversation_id?: Id<"conversations"> | null }): Promise<any | null> {
  for (const id of [run.spawner_conversation_id, run.primary_conversation_id]) {
    if (!id) continue;
    const conv = await ctx.db.get(id);
    if (!conv) continue;
    const role = await roleOfConversation(ctx, conv);
    if (role) return role;
  }
  return null;
}

// The role a session works for: the one it is or reports to, else the role
// behind the workflow run it is a station of (a station has no role pointer
// of its own; its run's spawner or primary does).
export async function roleWorkedFor(ctx: Ctx, conversation: any): Promise<Doc<"org_roles"> | null> {
  const own = await roleOfConversation(ctx, conversation);
  if (own) return own;
  const run = conversation?.workflow_run_id ? await ctx.db.get(conversation.workflow_run_id) : null;
  if (!run) return null;
  return (run.org_role_id ? await ctx.db.get(run.org_role_id) : null) ?? await roleOfRun(ctx, run);
}

function displayName(user: any): string | undefined {
  return user?.name || user?.github_username || user?.email?.split("@")[0] || undefined;
}

export async function resolveActor(
  ctx: Ctx,
  callerUserId: Id<"users">,
  conversation: any | null | undefined,
): Promise<Actor> {
  const caller = await ctx.db.get(callerUserId);
  // Identity follows the token, not a client supplied id: a conversation the
  // caller does not RUN (user_id is the account whose daemon hosts it) is an
  // ordinary session for identity purposes. A standing session runs under
  // its host's token, so the role's own writes pass; a teammate naming the
  // standing session's id does not get to sign as the role.
  if (conversation && String(conversation.user_id) !== String(callerUserId)) {
    return { user_id: callerUserId, name: displayName(caller), kind: "user", role: null, anchor: null, conversation };
  }
  if (conversation?.standing_role_id) {
    const role = await ctx.db.get(conversation.standing_role_id);
    const anchor = role?.anchor_id ? await ctx.db.get(role.anchor_id) : null;
    if (anchor?.bot_user_id) {
      const bot = await ctx.db.get(anchor.bot_user_id);
      return {
        user_id: anchor.bot_user_id,
        name: displayName(bot) ?? role?.name,
        kind: "role",
        role: role ?? null,
        anchor,
        conversation,
      };
    }
  }
  // A run's own session (its primary, the voice its runner posts through) is the run: what it writes on a task
  // names the flow, never the person whose account and machine run it.
  if (conversation?.is_workflow_primary) {
    const run = await runOfPrimary(ctx, conversation);
    if (run) return { user_id: callerUserId, name: await runVoiceName(ctx, run), kind: "run", role: null, anchor: null, conversation, run };
  }
  if (conversation?.org_role_id) {
    const role = await ctx.db.get(conversation.org_role_id);
    return { user_id: callerUserId, name: displayName(caller), kind: "hand", role: role ?? null, anchor: null, conversation };
  }
  return { user_id: callerUserId, name: displayName(caller), kind: "user", role: null, anchor: null, conversation: conversation ?? null };
}

// Does `conversation` act for `roleId`: it is the role's standing session or
// one of its hands. The wake rail's first loop rule.
export function conversationActsForRole(conversation: any, roleId: string): boolean {
  if (!conversation) return false;
  return String(conversation.standing_role_id ?? "") === roleId || String(conversation.org_role_id ?? "") === roleId;
}
