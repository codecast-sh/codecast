import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { isProgramLaunched, maybeRecordUserSend, typedWords } from "./lib/userSend";
import { recordUsageDays, turnCost, turnTokens, type UsageTurn } from "./lib/usageDaily";
import { approxMessageBytes } from "./userMessagesFilter";

// Rebuild a day counter from the transcripts. `kind` picks which: "sends"
// (default) is the typed-send counters (user_send_daily), read from
// user-role messages; "usage" is the token and spend counters
// (user_usage_daily, through usage_pending), read from the usage block on
// assistant messages, which prod carries from 2026-09-13. `start` stops any
// earlier rebuild of that kind, `wipe` empties its tables, then `step`
// recounts every message created before the rebuild began. Live counting
// (messages.ts insert paths) owns what is inserted after that, less the grace
// it waits before recording, so the two never overlap.
//
// One step walks conversations newest first, so the recent days fill in
// first, and reads each one's messages of the kind's role since `after`.
// Messages can be large, so a step stops at a byte budget and schedules the
// next from where it stopped. `run` labels the rebuild in the logs, and
// `progress` lists the steps still to run.
const STEP_BYTES = 4_000_000;
const STEP_CONVERSATIONS = 150;
const WIPE_ROWS = 500;
const LIVE_GRACE_MS = 60_000;
// A queued message this soon after a program launched the session is the
// launcher's brief. Rows from before the queue recorded who wrote a message
// have nothing else to tell the brief from a person's later follow-up.
const BRIEF_WINDOW_MS = 5 * 60_000;

const usageSignature = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }) =>
  `${u.input_tokens}/${u.output_tokens}/${u.cache_read_input_tokens ?? 0}/${u.cache_creation_input_tokens ?? 0}`;

const kindArg = v.optional(v.union(v.literal("sends"), v.literal("usage")));
type Kind = "sends" | "usage";
const WIPE_TABLES: Record<Kind, string[]> = { sends: ["user_send_daily"], usage: ["usage_pending", "user_usage_daily"] };

// The steps of a rebuild still queued or running. A rebuild is finished only
// when none are left: its counter rows appear early and keep growing after.
async function pendingSteps(ctx: { db: any }, kind?: Kind) {
  // A live step was scheduled moments ago by the one before it, so the newest
  // jobs hold every one; the whole table is past a function's read limit.
  const jobs = await ctx.db.system.query("_scheduled_functions").order("desc").take(500);
  return jobs.filter(
    (j: any) =>
      (j.state.kind === "pending" || j.state.kind === "inProgress") &&
      j.name.startsWith("sendBackfill") &&
      /:(start|wipe|step)$/.test(j.name) &&
      (!kind || (j.args[0]?.kind ?? "sends") === kind),
  );
}

export const progress = internalQuery({
  args: {},
  handler: async (ctx) => {
    const jobs = await pendingSteps(ctx);
    return jobs.map((j: any) => ({ name: j.name, state: j.state.kind, kind: j.args[0]?.kind ?? "sends", run: j.args[0]?.run, conv_before: j.args[0]?.conv_before }));
  },
});

export const start = internalMutation({
  args: { after: v.number(), run: v.string(), kind: kindArg },
  handler: async (ctx, args) => {
    // A rebuild still walking would add its counts on top of this one's. A
    // running step cannot be cancelled and queues its successor when it ends,
    // so wait for it; the queued ones are cancelled here.
    const jobs = await pendingSteps(ctx, args.kind ?? "sends");
    if (jobs.some((j: any) => j.state.kind === "inProgress")) throw new Error("A rebuild step is running; start again in a few seconds.");
    for (const job of jobs) await ctx.scheduler.cancel(job._id);
    const before = Date.now() - LIVE_GRACE_MS;
    await ctx.scheduler.runAfter(0, internal.sendBackfill.wipe, { after: args.after, run: args.run, before, kind: args.kind });
    return { before, cancelled: jobs.length };
  },
});

// Empty the counters in small batches (live counting writes the same table),
// then begin the walk.
export const wipe = internalMutation({
  args: { after: v.number(), before: v.number(), run: v.string(), kind: kindArg },
  handler: async (ctx, args) => {
    let full = false;
    for (const table of WIPE_TABLES[args.kind ?? "sends"]) {
      const rows = await ctx.db.query(table as any).take(WIPE_ROWS);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === WIPE_ROWS) { full = true; break; }
    }
    if (full) {
      await ctx.scheduler.runAfter(0, internal.sendBackfill.wipe, args);
      return;
    }
    // Usage is counted live the moment a turn is inserted, not after a grace,
    // so the walk takes over exactly where the emptied counters stop: every
    // turn inserted before this transaction, which just removed their counts.
    const before = (args.kind ?? "sends") === "usage" ? Date.now() : args.before;
    await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...args, before });
  },
});

export const step = internalMutation({
  args: {
    after: v.number(),
    before: v.number(),
    run: v.string(),
    kind: kindArg,
    // Resume point: conversations created before this are still to do...
    conv_before: v.optional(v.number()),
    // ...or this one is half read, up to this message timestamp.
    conv_id: v.optional(v.id("conversations")),
    msg_after: v.optional(v.number()),
    // The usage block last counted in the half-read conversation: one turn is
    // several records that repeat it, and they can straddle two steps.
    usage_after: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const kind = args.kind ?? "sends";
    const range = { after: args.after, before: args.before, run: args.run, kind: args.kind };
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
      const usageAfter = resume ? args.usage_after : undefined;
      resume = null;
      // Sends belong to the session a person typed in; tokens are billed in
      // subagents too.
      if ((kind === "usage" || !c.parent_conversation_id) && (c.updated_at ?? c._creationTime) >= args.after) {
        // A fork starts with a copy of its parent's history, which the parent
        // already counts: the fork owns only what came after it was created.
        const from = c.forked_from ? Math.max(msgAfter, c._creationTime - 1) : msgAfter;
        const launched = isProgramLaunched(c);
        const msgs = ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", c._id).eq("role", kind === "usage" ? "assistant" : "user").gt("timestamp", from),
          );
        const turns: UsageTurn[] = [];
        // Stored messages keep no Claude message id. The records of one turn
        // repeat its usage block exactly, one after another, and two distinct
        // turns in a row practically never match on all four counts.
        let lastUsage = usageAfter;
        for await (const m of msgs) {
          bytes += approxMessageBytes(m as any);
          if (m._creationTime < args.before) {
            if (kind === "usage") {
              const sig = m.usage && usageSignature(m.usage);
              if (m.usage && sig !== lastUsage) {
                turns.push({ usage: m.usage, model: m.model, timestamp: m.timestamp });
                lastUsage = sig;
              }
            } else {
              const brief = launched && m.timestamp < c._creationTime + BRIEF_WINDOW_MS;
              const queued = m.from_user_id ? (brief ? "program" : "person") : undefined;
              await maybeRecordUserSend(ctx, c, { _id: m._id, role: m.role, content: m.content, tool_results: m.tool_results, from_user_id: m.from_user_id, queued }, m.timestamp);
            }
          }
          if (bytes > STEP_BYTES) {
            await recordUsageDays(ctx, c, turns);
            await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...range, conv_before: convBefore, conv_id: c._id, msg_after: m.timestamp, usage_after: lastUsage });
            return;
          }
        }
        await recordUsageDays(ctx, c, turns);
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

// Audit one user's usage for a UTC day, per session, deduped the way the usage
// rebuild dedupes, so it can be matched against the transcripts on a machine.
// Page with the returned cursor until it is null.
// `packages/convex/run.sh sendBackfill:auditUsageDay`.
export const auditUsageDay = internalQuery({
  args: { user_id: v.id("users"), day_start: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const end = args.day_start + 86_400_000;
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.user_id).gte("updated_at", args.day_start))
      .paginate({ numItems: 8, cursor: args.cursor ?? null });
    const rows: any[] = [];
    for (const c of page.page) {
      const from = c.forked_from ? Math.max(args.day_start, c._creationTime) : args.day_start;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", c._id).eq("role", "assistant").gte("timestamp", from).lt("timestamp", end))
        .take(4000);
      let last: string | undefined;
      let tokens = 0, turns = 0, spend = 0;
      for (const m of msgs) {
        if (!m.usage) continue;
        const sig = usageSignature(m.usage);
        if (sig === last) continue;
        last = sig;
        turns++;
        tokens += turnTokens(m.usage);
        spend += turnCost(m.model ?? c.model, m.usage);
      }
      if (turns) rows.push({ session_id: c.session_id, short_id: c.short_id, forked: !!c.forked_from, parent: !!c.parent_conversation_id, agent: c.agent_type, turns, tokens, spend: Math.round(spend * 100) / 100, capped: msgs.length === 4000 });
    }
    return { cursor: page.isDone ? null : page.continueCursor, rows };
  },
});
