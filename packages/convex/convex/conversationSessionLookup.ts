type LookupRecord = any;
type LookupCtx = { db: any };

const hasMatchingUser = (
  record: LookupRecord | null,
  authUserId: { toString(): string } | string
): boolean => {
  if (!record?.user_id) return false;
  return record.user_id.toString() === authUserId.toString();
};

export const findConversationBySessionReference = async (
  ctx: LookupCtx,
  sessionId: string,
  authUserId: { toString(): string } | string
): Promise<LookupRecord | null> => {
  const directConversation = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (query) => query.eq("session_id", sessionId))
    .first();

  if (hasMatchingUser(directConversation, authUserId)) {
    return directConversation;
  }

  const managedSession = await ctx.db
    .query("managed_sessions")
    .withIndex("by_session_id", (query) => query.eq("session_id", sessionId))
    .first();

  if (!hasMatchingUser(managedSession, authUserId) || !managedSession?.conversation_id) {
    return null;
  }

  const linkedConversation = await ctx.db.get(managedSession.conversation_id);
  if (!hasMatchingUser(linkedConversation, authUserId)) {
    return null;
  }

  return linkedConversation;
};
