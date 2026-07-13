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
// raw conversation `_id`. The `accept` predicate decides which candidate to keep —
// short_id collides across users (it's only a 7-char prefix) and a session_id can
// resolve to someone else's row, so the traversal probes every shape and returns the
// first conversation `accept` approves. This is the single ref→conversation resolver;
// callers supply the access rule (own-only, or own-or-team for `cast send`).
// short_id is exactly the first 7 chars of the conversation id; accept a longer
// paste by truncating, so a full id pasted as a "short id" still matches. The
// index scan ascends by creation time; return newest first — short ids
// circulate for recent sessions, so when a short id collides the newest match
// is the one the caller almost certainly means.
const shortIdCandidatesNewestFirst = async (
  ctx: LookupCtx,
  ref: string
): Promise<LookupRecord[]> => {
  const candidates = await ctx.db
    .query("conversations")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", ref.slice(0, 7)))
    .take(16);
  return [...candidates].reverse();
};

export const findConversationByAnyRefWhere = async (
  ctx: LookupCtx,
  ref: string,
  accept: (conversation: LookupRecord) => boolean | Promise<boolean>
): Promise<LookupRecord | null> => {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return null;

  for (const candidate of await shortIdCandidatesNewestFirst(ctx, trimmed)) {
    if (await accept(candidate)) return candidate;
  }

  // session_id: directly on the conversation, or via the managed_sessions link.
  const directConversation = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", trimmed))
    .first();
  if (directConversation && (await accept(directConversation))) return directConversation;

  const managedSession = await ctx.db
    .query("managed_sessions")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", trimmed))
    .first();
  if (managedSession?.conversation_id) {
    const linked = await ctx.db.get(managedSession.conversation_id);
    if (linked && (await accept(linked))) return linked;
  }

  // Last resort: the ref is a full conversation _id.
  try {
    const byId = await ctx.db.get(trimmed as any);
    if (byId && (await accept(byId))) return byId;
  } catch {
    // not a valid id shape — fall through
  }

  return null;
};

// Own-only resolver: the conversation must belong to the authenticated user. This is the
// default for every caller except `cast send`'s target lookup (which is team-aware).
export const findConversationByAnyRef = async (
  ctx: LookupCtx,
  ref: string,
  authUserId: { toString(): string } | string
): Promise<LookupRecord | null> =>
  findConversationByAnyRefWhere(ctx, ref, (conversation) =>
    hasMatchingUser(conversation, authUserId)
  );

// Access-ranked resolver for the read paths (`cast read`/summary/export, webGet,
// fork), where "found but not accessible" must stay distinguishable from "not
// found": instead of an accept predicate that hides inaccessible rows, this
// always returns SOME candidate when the ref matches, ranked own > accessible >
// anything (newest first within each rank), and the caller runs its usual
// access check on the result. A full conversation id wins outright; for a
// colliding short id this guarantees someone else's older conversation can
// never shadow the caller's own session.
export const resolveConversationRefRanked = async (
  ctx: LookupCtx,
  ref: string,
  authUserId: { toString(): string } | string,
  canAccess: (conversation: LookupRecord) => boolean | Promise<boolean>
): Promise<LookupRecord | null> => {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) return null;

  try {
    const byId = await ctx.db.get(trimmed as any);
    if (byId) return byId;
  } catch {
    // Not a full Convex id — fall through to the short-id index.
  }

  const candidates = await shortIdCandidatesNewestFirst(ctx, trimmed);
  if (candidates.length <= 1) return candidates[0] ?? null;

  const own = candidates.find((c) => hasMatchingUser(c, authUserId));
  if (own) return own;
  for (const candidate of candidates) {
    if (await canAccess(candidate)) return candidate;
  }
  return candidates[0];
};
