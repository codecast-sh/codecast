import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { isProgramLaunched, maybeRecordUserSend, typedWords } from "./lib/userSend";
import { approxMessageBytes } from "./userMessagesFilter";

// Rebuild the typed-send counters (user_send_daily) from the transcripts:
// `start` stops any earlier rebuild, `wipe` empties the table, then `step`
// recounts every message created before the rebuild began. Live counting (messages.ts insert paths) owns
// what is inserted after that, less the grace it waits before recording, so
// the two never overlap.
//
// One step walks conversations newest first, so the recent days fill in
// first, and reads each one's user-role messages since `after`. Tool-result
// turns are user-role too and can be large, so a step stops at a byte budget
// and schedules the next from where it stopped. `run` labels the rebuild in
// the logs, and `progress` lists the steps still to run.
const STEP_BYTES = 4_000_000;
const STEP_CONVERSATIONS = 150;
const WIPE_ROWS = 500;
const LIVE_GRACE_MS = 60_000;
// A queued message this soon after a program launched the session is the
// launcher's brief. Rows from before the queue recorded who wrote a message
// have nothing else to tell the brief from a person's later follow-up.
const BRIEF_WINDOW_MS = 5 * 60_000;

// The steps of a rebuild still queued or running. A rebuild is finished only
// when none are left: its counter rows appear early and keep growing after.
async function pendingSteps(ctx: { db: any }) {
  // A live step was scheduled moments ago by the one before it, so the newest
  // jobs hold every one; the whole table is past a function's read limit.
  const jobs = await ctx.db.system.query("_scheduled_functions").order("desc").take(500);
  return jobs.filter(
    (j: any) => (j.state.kind === "pending" || j.state.kind === "inProgress") && j.name.startsWith("sendBackfill") && /:(start|step)$/.test(j.name),
  );
}

export const progress = internalQuery({
  args: {},
  handler: async (ctx) => {
    const jobs = await pendingSteps(ctx);
    return jobs.map((j: any) => ({ name: j.name, state: j.state.kind, run: j.args[0]?.run, conv_before: j.args[0]?.conv_before }));
  },
});

export const start = internalMutation({
  args: { after: v.number(), run: v.string() },
  handler: async (ctx, args) => {
    // A rebuild still walking would add its counts on top of this one's. A
    // running step cannot be cancelled and queues its successor when it ends,
    // so wait for it; the queued ones are cancelled here.
    const jobs = await pendingSteps(ctx);
    if (jobs.some((j: any) => j.state.kind === "inProgress")) throw new Error("A rebuild step is running; start again in a few seconds.");
    for (const job of jobs) await ctx.scheduler.cancel(job._id);
    const before = Date.now() - LIVE_GRACE_MS;
    await ctx.scheduler.runAfter(0, internal.sendBackfill.wipe, { after: args.after, run: args.run, before });
    return { before, cancelled: jobs.length };
  },
});

// Empty the counters in small batches (live counting writes the same table),
// then begin the walk.
export const wipe = internalMutation({
  args: { after: v.number(), before: v.number(), run: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("user_send_daily").take(WIPE_ROWS);
    for (const row of rows) await ctx.db.delete(row._id);
    const next = rows.length === WIPE_ROWS ? internal.sendBackfill.wipe : internal.sendBackfill.step;
    await ctx.scheduler.runAfter(0, next, args);
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
// with what marks their session. Pages over every session the user owns (an
// imported session's messages predate it, and some rows carry no updated_at),
// so call it again with the returned cursor until it is null.
// `packages/convex/run.sh sendBackfill:auditDay`.
export const auditDay = internalQuery({
  args: { user_id: v.id("users"), day_start: v.number(), cursor: v.optional(v.string()), min_words: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const end = args.day_start + 86_400_000;
    const counted: Record<string, number> = {};
    const top: any[] = [];
    // Sessions with more user turns that day than one read takes.
    const busiest: any[] = [];
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .paginate({ numItems: 250, cursor: args.cursor ?? null });
    for (const c of page.page) {
      if (c.parent_conversation_id || isProgramLaunched(c)) continue;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", c._id).eq("role", "user").gte("timestamp", args.day_start).lt("timestamp", end))
        .take(300);
      if (msgs.length === 300) busiest.push({ conv: c.short_id ?? c._id, title: c.title?.slice(0, 50), agent: c.agent_type, cli_flags: c.cli_flags, project: c.project_path, created: c._creationTime });
      for (const m of msgs) {
        if (m.tool_results?.length) continue;
        const w = typedWords(m.content);
        if (w === null) continue;
        const key = (m.content ?? "").trim().slice(0, 40);
        counted[key] = (counted[key] ?? 0) + 1;
        if (w >= (args.min_words ?? 300)) top.push({ w, conv: c.short_id ?? c._id, title: c.title?.slice(0, 50), queued: !!m.from_user_id, updated_at: c.updated_at, agent: c.agent_type, head: m.content?.slice(0, 140) });
      }
    }
    return { cursor: page.isDone ? null : page.continueCursor, counted: Object.entries(counted), top, busiest };
  },
});

// Audit the other side: messages stamped as sent by this user on one UTC day,
// in sessions anyone owns. Same paging contract as auditDay.
export const auditSenderDay = internalQuery({
  args: { user_id: v.id("users"), day_start: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", args.day_start).lt("timestamp", args.day_start + 86_400_000))
      .filter((q) => q.and(q.eq(q.field("role"), "user"), q.eq(q.field("from_user_id"), args.user_id)))
      .paginate({ numItems: 200, cursor: args.cursor ?? null, maximumRowsRead: 1500 });
    const counted: Record<string, number> = {};
    const owners: Record<string, number> = {};
    for (const m of page.page) {
      if (typedWords(m.content) === null) continue;
      const c = await ctx.db.get(m.conversation_id);
      const key = `${c?.short_id ?? m.conversation_id} ${String(c?.user_id).slice(-6)} ${(c?.title ?? "").slice(0, 30)}`;
      owners[key] = (owners[key] ?? 0) + 1;
      const head = (m.content ?? "").trim().slice(0, 40);
      counted[head] = (counted[head] ?? 0) + 1;
    }
    return { cursor: page.isDone ? null : page.continueCursor, counted: Object.entries(counted), owners: Object.entries(owners) };
  },
});
