import { internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// TEMP diagnostic — remove after use.
export const inspectDocsById = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out: any[] = [];
    for (const id of args.ids) {
      const d: any = await ctx.db.get(id as Id<"docs">);
      if (!d) { out.push({ id, missing: true }); continue; }
      out.push({
        _id: d._id,
        title: (d.title || "").slice(0, 50),
        user_id: d.user_id,
        source: d.source,
        source_file: d.source_file ?? null,
        conversation_id: d.conversation_id ?? null,
        content_len: (d.content || "").length,
        created_at: d.created_at,
      });
    }
    return out;
  },
});
