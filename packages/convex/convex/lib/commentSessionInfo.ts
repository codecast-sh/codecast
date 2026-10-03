import { Doc, Id } from "../_generated/dataModel";
import { canAccessConversation } from "./access";
import { identityFieldsOf } from "./sessionIdentityFields";

// A comment posted from inside a session carries a conversation_id back-link;
// the web renders the session's title as the comment author (an agent's
// comment is the session's, not "Claude"'s). Every web query that returns
// task comments must attach this — the client merges them all into the same
// tasks[id].comments field, so one un-enriched channel (the change-feed
// catch-up was the culprit) clobbers the enriched rows and every session
// author falls back to the bare author string. The identity fields ride along
// so the author wears the session's face and character name.
export type CommentSessionInfo = {
  _id: string;
  session_id: string;
  title: string | null;
  agent_type: string | null;
} & Awaited<ReturnType<typeof identityFieldsOf>>;

// One lookup per conversation, shared by every comment that names it. It
// holds the promise, so comments resolved in parallel (and the tasks of one
// list, which pass one cache) read each conversation once.
export type CommentSessionCache = Map<string, Promise<CommentSessionInfo | null>>;

export async function attachCommentSessionInfo<
  T extends { conversation_id?: Id<"conversations"> | null },
>(
  ctx: { db: any },
  comments: T[],
  userId: Id<"users">,
  cache: CommentSessionCache = new Map(),
): Promise<(T & { session_info: CommentSessionInfo | null })[]> {
  const infoFor = (id: Id<"conversations">): Promise<CommentSessionInfo | null> => {
    const key = id.toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = (async () => {
        const conv = await ctx.db.get(id);
        if (!conv || !(await canAccessConversation(ctx, userId, conv))) return null;
        return {
          _id: conv._id,
          session_id: conv.session_id,
          title: conv.title || conv.subtitle || null,
          agent_type: conv.agent_type || null,
          ...(await identityFieldsOf(conv, (id: any) => ctx.db.get(id))),
        };
      })();
      cache.set(key, hit);
    }
    return hit;
  };
  return await Promise.all(comments.map(async (c) => {
    const session_info = c.conversation_id ? await infoFor(c.conversation_id) : null;
    return { ...c, conversation_id: session_info ? c.conversation_id : undefined, session_info };
  }));
}

// A task's comments as every web channel ships them: oldest first (the
// by_task_id order), each with its session_info. The list channels, byIds and
// the detail queries all write the same tasks[id].comments, so they all read
// it here.
export async function taskCommentsWithSessionInfo(
  ctx: { db: any },
  taskId: Id<"tasks">,
  userId: Id<"users">,
  cache?: CommentSessionCache,
) {
  const comments: Doc<"task_comments">[] = await ctx.db
    .query("task_comments")
    .withIndex("by_task_id", (q: any) => q.eq("task_id", taskId))
    .collect();
  return await attachCommentSessionInfo(ctx, comments, userId, cache);
}
