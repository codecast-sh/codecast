import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

// TEMP diagnostic — inspect auth session/refresh-token health for one user.
// Safe: read-only. Delete after use.
export const inspect = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    // @ts-ignore auth table
    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q: any) => q.eq("userId", userId as any))
      .collect();

    const sessionInfo = [] as any[];
    for (const s of sessions as any[]) {
      // @ts-ignore auth table
      const rts = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q: any) => q.eq("sessionId", s._id))
        .collect();
      const used = rts.filter((r: any) => r.firstUsedTime !== undefined).length;
      const unused = rts.length - used;
      sessionInfo.push({
        sessionId: s._id,
        created: new Date(s._creationTime).toISOString(),
        ageDays: ((now - s._creationTime) / 86400000).toFixed(1),
        expires: new Date(s.expirationTime).toISOString(),
        expiresInDays: ((s.expirationTime - now) / 86400000).toFixed(1),
        refreshTokens: rts.length,
        usedRTs: used,
        unusedRTs: unused,
      });
    }
    sessionInfo.sort((a, b) => (a.created < b.created ? 1 : -1));

    return {
      userId,
      sessionCount: sessions.length,
      sessions: sessionInfo,
    };
  },
});
