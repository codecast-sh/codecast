// Telling a session something on a reparent or a role change, and the rule
// for which sessions a team role may hold. Kept below sessionOwnership.ts so
// patchConversationVisibility (lib/conversationVisibility.ts) can drop a
// session from its role without importing the reparent machinery, which
// reaches agentTasks, sessionDecisions and the whole function graph behind
// them (ct-92329). Nothing here may import a module that defines functions
// other than pendingMessages.
import type { Id } from "../_generated/dataModel";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";
import { checkConversationAccess, isVisibilityShareable, teamVisibleConvTeam } from "../privacy";
import { effectiveMembershipVisibility } from "../teamVisibility";
import { enqueuePendingMessage, formatSessionMessage } from "../pendingMessages";
import { wakeCost, wakeFieldsOf } from "../wakeCost";

// Runner-or-team, exactly cast send's access rule: the running account may
// (re)assign its own sessions, and any teammate may claim/reassign a session
// they can already see. A merely share-linked viewer may not. Returns null when
// nothing accessible matches — reads treat that as "no data" (the web mounts
// listOwners with refs that may not have synced yet, e.g. an optimistic stub
// session's client UUID), while mutations escalate it to an error.
export async function findOwnableConversation(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<any> {
  return findConversationByAnyRefWhere(ctx, sessionId, async (candidate) => {
    const access = await checkConversationAccess(ctx, authUserId, candidate);
    return access === "owner" || access === "team";
  });
}

// A person's name as the product shows it: display name, then login, then
// the email's local part. Shared with the role reparent's line.
export function personName(u: any): string {
  return u?.name || u?.github_username || u?.email?.split("@")[0] || "a teammate";
}

// A team role's standing session is team visible, and its wake frame prints
// each of its sessions' title, state and task (R1). So a session the team
// cannot see never reports to a team role: filing it there would publish it.
// A personal role (no team) has only its owner as a reader and takes any.
const sessionVisibility = new WeakMap<object, Map<string, Promise<any>>>();

export async function roleMayHoldSession(ctx: { db: any }, role: { team_id?: any }, c: any): Promise<boolean> {
  if (!role.team_id) return true;
  if (String(teamVisibleConvTeam(c) ?? "") !== String(role.team_id)) return false;
  let cache = sessionVisibility.get(ctx);
  if (!cache) { cache = new Map(); sessionVisibility.set(ctx, cache); }
  const key = `${role.team_id}:${c.user_id}`;
  let membership = cache.get(key);
  if (!membership) {
    membership = ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", c.user_id).eq("team_id", role.team_id)).first();
    cache.set(key, membership!);
  }
  const m = await membership;
  // Per conversation: a "going forward" switch reads older sessions at the level they had.
  return !!m && isVisibilityShareable(effectiveMembershipVisibility(m, c.started_at));
}

// One message into the session, attributed to the acting person through the
// session message rail: their own session when the CLI names one, else a
// named line with no session pill (the web's rendering of an unlinked
// sender). A session that is killed or whose prompt cache has expired (the
// send rail's own rule, wakeCost) is not woken to read one sentence: the line
// is deferred and rides its next turn.
export async function tellSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  body: string,
  fromSession: string | undefined,
  moveKey: string,
  batch?: { actor: any; sender: any | null },
): Promise<"told" | "deferred"> {
  const actor = batch ? batch.actor : await ctx.db.get(authUserId);
  const fromRef = fromSession?.trim();
  const sender = batch ? batch.sender : fromRef ? await findOwnableConversation(ctx, authUserId, fromRef) : null;
  const fromShortId = sender ? (sender.short_id ?? sender._id.toString().slice(0, 7)) : "unknown";
  return sayIntoSession(ctx, authUserId, conversation, {
    content: formatSessionMessage(fromShortId, body, { name: personName(actor) }),
    client_id: `reparent:${conversation._id}:${moveKey}:${Date.now()}`,
    sender,
    human: !sender,
  });
}

// One product line into a session through the ordinary pending message rail,
// so it lands in the pane and syncs into the thread like any message. A
// session that is killed or whose prompt cache has expired (wakeCost) is not
// woken to read one line: it is deferred and rides the next turn. A standing
// session never defers (the rail's own rule).
export async function sayIntoSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  line: { content: string; client_id: string; sender: any | null; human: boolean; hold?: boolean },
): Promise<"told" | "deferred"> {
  const crossUser = conversation.user_id.toString() !== authUserId.toString();
  const cost = wakeCost({ ...conversation, ...wakeFieldsOf(conversation) }, Date.now());
  const defer = !conversation.standing_role_id && (cost.killed || cost.cacheCold);
  await enqueuePendingMessage(ctx, conversation, authUserId, {
    content: line.content,
    client_id: line.client_id,
    from_conversation_id: crossUser && line.sender ? line.sender._id : undefined,
    human: line.human,
    defer,
    hold: line.hold,
  });
  return defer || line.hold ? "deferred" : "told";
}

// The role's standing session: the row the role speaks from.
export async function standingSessionOf(ctx: { db: any }, role: any): Promise<any | null> {
  return await ctx.db
    .query("conversations")
    .withIndex("by_standing_role", (q: any) => q.eq("standing_role_id", role._id))
    .first();
}

// A session's visibility changed (lib/conversationVisibility.patchConversationVisibility):
// a team role may hold only a session its team can see (roleMayHoldSession),
// so one the team can no longer see leaves the role in the same patch, and
// both threads record the move on the reparent rail. Returns the fields to
// fold into that patch; `tell` writes the line once the patch is in.
export async function roleDropForVisibility(
  ctx: { db: any },
  after: { _id: Id<"conversations">; user_id: Id<"users"> } & Record<string, any>,
): Promise<{ patch: Record<string, undefined>; tell: () => Promise<void> } | null> {
  const row = await ctx.db.get(after._id);
  if (!row?.org_role_id) return null;
  const role = await ctx.db.get(row.org_role_id);
  if (!role || await roleMayHoldSession(ctx, role, { ...row, ...after })) return null;
  const patch: Record<string, undefined> = { org_role_id: undefined, org_role_hold: undefined };
  const tell = async () => {
    const line = `This session is no longer visible to the team, so it left @${role.handle}.`;
    const moveKey = `left:${role._id}`;
    await tellSession(ctx, row.user_id, { ...row, ...after, ...patch }, line, undefined, moveKey);
    const standing = await standingSessionOf(ctx, role);
    if (standing) await tellSession(ctx, row.user_id, standing, `${row.short_id ?? String(row._id).slice(0, 7)} "${(row.title ?? "").trim()}" is no longer visible to the team, so it left @${role.handle}.`, undefined, moveKey);
  };
  return { patch, tell };
}
