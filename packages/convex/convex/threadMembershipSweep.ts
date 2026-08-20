import { v } from "convex/values";
import { internalMutation, internalAction } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isHumanTask, taskThreadParticipants } from "./threadReads";

// Retroactive sweep for the thread-membership rules (pl-394): task threads
// reach only people enrolled by a HUMAN act. Legacy entity_subscriptions rows
// predate the `via` stamp, so this sweep classifies them once, then deletes
// every task thread_reads row whose user is not a participant under
// taskThreadParticipants, and removes rows pointing at deleted tasks.
//
//   npx convex run threadMembershipSweep:sweep '{}'                 # dry run, counts only
//   npx convex run threadMembershipSweep:sweep '{"dryRun": false}'  # stamp + delete
//
// Idempotent: a stored via is never rewritten (the live write path already
// stamps every new row), and a second live run finds nothing left to stamp or
// purge. Restartable: each page is its own transaction; rerunning the action
// resumes the remaining work from scratch at no cost.
//
// Classification of a legacy row (no via), from ct-44741's prod measurements:
//  - creator: human iff the task is a human task (human/meeting origin or
//    promoted) — an agent-origin create records the owner by identity only.
//  - assignee: agent iff the task is agent-origin AND the assignee is the
//    owner (an agent's own `cast task start` under the owner's token);
//    otherwise human.
//  - commenter: task_comments carry no author_user_id on legacy rows, so the
//    only signal is the comment row itself: a comment with no conversation_id
//    whose author is not an agent label and loosely matches the subscribed
//    user's name/email marks the row human; else agent.
//  - mentioned / watching: membership never reads via on these; left as-is.

const PAGE = 200;

type Via = "human" | "agent";

// Author labels agents and the server write on task comments (measured on
// prod: Claude, Mr Bot, mining, unknown; "system" is the server's fallback).
const AGENT_AUTHORS = new Set([
  "claude", "codex", "opencode", "gemini", "mr bot", "mining", "unknown", "system",
]);

function isAgentAuthor(author: string): boolean {
  const a = author.trim().toLowerCase();
  return !a || AGENT_AUTHORS.has(a) || a.startsWith("agent");
}

// Author strings drift ("ashot" vs "Ashot Petrosian"), so match on name
// tokens, email local parts and the github handle rather than the whole
// string. Exact matching catches 16 of the ~760 real human commenter rows.
function authorMatchesUser(author: string, user: Doc<"users"> | null): boolean {
  if (!user) return false;
  const a = author.trim().toLowerCase();
  if (a.length < 3) return false;
  const tokens = new Set<string>();
  for (const t of String(user.name ?? "").toLowerCase().split(/\s+/)) {
    if (t.length >= 3) tokens.add(t);
  }
  for (const email of [user.email, ...(user.alternate_emails ?? [])]) {
    const local = String(email ?? "").toLowerCase().split("@")[0];
    if (local.length >= 3) tokens.add(local);
  }
  const gh = String(user.github_username ?? "").toLowerCase();
  if (gh.length >= 3) tokens.add(gh);
  for (const t of tokens) {
    if (a === t || a.includes(t) || t.includes(a)) return true;
  }
  return false;
}

type Loaders = {
  user: (id: Id<"users">) => Promise<Doc<"users"> | null>;
  comments: (taskId: Id<"tasks">) => Promise<Doc<"task_comments">[]>;
};

/** The via a legacy row earns, or null for reasons membership reads without via. */
async function classifyVia(
  sub: Doc<"entity_subscriptions">,
  task: Doc<"tasks">,
  loaders: Loaders,
): Promise<Via | null> {
  if (sub.reason === "creator") return isHumanTask(task) ? "human" : "agent";
  if (sub.reason === "assignee") {
    return !isHumanTask(task) && String(sub.user_id) === String(task.user_id)
      ? "agent"
      : "human";
  }
  if (sub.reason === "commenter") {
    const user = await loaders.user(sub.user_id);
    const comments = await loaders.comments(task._id);
    const human = comments.some((c) =>
      !c.conversation_id && !isAgentAuthor(c.author) && authorMatchesUser(c.author, user));
    return human ? "human" : "agent";
  }
  return null;
}

export const sweepPage = internalMutation({
  args: {
    step: v.union(v.literal("subscriptions"), v.literal("threadReads")),
    cursor: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;

    const taskCache = new Map<string, Doc<"tasks"> | null>();
    const taskOf = async (id: string) => {
      const key = String(id);
      if (!taskCache.has(key)) {
        const normalized = ctx.db.normalizeId("tasks", key);
        taskCache.set(key, normalized ? await ctx.db.get(normalized) : null);
      }
      return taskCache.get(key) ?? null;
    };
    const userCache = new Map<string, Doc<"users"> | null>();
    const userOf = async (id: Id<"users">) => {
      const key = String(id);
      if (!userCache.has(key)) userCache.set(key, await ctx.db.get(id));
      return userCache.get(key) ?? null;
    };
    const commentsCache = new Map<string, Doc<"task_comments">[]>();
    const loaders: Loaders = {
      user: userOf,
      comments: async (taskId) => {
        const key = String(taskId);
        if (!commentsCache.has(key)) {
          commentsCache.set(key, await ctx.db
            .query("task_comments")
            .withIndex("by_task_id", (q: any) => q.eq("task_id", taskId))
            .collect());
        }
        return commentsCache.get(key)!;
      },
    };

    const perUser: Record<string, Record<string, number>> = {};
    const bump = async (id: Id<"users">, field: string) => {
      const user = await userOf(id);
      const name = user?.name ?? user?.email ?? String(id);
      (perUser[name] ??= {})[field] = (perUser[name][field] ?? 0) + 1;
    };

    if (args.step === "subscriptions") {
      const page = await ctx.db
        .query("entity_subscriptions")
        .withIndex("by_entity", (q: any) => q.eq("entity_type", "task"))
        .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
      let keptStored = 0;
      let viaIndependent = 0;
      const orphans: Record<string, number> = {};
      const stamped: Record<string, Record<Via, number>> = {};
      for (const sub of page.page) {
        const task = await taskOf(sub.entity_id);
        if (!task) {
          orphans[sub.reason] = (orphans[sub.reason] ?? 0) + 1;
          await bump(sub.user_id, "orphanSubs");
          if (!dryRun) await ctx.db.delete(sub._id);
          continue;
        }
        if (sub.via) { keptStored++; continue; }
        const via = await classifyVia(sub, task, loaders);
        if (!via) { viaIndependent++; continue; }
        (stamped[sub.reason] ??= { human: 0, agent: 0 })[via]++;
        await bump(sub.user_id, via === "human" ? "stampedHuman" : "stampedAgent");
        if (!dryRun) await ctx.db.patch(sub._id, { via });
      }
      return {
        scanned: page.page.length,
        keptStored,
        viaIndependent,
        orphans,
        stamped,
        perUser,
        cursor: page.continueCursor,
        isDone: page.isDone,
      };
    }

    const page = await ctx.db
      .query("thread_reads")
      .withIndex("by_kind_root", (q: any) => q.eq("kind", "task"))
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE });
    const participantsCache = new Map<string, string[]>();
    const participantsOf = async (task: Doc<"tasks">) => {
      const key = String(task._id);
      if (!participantsCache.has(key)) {
        const raw = await ctx.db
          .query("entity_subscriptions")
          .withIndex("by_entity", (q: any) =>
            q.eq("entity_type", "task").eq("entity_id", String(task._id)))
          .collect();
        // Overlay the via each legacy row earns, so a dry run answers for the
        // post-stamp world without step 1 having written anything. On a live
        // run step 1 already stamped every row and this is a no-op.
        const subs = await Promise.all(raw.map(async (s) =>
          s.via ? s : { ...s, via: (await classifyVia(s, task, loaders)) ?? undefined }));
        const ids = await taskThreadParticipants(ctx, task, subs);
        participantsCache.set(key, ids.map(String));
      }
      return participantsCache.get(key)!;
    };
    let kept = 0;
    let purged = 0;
    let orphans = 0;
    for (const row of page.page) {
      const task = await taskOf(String(row.task_id ?? row.root_key));
      if (!task) {
        orphans++;
        await bump(row.user_id, "orphanReads");
        if (!dryRun) await ctx.db.delete(row._id);
        continue;
      }
      const members = await participantsOf(task);
      if (members.includes(String(row.user_id))) {
        kept++;
        await bump(row.user_id, "kept");
      } else {
        purged++;
        await bump(row.user_id, "purged");
        if (!dryRun) await ctx.db.delete(row._id);
      }
    }
    return {
      scanned: page.page.length,
      kept,
      purged,
      orphans,
      perUser,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

// Numeric leaves add; nested objects (orphans, stamped, perUser) merge.
// Cursor strings and isDone booleans fall through untouched.
function mergeCounts(into: any, from: any) {
  for (const [k, val] of Object.entries(from)) {
    if (typeof val === "number") into[k] = (into[k] ?? 0) + val;
    else if (val && typeof val === "object") mergeCounts((into[k] ??= {}), val);
  }
  return into;
}

export const sweep = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const run = async (step: "subscriptions" | "threadReads") => {
      const totals: any = {};
      let cursor: string | undefined;
      for (;;) {
        const res: any = await ctx.runMutation(internal.threadMembershipSweep.sweepPage, {
          step,
          cursor,
          dryRun,
        });
        const { cursor: _c, isDone, ...counts } = res;
        mergeCounts(totals, counts);
        if (isDone) break;
        cursor = res.cursor;
      }
      return totals;
    };
    // Order matters on a live run: thread_reads membership reads the stamps.
    const subscriptions = await run("subscriptions");
    const threadReads = await run("threadReads");
    return { dryRun, subscriptions, threadReads };
  },
});
