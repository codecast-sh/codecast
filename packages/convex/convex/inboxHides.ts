// A viewer's hide of a session they neither run nor own (schema: inbox_hides).
//
// The owner's triage fields on a conversation are the owner's alone: the
// dispatch gate drops a hide patch from anyone else, and the web store then only
// forgets its local copy. On the team board that copy came back with the next
// push, because the fold reads every teammate's team-visible row and nothing
// recorded the viewer's gesture. These helpers are that record. The team scan
// skips the ids in it; the hide and restore actions write it only when the
// caller is NOT the runner or an owner, because for those the row's own stamps
// already carry the gesture.
import type { Id } from "./_generated/dataModel";
import { canAccessConversation } from "./lib/access";
import { isSessionOwner } from "./sessionOwners";

type Ctx = { db: any };
export type ViewerHideKind = "stash" | "dismiss";

// Bounded read: a viewer's hides are a triage list, not a log.
const VIEWER_HIDES_CAP = 2000;

export async function viewerHiddenConversationIds(ctx: Ctx, userId: Id<"users">): Promise<Set<string>> {
  const rows = await ctx.db
    .query("inbox_hides")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .take(VIEWER_HIDES_CAP);
  return new Set(rows.map((r: any) => r.conversation_id.toString()));
}

// The runner and the owner set triage through the conversation's own stamps.
export async function isRunnerOrOwner(ctx: Ctx, conv: any, userId: Id<"users">): Promise<boolean> {
  const me = userId.toString();
  if (conv.user_id?.toString() === me) return true;
  if (conv.owner_user_id?.toString() === me) return true;
  return await isSessionOwner(ctx, conv._id, userId);
}

async function findHide(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">) {
  return await ctx.db
    .query("inbox_hides")
    .withIndex("by_user_conversation", (q: any) => q.eq("user_id", userId).eq("conversation_id", conversationId))
    .first();
}

/**
 * Record that `userId` hid a conversation they can see but do not run or own.
 * Returns false (and writes nothing) when the caller is the runner or an owner,
 * or cannot access the conversation. Idempotent: a repeat rewrites kind and time.
 */
export async function hideConversationForViewer(
  ctx: Ctx,
  userId: Id<"users">,
  conv: any,
  kind: ViewerHideKind,
  at: number = Date.now(),
): Promise<boolean> {
  if (!conv || (await isRunnerOrOwner(ctx, conv, userId))) return false;
  if (!(await canAccessConversation(ctx, userId, conv))) return false;
  const existing = await findHide(ctx, userId, conv._id);
  if (existing) await ctx.db.patch(existing._id, { kind, at });
  else await ctx.db.insert("inbox_hides", { user_id: userId, conversation_id: conv._id, kind, at });
  return true;
}

/** Drop the viewer's hide, if any. Safe for every caller: a missing row is a no-op. */
export async function unhideConversationForViewer(
  ctx: Ctx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<boolean> {
  const existing = await findHide(ctx, userId, conversationId);
  if (!existing) return false;
  await ctx.db.delete(existing._id);
  return true;
}
