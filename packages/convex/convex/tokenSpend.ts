import { v } from "convex/values";
import { internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Token and API-cost reporting over a time window, per person / project / agent.
//
// Source of truth is conversations.usage_totals — the per-session rollup
// messages.rollUpUsage writes at ingest, deduped by Claude's api_message_id.
// The messages table carries the same numbers per turn, but its docs hold
// content, thinking and tool payloads, so a month of them is gigabytes of read
// bandwidth for four integers. Two consequences the caller must report:
//   1. The rollup is lifetime-of-conversation. Windowing on updated_at counts a
//      session's whole total if it was active in the window, so we also return
//      the slice that started before it (started_before_window) as the exposure.
//   2. The rollup has no model breakdown; model here is conversations.model,
//      the last-known value. Sessions that switched models mis-attribute.
// Backends that report no usage (codex, gemini, ...) have no usage_totals at
// all; those sessions are counted separately as "not counted".

export const findPeople = internalQuery({
  args: { needles: v.array(v.string()) },
  handler: async (ctx, args) => {
    const needles = args.needles.map((n) => n.toLowerCase());
    const users = await ctx.db.query("users").collect();
    const out: Array<{ id: string; name: string; email: string; needle: string; is_bot: boolean }> = [];
    for (const u of users) {
      const hay = [u.name, u.email, u.github_username, ...(u.alternate_emails ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const hit = needles.find((n) => hay.includes(n));
      if (!hit) continue;
      out.push({
        id: u._id,
        name: u.name ?? "",
        email: u.email ?? "",
        needle: hit,
        is_bot: u.is_bot === true,
      });
    }
    return out;
  },
});

export const conversationPage = internalQuery({
  args: {
    userId: v.id("users"),
    since: v.number(),
    until: v.number(),
    cursor: v.union(v.string(), v.null()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", args.userId).gte("updated_at", args.since).lte("updated_at", args.until)
      )
      .order("desc")
      .paginate({ cursor: args.cursor, numItems: args.limit });
    return {
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      rows: page.page.map((c) => ({
        agent_type: c.agent_type,
        model: c.model ?? null,
        project_path: c.project_path ?? null,
        git_root: c.git_root ?? null,
        git_remote_url: c.git_remote_url ?? null,
        started_at: c.started_at,
        updated_at: c.updated_at,
        message_count: c.message_count,
        is_subagent: c.is_subagent === true,
        // A fork COPIES the parent's messages, and rollUpUsage dedupes by
        // api_message_id only within one conversation — so a forked row counts
        // turns the parent already counted. Returned so the report can bound
        // that double count instead of hiding it.
        is_fork: c.forked_from != null,
        usage: c.usage_totals
          ? {
              input: c.usage_totals.input,
              output: c.usage_totals.output,
              cache_read: c.usage_totals.cache_read,
              cache_write: c.usage_totals.cache_write,
            }
          : null,
      })),
    };
  },
});

// A project name a human recognises. Three corrections a basename gets wrong:
// a worktree lives at <repo>/.codecast/worktrees/<name>, so its basename is the
// feature; a session started in a subdirectory (~/src/union/backend) reads as
// the subdirectory, not the repo; and the workspace convention is ~/src/<project>,
// so the segment after the last /src/ is the project. git_root beats
// project_path because it already points at the repo when it is known.
export function projectOf(row: { project_path: string | null; git_root: string | null }): string {
  const raw = row.git_root ?? row.project_path;
  if (!raw) return "(no project)";
  const cut = raw.split("/.codecast/worktrees/")[0];
  const marker = "/src/";
  const at = cut.lastIndexOf(marker);
  if (at >= 0) {
    const after = cut.slice(at + marker.length).split("/").filter(Boolean);
    if (after.length) return after[0];
  }
  const parts = cut.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "(no project)";
}

type Bucket = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  sessions: number;
  sessions_no_usage: number;
  messages: number;
};

const emptyBucket = (): Bucket => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  sessions: 0,
  sessions_no_usage: 0,
  messages: 0,
});

function add(b: Bucket, u: { input: number; output: number; cache_read: number; cache_write: number } | null, messages: number) {
  b.sessions += 1;
  b.messages += messages;
  if (!u) {
    b.sessions_no_usage += 1;
    return;
  }
  b.input += u.input;
  b.output += u.output;
  b.cache_read += u.cache_read;
  b.cache_write += u.cache_write;
}

export const report = internalAction({
  args: {
    needles: v.array(v.string()),
    since: v.number(),
    until: v.number(),
  },
  handler: async (ctx, args): Promise<any> => {
    const people = await ctx.runQuery(internal.tokenSpend.findPeople, { needles: args.needles });
    const humans = people.filter((p) => !p.is_bot);

    const results: any[] = [];
    for (const person of humans) {
      const byProject: Record<string, Bucket> = {};
      const byAgent: Record<string, Bucket> = {};
      const byModel: Record<string, Bucket> = {};
      const byProjectModel: Record<string, Bucket> = {};
      const total = emptyBucket();
      // Exposure: the same sums restricted to sessions that also STARTED inside
      // the window, so the caller can say how much of the total is clean.
      const startedInWindow = emptyBucket();
      // Usage sitting on forked rows: the ceiling on the fork double count.
      const forked = emptyBucket();
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page: any = await ctx.runQuery(internal.tokenSpend.conversationPage, {
          userId: person.id as any,
          since: args.since,
          until: args.until,
          cursor,
          limit: 400,
        });
        pages += 1;
        for (const row of page.rows) {
          const project = projectOf(row);
          const model = row.model ?? "(unknown)";
          add((byProject[project] ??= emptyBucket()), row.usage, row.message_count);
          add((byAgent[row.agent_type] ??= emptyBucket()), row.usage, row.message_count);
          add((byModel[model] ??= emptyBucket()), row.usage, row.message_count);
          const pm = `${project} :: ${model}`;
          add((byProjectModel[pm] ??= emptyBucket()), row.usage, row.message_count);
          add(total, row.usage, row.message_count);
          if (row.started_at >= args.since) add(startedInWindow, row.usage, row.message_count);
          if (row.is_fork) add(forked, row.usage, row.message_count);
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
        if (pages > 200) break;
      }
      results.push({
        person: { id: person.id, name: person.name, email: person.email, needle: person.needle },
        total,
        startedInWindow,
        forked,
        byProject,
        byAgent,
        byModel,
        byProjectModel,
        pages,
      });
    }
    return { window: { since: args.since, until: args.until }, people: results, matched: people };
  },
});

// Coverage diagnostic. usage_totals is written at message ingest, so a session
// can lack it for two very different reasons: the backend reports no usage, or
// the session predates / bypassed the rollup. This bins claude_code sessions by
// the day they were last active and reports how many carry a rollup, which
// tells the two apart. Pages like report() does — a month of conversation docs
// is past a single query's byte budget.
export const coverage = internalAction({
  args: { userId: v.id("users"), since: v.number(), until: v.number() },
  handler: async (ctx, args): Promise<any> => {
    const bins: Record<string, { with_usage: number; without: number; msgs_with: number; msgs_without: number }> = {};
    let cursor: string | null = null;
    for (;;) {
      const page: any = await ctx.runQuery(internal.tokenSpend.conversationPage, {
        userId: args.userId,
        since: args.since,
        until: args.until,
        cursor,
        limit: 400,
      });
      for (const row of page.rows) {
        if (row.agent_type !== "claude_code") continue;
        const day = new Date(row.updated_at).toISOString().slice(0, 10);
        const bin = (bins[day] ??= { with_usage: 0, without: 0, msgs_with: 0, msgs_without: 0 });
        if (row.usage) {
          bin.with_usage += 1;
          bin.msgs_with += row.message_count;
        } else {
          bin.without += 1;
          bin.msgs_without += row.message_count;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return bins;
  },
});

// Does the messages table carry per-turn usage further back than the
// conversations rollup does? The rollup only began on 2026-09-13; messages.usage
// is an older field, so this samples assistant messages around a timestamp and
// reports how many carry a usage block, plus the average doc size, which sets
// the cost of aggregating a whole month from messages.
export const messageUsageProbe = internalQuery({
  args: { userId: v.id("users"), around: v.number(), sampleConversations: v.number() },
  handler: async (ctx, args) => {
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", args.userId).lte("updated_at", args.around))
      .order("desc")
      .take(args.sampleConversations);
    let withUsage = 0;
    let withoutUsage = 0;
    let bytes = 0;
    let sampled = 0;
    const models = new Set<string>();
    for (const c of convs) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", c._id).eq("role", "assistant")
        )
        .take(40);
      for (const m of msgs) {
        sampled += 1;
        bytes += JSON.stringify(m).length;
        if (m.usage) {
          withUsage += 1;
          if (m.model) models.add(m.model);
        } else {
          withoutUsage += 1;
        }
      }
    }
    return {
      conversations: convs.length,
      newest_updated_at: convs[0]?.updated_at ?? null,
      oldest_updated_at: convs[convs.length - 1]?.updated_at ?? null,
      sampled,
      withUsage,
      withoutUsage,
      avg_doc_bytes: sampled ? Math.round(bytes / sampled) : 0,
      models: [...models],
    };
  },
});
