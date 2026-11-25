// When someone answers a team session (team sessions spec): everyone on the
// team was told it needed input, so once one person writes in it, the others'
// unread alerts for it clear, and the row says who answered. A leaf module.
import type { Id } from "../_generated/dataModel";

/** The alerts that ask a person to act on the session. */
const NEEDS_INPUT_TYPES = new Set(["session_idle", "permission_request", "session_error"]);
// A person's newest alerts for one session: an unanswered one is among them.
const ALERT_SCAN_CAP = 20;

export async function recordTeamAnswer(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  answerer: Id<"users">,
  partyIds: Id<"users">[],
  // The session was waiting on someone (its agent had finished a turn, or a
  // permission prompt stood): an answer counts even if every alert was read.
  waiting = false,
  now = Date.now(),
): Promise<number> {
  // An agent account never answers for the team.
  if ((await ctx.db.get(answerer))?.is_bot) return 0;
  // Only an answer to a session that was waiting: someone on the team still
  // had an unread alert asking for input. Every such alert clears, the
  // answerer's own too, and only then does the row say who answered.
  let cleared = 0;
  for (const person of partyIds) {
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_conversation", (q: any) => q.eq("recipient_user_id", person).eq("conversation_id", conversationId))
      .order("desc")
      .take(ALERT_SCAN_CAP);
    for (const n of rows) {
      if (n.read || !NEEDS_INPUT_TYPES.has(n.type)) continue;
      await ctx.db.patch(n._id, { read: true });
      cleared++;
    }
  }
  if (cleared > 0 || waiting) await ctx.db.patch(conversationId, { team_answered_by: answerer, team_answered_at: now });
  return cleared;
}
