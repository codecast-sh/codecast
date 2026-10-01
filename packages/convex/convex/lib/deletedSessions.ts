// Leaf helper for the deleted-session tombstone (schema `deleted_sessions`,
// written by sessionDelete.ts). Kept out of sessionDelete.ts so
// conversations.ts can read it without importing a module that imports it.
export async function isDeletedSession(ctx: { db: any }, userId: string, sessionId: string): Promise<boolean> {
  const row = await ctx.db
    .query("deleted_sessions")
    .withIndex("by_user_session", (q: any) => q.eq("user_id", userId).eq("session_id", sessionId))
    .first();
  return !!row;
}
