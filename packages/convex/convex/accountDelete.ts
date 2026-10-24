import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { deleteBookmarkWithRevision } from "./bookmarkViewWrites";

// Deleting an account runs in budgeted background passes: an account with a
// few hundred sessions holds far more rows than one mutation can delete inside
// its time limit. Access goes first (sign-in sessions and CLI tokens), so the
// account is unusable from the first pass; the user row and its sign-in
// identities go last, once nothing else references it.

// (table, index, field) for every row the account owns. Index leads on field.
const FIRST: ReadonlyArray<readonly [string, string, string]> = [
  ["authSessions", "userId", "userId"],
  ["api_tokens", "by_user_id", "user_id"],
];
const AFTER_CONVERSATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["decisions", "by_user_id", "user_id"],
  ["patterns", "by_user_id", "user_id"],
  ["sync_cursors", "by_user_id", "user_id"],
  ["rate_limits", "by_user_endpoint", "user_id"],
  ["pending_messages", "by_user_status", "from_user_id"],
  ["managed_sessions", "by_user_id", "user_id"],
  ["notifications", "by_recipient", "recipient_user_id"],
  ["daemon_logs", "by_user_timestamp", "user_id"],
  ["reviews", "by_reviewer", "reviewer_user_id"],
  ["team_activity_events", "by_actor", "actor_user_id"],
  ["team_memberships", "by_user_id", "user_id"],
  ["directory_team_mappings", "by_user_id", "user_id"],
  ["client_state", "by_user_id", "user_id"],
  ["authAccounts", "userIdAndProvider", "userId"],
];

const PASS_BUDGET = 500;
const CONVERSATIONS_PER_PASS = 100;

async function deleteOwned(
  ctx: MutationCtx,
  userId: Id<"users">,
  tables: ReadonlyArray<readonly [string, string, string]>,
  budget: number,
): Promise<number> {
  for (const [table, index, field] of tables) {
    if (budget <= 0) break;
    const rows = await (ctx.db as any)
      .query(table)
      .withIndex(index, (q: any) => q.eq(field, userId))
      .take(budget);
    for (const row of rows) await ctx.db.delete(row._id);
    budget -= rows.length;
  }
  return budget;
}

/** One budgeted pass over the account. Returns true when rows remain. */
export async function purgeAccountPass(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  let budget = await deleteOwned(ctx, userId, FIRST, PASS_BUDGET);
  if (budget <= 0) return true;

  // Each conversation's own rows are purged by its own scheduled job.
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .take(CONVERSATIONS_PER_PASS);
  for (const conv of conversations) {
    await ctx.db.delete(conv._id);
    await ctx.scheduler.runAfter(0, internal.sessionDelete.purgeConversationRows, {
      conversation_id: String(conv._id),
    });
  }
  if (conversations.length === CONVERSATIONS_PER_PASS) return true;

  const bookmarks = await ctx.db
    .query("bookmarks")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .take(budget);
  for (const b of bookmarks) await deleteBookmarkWithRevision(ctx, b);
  budget -= bookmarks.length;
  if (budget <= 0) return true;

  budget = await deleteOwned(ctx, userId, AFTER_CONVERSATIONS, budget);
  if (budget <= 0) return true;

  if (await ctx.db.get(userId)) await ctx.db.delete(userId);
  return false;
}

export const purgeAccount = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<void> => {
    if (await purgeAccountPass(ctx, args.user_id)) {
      await ctx.scheduler.runAfter(0, internal.accountDelete.purgeAccount, args);
    }
  },
});

/** The signed-in user deletes their own account. Returns at once; the data
 *  goes in background passes, starting with every way to sign in. */
export async function startAccountDeletion(ctx: MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  if (!(await ctx.db.get(userId))) throw new Error("User not found");
  await ctx.scheduler.runAfter(0, internal.accountDelete.purgeAccount, { user_id: userId });
  return { completed: true, message: "Account permanently deleted" };
}

// Support path: delete an account on its owner's behalf (packages/convex/run.sh).
export const adminDeleteAccount = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) throw new Error("User not found");
    await ctx.scheduler.runAfter(0, internal.accountDelete.purgeAccount, { user_id: user._id });
    return { user_id: user._id };
  },
});
