import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { isProgramLaunched, maybeRecordUserSend, typedWords } from "./lib/userSend";
import { approxMessageBytes } from "./userMessagesFilter";

// Rebuild the typed-send counters (user_send_daily) from the transcripts:
// `start` empties the table, then `step` recounts every message created
// before the rebuild began. Live counting (messages.ts insert paths) owns
// what is inserted after that, less the grace it waits before recording, so
// the two never overlap.
//
// One step walks conversations newest first, so the recent days fill in
// first, and reads each one's user-role messages since `after`. Tool-result
// turns are user-role too and can be large, so a step stops at a byte budget
// and schedules the next from where it stopped. `run` labels the rebuild in
// the logs; start a new one only after the last step of the previous one.
const STEP_BYTES = 4_000_000;
const STEP_CONVERSATIONS = 150;
const WIPE_ROWS = 2000;
const LIVE_GRACE_MS = 60_000;
// A queued message this soon after a program launched the session is the
// launcher's brief. Rows from before the queue recorded who wrote a message
// have nothing else to tell the brief from a person's later follow-up.
const BRIEF_WINDOW_MS = 5 * 60_000;

export const start = internalMutation({
  args: { after: v.number(), run: v.string(), before: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const before = args.before ?? Date.now() - LIVE_GRACE_MS;
    const rows = await ctx.db.query("user_send_daily").take(WIPE_ROWS);
    for (const row of rows) await ctx.db.delete(row._id);
    const next = rows.length === WIPE_ROWS ? internal.sendBackfill.start : internal.sendBackfill.step;
    await ctx.scheduler.runAfter(0, next, { after: args.after, run: args.run, before });
    return { before, deleted: rows.length };
  },
});

export const step = internalMutation({
  args: {
    after: v.number(),
    before: v.number(),
    run: v.string(),
    // Resume point: conversations created before this are still to do...
    conv_before: v.optional(v.number()),
    // ...or this one is half read, up to this message timestamp.
    conv_id: v.optional(v.id("conversations")),
    msg_after: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const range = { after: args.after, before: args.before, run: args.run };
    let bytes = 0;
    let convBefore = args.conv_before ?? Number.MAX_SAFE_INTEGER;
    let resume = args.conv_id ? await ctx.db.get(args.conv_id) : null;
    let msgAfter = args.msg_after ?? args.after - 1;
    for (let n = 0; n < STEP_CONVERSATIONS; n++) {
      const c =
        resume ??
        (await ctx.db
          .query("conversations")
          .withIndex("by_creation_time", (q) => q.lt("_creationTime", convBefore))
          .order("desc")
          .first());
      if (!c) return;
      resume = null;
      if (!c.parent_conversation_id && (c.updated_at ?? c._creationTime) >= args.after) {
        // A fork starts with a copy of its parent's history, which the parent
        // already counts: the fork owns only what came after it was created.
        const from = c.forked_from ? Math.max(msgAfter, c._creationTime - 1) : msgAfter;
        const launched = isProgramLaunched(c);
        const msgs = ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", c._id).eq("role", "user").gt("timestamp", from),
          );
        for await (const m of msgs) {
          bytes += approxMessageBytes(m as any);
          if (m._creationTime < args.before) {
            const brief = launched && m.timestamp < c._creationTime + BRIEF_WINDOW_MS;
            const queued = m.from_user_id ? (brief ? "program" : "person") : undefined;
            await maybeRecordUserSend(ctx, c, { _id: m._id, role: m.role, content: m.content, tool_results: m.tool_results, from_user_id: m.from_user_id, queued }, m.timestamp);
          }
          if (bytes > STEP_BYTES) {
            await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...range, conv_before: convBefore, conv_id: c._id, msg_after: m.timestamp });
            return;
          }
        }
      }
      convBefore = c._creationTime;
      msgAfter = args.after - 1;
    }
    await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...range, conv_before: convBefore });
  },
});

// Sessions created before the daemon reported headless runs carry no mark.
// Stamp the ones a machine's own transcripts name as `claude -p`, so the
// rebuild reads them as program launched.
export const markHeadless = internalMutation({
  args: { session_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    let marked = 0;
    for (const session_id of args.session_ids) {
      const rows = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", session_id))
        .collect();
      for (const c of rows) {
        if (c.cli_flags?.includes("--print")) continue;
        await ctx.db.patch(c._id, { cli_flags: [c.cli_flags, "--print"].filter(Boolean).join(" ") });
        marked++;
      }
    }
    return { marked };
  },
});

// Audit one user's UTC day: the largest messages the rule counted as typed,
// with what marks their session. Pages over the user's sessions updated since
// the day (a session active that day may have been updated much later), so
// call it again with the returned cursor until it is null.
// `packages/convex/run.sh sendBackfill:auditDay`.
export const auditDay = internalQuery({
  args: { user_id: v.id("users"), day_start: v.number(), cursor: v.optional(v.string()), min_words: v.optional(v.number()), updated_from: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const end = args.day_start + 86_400_000;
    const counted: Record<string, number> = {};
    const top: any[] = [];
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.user_id).gte("updated_at", args.updated_from ?? args.day_start))
      .paginate({ numItems: 250, cursor: args.cursor ?? null });
    for (const c of page.page) {
      if (c.parent_conversation_id || isProgramLaunched(c)) continue;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", c._id).eq("role", "user").gte("timestamp", args.day_start).lt("timestamp", end))
        .take(300);
      for (const m of msgs) {
        if (m.tool_results?.length) continue;
        const w = typedWords(m.content);
        if (w === null) continue;
        const key = (m.content ?? "").trim().slice(0, 40);
        counted[key] = (counted[key] ?? 0) + 1;
        if (w >= (args.min_words ?? 300)) top.push({ w, conv: c.short_id ?? c._id, title: c.title?.slice(0, 50), queued: !!m.from_user_id, updated_at: c.updated_at, created: c._creationTime, agent: c.agent_type, head: m.content?.slice(0, 140) });
      }
    }
    return { cursor: page.isDone ? null : page.continueCursor, counted: Object.entries(counted), top };
  },
});
