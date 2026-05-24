// TEMPORARY benchmark — delete after measuring search hot path.
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const bench = internalQuery({
  args: { query: v.string(), take: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const take = args.take ?? 512;
    const q = args.query.trim().toLowerCase();

    const t0 = Date.now();
    const msgs = await ctx.db
      .query("messages")
      .withSearchIndex("search_content", (s) => s.search("content", q))
      .take(take);
    const t1 = Date.now();

    // Estimate bytes pulled (content is the heavy field).
    let contentBytes = 0;
    let toolResultBytes = 0;
    for (const m of msgs) {
      contentBytes += (m.content || "").length;
      if (m.tool_results) toolResultBytes += JSON.stringify(m.tool_results).length;
    }

    const t2 = Date.now();
    const titleHits = await ctx.db
      .query("conversations")
      .withSearchIndex("search_title", (s) => s.search("title", q))
      .take(50);
    const t3 = Date.now();

    // Distinct conversations among the message hits, then hydrate them in parallel.
    const convIds = [...new Set(msgs.map((m) => m.conversation_id.toString()))];
    const t4 = Date.now();
    const convs = await Promise.all(
      msgs
        .filter((m, i) => msgs.findIndex((x) => x.conversation_id === m.conversation_id) === i)
        .map((m) => ctx.db.get(m.conversation_id))
    );
    const t5 = Date.now();

    return {
      take,
      msgCount: msgs.length,
      distinctConvs: convIds.length,
      titleHitCount: titleHits.length,
      hydratedConvs: convs.filter(Boolean).length,
      contentKB: Math.round(contentBytes / 1024),
      toolResultKB: Math.round(toolResultBytes / 1024),
      timings_ms: {
        messageSearchTake: t1 - t0,
        titleSearchTake: t3 - t2,
        hydrateConvs: t5 - t4,
        total: t5 - t0,
      },
    };
  },
});
