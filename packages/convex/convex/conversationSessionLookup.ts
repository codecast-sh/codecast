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
    .withIndex("by_session_id", (query: any) => query.eq("session_id", sessionId))
    .first();

  if (hasMatchingUser(directConversation, authUserId)) {
    return directConversation;
  }

  const managedSession = await ctx.db
    .query("managed_sessions")
    .withIndex("by_session_id", (query: any) => query.eq("session_id", sessionId))
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

// Resolve a conversation from whatever reference a human or agent actually has on
// hand: a `short_id` (the 7-char `jx…` token shown in the UI / feed), a Claude
// `session_id` (the JSONL UUID the daemon and `detectCurrentSessionId` know), or a
// raw conversation `_id`. findConversationBySessionReference only knows session_id,
// so this is the broader entry point for ref-typed inputs (e.g. `cast send <ref>`).
export const findConversationByAnyRef = async (
  ctx: LookupCtx,
  ref: string,
  authUserId: { toString(): string } | string
): Promise<LookupRecord | null> => {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return null;

  // short_id is exactly the first 7 chars of the conversation id; accept a longer
  // paste by truncating, so a full id pasted as a "short id" still matches.
  // short_id is only a 7-char prefix, so it can collide across users — take the
  // candidates and pick the one this user owns rather than a bare .first().
  const shortId = trimmed.slice(0, 7);
  const byShortIdCandidates = await ctx.db
    .query("conversations")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", shortId))
    .take(16);
  const ownShortIdMatch = byShortIdCandidates.find((c: any) => hasMatchingUser(c, authUserId));
  if (ownShortIdMatch) return ownShortIdMatch;

  const bySession = await findConversationBySessionReference(ctx, trimmed, authUserId);
  if (bySession) return bySession;

  // Last resort: the ref is a full conversation _id.
  try {
    const byId = await ctx.db.get(trimmed as any);
    if (hasMatchingUser(byId, authUserId)) return byId;
  } catch {
    // not a valid id shape — fall through
  }

  return null;
};
