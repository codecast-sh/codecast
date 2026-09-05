import { internalMutation } from "./functions";
import { v } from "convex/values";
import { formatSessionMessage } from "./pendingMessages";

export const repair = internalMutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    entries: v.array(v.object({
      message_id: v.id("messages"),
      expected_content: v.string(),
      source_message_id: v.id("messages"),
      source_call_id: v.string(),
      expected_source_input: v.string(),
    })),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.entries.length > 32 || args.entries.reduce((size, e) => size + e.expected_content.length + e.expected_source_input.length, 0) > 512_000) {
      throw new Error("Agent prompt repair batch is too large");
    }
    const parent = await ctx.db.get(args.parent_conversation_id);
    const child = await ctx.db.get(args.child_conversation_id);
    if (!parent || !child || parent.user_id !== child.user_id || parent._id === child._id ||
      child.parent_conversation_id !== parent._id || !child.is_subagent) {
      throw new Error("Agent prompt repair requires an owned parent-child relationship");
    }
    const patches = [];
    const seen = new Set<string>();
    for (const entry of args.entries) {
      if (seen.has(entry.message_id)) throw new Error("Duplicate repair message");
      seen.add(entry.message_id);
      const message = await ctx.db.get(entry.message_id);
      const source = await ctx.db.get(entry.source_message_id);
      if (!message || message.conversation_id !== child._id || message.role !== "user" || message.from_user_id ||
        !source || source.conversation_id !== parent._id || source.role !== "assistant" ||
        !source.tool_calls?.some(call => call.id === entry.source_call_id && call.input === entry.expected_source_input && /agent-(?:spawn|send)\.sh/.test(call.input)) ||
        Math.abs(message.timestamp - source.timestamp) > 300_000) {
        throw new Error("Agent prompt repair provenance does not match");
      }
      const content = formatSessionMessage(parent._id, entry.expected_content)
        .replace('">', `" source-message="${source._id}">`);
      if (message.content === content) continue;
      if (message.content !== entry.expected_content) throw new Error("Agent prompt changed since the repair was prepared");
      patches.push({ id: message._id, content });
    }
    if (args.dry_run !== false) return { dry_run: true, changed: patches.length };
    for (const patch of patches) {
      await ctx.db.patch(patch.id, { content: patch.content });
      const mirror = await ctx.db.query("message_search_recent")
        .withIndex("by_message_id", q => q.eq("message_id", patch.id)).first();
      if (mirror) await ctx.db.patch(mirror._id, { content: patch.content.slice(0, 32_000) });
    }
    if (patches.length) await ctx.db.patch(child._id, { transcript_revision: (child.transcript_revision ?? 0) + 1 });
    return { dry_run: false, changed: patches.length };
  },
});
