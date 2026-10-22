// A session that moved to another account (performReparentSessionToDevice:
// account follows device) leaves its transcript on the machine it left. When
// that machine's daemon syncs the file again (a startup scan, a stray resume),
// createConversation finds no row the caller runs for the session id and would
// start a second one: a separate copy of the session, woken and resumed on the
// old machine while the real one runs on the new (jx7cvd9 beside jx78zy0).
//
// The session moved away from the caller when another account's row holds the
// id and the caller either ran it before (the author pinned on its first
// account change) or still owns it. A row the caller has no tie to is left
// alone. Leaf module so conversations.ts can import it without a cycle.
export async function conversationMovedAwayFrom(
  ctx: { db: any },
  userId: string,
  sessionId: string,
  isOwner: (conversation: any) => Promise<boolean>,
): Promise<any | null> {
  const rows = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
    .take(16);
  for (const row of rows) {
    if (row.user_id?.toString() === userId) continue;
    if (row.author_user_id?.toString() === userId || (await isOwner(row))) return row;
  }
  return null;
}
