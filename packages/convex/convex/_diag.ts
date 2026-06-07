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

import { internalMutation } from "./_generated/server";

// TEMP cleanup v2 — cross-conversation dupes (forked sessions). Remove after use.
export const dedupeAcrossConversations = internalMutation({
  args: { anchor_doc_id: v.string(), apply: v.boolean() },
  handler: async (ctx, args) => {
    const anchor: any = await ctx.db.get(args.anchor_doc_id as Id<"docs">);
    if (!anchor) throw new Error("anchor doc not found");

    const docs = await ctx.db
      .query("docs")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", anchor.user_id))
      .collect();

    // Group inline_extract docs by exact content, regardless of conversation.
    const groups = new Map<string, any[]>();
    for (const d of docs) {
      if (d.source !== "inline_extract") continue;
      const key = `${(d.content || "").length}|${(d.content || "").slice(0, 400)}`;
      const g = groups.get(key) || [];
      g.push(d);
      groups.set(key, g);
    }

    const samples: Array<{ title: string; count: number }> = [];
    let deleteCount = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const exact = g.filter((d: any) => d.content === g[0].content);
      if (exact.length < 2) continue;
      exact.sort((a: any, b: any) => a._creationTime - b._creationTime);
      const [keep, ...dupes] = exact;
      samples.push({ title: (keep.title || "").slice(0, 55), count: dupes.length });
      deleteCount += dupes.length;
      if (args.apply) {
        for (const d of dupes) await ctx.db.delete(d._id);
      }
    }
    samples.sort((a, b) => b.count - a.count);

    return { scanned: docs.length, dupes_to_delete: deleteCount, groups: samples.length, samples: samples.slice(0, 12), applied: args.apply };
  },
});
