// Reading the authority audit (lib/authorityEvents.ts is the writer). A person
// reads the events they caused, the events filed in a workspace they hold
// (their own, and every team they belong to: a team's membership, role and
// proposal events carry `team:<id>`), and, when asking about one session, the
// events on a conversation they can access.
import { v } from "convex/values";
import { query } from "./functions";
import { getUserOrToken } from "./lib/auth";
import { heldKeysFor, requireAccessibleConversation, resolveSessionConversation } from "./lib/access";
import { AUTHORITY_EVENT_KINDS } from "./lib/authorityEvents";

const kindValidator = v.union(...AUTHORITY_EVENT_KINDS.map((k) => v.literal(k)));

export const list = query({
  args: {
    api_token: v.optional(v.string()),
    kind: v.optional(kindValidator),
    /** A conversation id, session id or short id; the events on that session. */
    session: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getUserOrToken(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const since = args.since ?? 0;
    const range = (q: any) => q.gte("created_at", since);
    const take = (idx: string, key: string, value: any) =>
      ctx.db.query("authority_events").withIndex(idx as any, (q: any) => range(q.eq(key, value))).order("desc").take(limit);

    let rows: any[];
    if (args.session) {
      const direct = ctx.db.normalizeId("conversations", args.session);
      const conv = direct
        ? await requireAccessibleConversation(ctx, userId, direct)
        : await resolveSessionConversation(ctx, userId, args.session);
      if (!conv) throw new Error("Session not found");
      rows = await take("by_conversation_created", "conversation_id", conv._id);
    } else {
      const held = await heldKeysFor(ctx, userId);
      const sets = await Promise.all([
        take("by_actor_created", "actor_user_id", userId),
        ...[...held].map((key) => take("by_workspace_created", "workspace", key)),
      ]);
      const seen = new Set<string>();
      rows = sets.flat().filter((r) => !seen.has(String(r._id)) && seen.add(String(r._id)));
    }
    return rows
      .filter((r) => !args.kind || r.kind === args.kind)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  },
});
