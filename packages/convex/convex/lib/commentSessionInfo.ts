import { Id } from "../_generated/dataModel";

// A comment posted from inside a session carries a conversation_id back-link;
// the web renders the session's title as the comment author (an agent's
// comment is the session's, not "Claude"'s). Every web query that returns
// task comments must attach this — the client merges them all into the same
// tasks[id].comments field, so one un-enriched channel (the change-feed
// catch-up was the culprit) clobbers the enriched rows and every session
// author falls back to the bare author string.
export type CommentSessionInfo = {
  _id: string;
  session_id: string;
  title: string | null;
  agent_type: string | null;
};

export async function attachCommentSessionInfo<
  T extends { conversation_id?: Id<"conversations"> | null },
>(ctx: { db: any }, comments: T[]): Promise<(T & { session_info: CommentSessionInfo | null })[]> {
  const cache = new Map<string, CommentSessionInfo | null>();
  return await Promise.all(comments.map(async (c) => {
    let session_info: CommentSessionInfo | null = null;
    if (c.conversation_id) {
      const key = c.conversation_id.toString();
      if (cache.has(key)) {
        session_info = cache.get(key)!;
      } else {
        const conv = await ctx.db.get(c.conversation_id);
        if (conv) {
          session_info = {
            _id: conv._id,
            session_id: conv.session_id,
            title: conv.title || conv.subtitle || null,
            agent_type: conv.agent_type || null,
          };
        }
        cache.set(key, session_info);
      }
    }
    return { ...c, session_info };
  }));
}
