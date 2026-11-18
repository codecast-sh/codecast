// Forks the daemon mislinked as plan handoffs, run by hand
// (packages/convex/run.sh forkHandoffRepair:<name>). A fork carries its
// source's compaction summary, whose transcript pointer daemons before
// v1.1.236 read as a plan handoff: linkPlanHandoff then set the fork's
// parent_conversation_id and overwrote its fork point with "plan-handoff",
// so the source drew it as "Continued in" and lost its branch chip.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";

/** Every fork marked as a plan handoff: a real handoff is never a fork. */
export const listMislinkedForks = internalQuery({
  args: {},
  handler: async (ctx) => {
    const forks = await ctx.db
      .query("conversations")
      .withIndex("by_forked_from", (q) => q.gt("forked_from", "" as any))
      .collect();
    return forks
      .filter((c) => c.parent_message_uuid === "plan-handoff")
      .map((c) => ({ _id: c._id, forked_from: c.forked_from, title: c.title, session_id: c.session_id, fork_copied: c.fork_copied }));
  },
});

/** A fork's branch point: its newest message the source also holds. Read
 *  newest first, since a fork's own messages can carry timestamps older
 *  than its shared history; rows without a uuid say nothing either way. */
export const findForkPoint = internalQuery({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }) => {
    const fork = await ctx.db.get(conversation_id);
    if (!fork?.forked_from) throw new Error("Not a fork");
    const source = fork.forked_from;
    let scanned = 0;
    for await (const m of ctx.db.query("messages").withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversation_id)).order("desc")) {
      if (++scanned > 3000) return { fork_point_uuid: null, scanned };
      if (!m.message_uuid) continue;
      const held = await ctx.db.query("messages")
        .withIndex("by_conversation_uuid", (q) => q.eq("conversation_id", source).eq("message_uuid", m.message_uuid))
        .first();
      if (held) return { fork_point_uuid: m.message_uuid, scanned, preview: (m.content ?? "").slice(0, 80) };
    }
    return { fork_point_uuid: null, scanned };
  },
});

/** Restores one mislinked fork: its fork point back, the handoff link gone. */
export const restoreFork = internalMutation({
  args: { conversation_id: v.id("conversations"), fork_point_uuid: v.string(), dry: v.boolean() },
  handler: async (ctx, { conversation_id, fork_point_uuid, dry }) => {
    const fork = await ctx.db.get(conversation_id);
    if (!fork?.forked_from || fork.parent_message_uuid !== "plan-handoff") throw new Error("Not a mislinked fork");
    const point = await ctx.db
      .query("messages")
      .withIndex("by_conversation_uuid", (q) => q.eq("conversation_id", fork.forked_from!).eq("message_uuid", fork_point_uuid))
      .first();
    if (!point) throw new Error("Fork point is not a message of the fork's source");
    const before = { parent_conversation_id: fork.parent_conversation_id ?? null, parent_message_uuid: fork.parent_message_uuid };
    if (!dry) await ctx.db.patch(conversation_id, { parent_conversation_id: undefined, parent_message_uuid: fork_point_uuid });
    return { dry, before, after: { parent_conversation_id: null, parent_message_uuid: fork_point_uuid } };
  },
});
