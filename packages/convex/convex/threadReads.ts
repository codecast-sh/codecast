// thread_reads: one row per (user, thread) across every threaded system. This
// module owns the rows' write rules and nothing else: it never imports chat,
// comments, tasks or threads, so each of those can call it without a cycle.
//
// The rules, once. A thread appears in someone's inbox when a VISIBLE reply
// lands and they are a participant (the caller resolves who that is). The
// writer's own row reads as read; everyone pulled in starts unread. Every
// mark moves forward only: an out-of-order write must never resurrect replies
// already seen. Bots never get a row: an anchor has no inbox.

import { internalMutation, internalQuery } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { isSilentAgentRow } from "@codecast/shared/chat";
import { commentThreadRootKey } from "@codecast/shared/comments";

export type ThreadKind = "chat" | "comment" | "task" | "page";
export const threadKindValidator = v.union(
  v.literal("chat"),
  v.literal("comment"),
  v.literal("task"),
  v.literal("page"),
);

/** How many participants one touch may file. A thread with more readers than
 *  this is a channel, not a thread. */
export const THREAD_PARTICIPANT_CAP = 200;

/** How many rows the badge and the "mark all read" sweep scan. Far above any
 *  real inbox's unread tail; a person with more is shown a floor, not a lie. */
export const THREAD_BADGE_SCAN = 200;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type ThreadRefs = {
  channel_id?: Id<"chat_channels">;
  conversation_id?: Id<"conversations">;
  task_id?: Id<"tasks">;
  artifact_id?: Id<"artifacts">;
  message_id?: Id<"messages">;
  file_path?: string;
  line_number?: number;
};

export type TouchThreadOptions = {
  kind: ThreadKind;
  rootKey: string;
  /** The entity's routing team; undefined is the personal inbox. */
  teamId?: Id<"teams">;
  refs: ThreadRefs;
  /** Already resolved by the caller. Deduped, bots skipped, capped inside. */
  participants: Id<"users">[];
  /** The writer: their row reads as read. Undefined for agent and system
   *  posts, so everyone starts unread. */
  actorId?: Id<"users">;
  /** The landing row's stamp; becomes every participant's last_activity_at. */
  activityAt: number;
};

async function findRow(
  ctx: ReadCtx,
  userId: Id<"users">,
  kind: ThreadKind,
  rootKey: string,
): Promise<Doc<"thread_reads"> | null> {
  return await ctx.db
    .query("thread_reads")
    .withIndex("by_user_kind_root", (q: any) =>
      q.eq("user_id", userId).eq("kind", kind).eq("root_key", rootKey))
    .first();
}

// The one write path. Insert with the given marks; on an existing row move
// both marks forward only. touchThread, the copy and the backfill all reduce
// to this, so "never lower a mark" is enforced in exactly one place.
async function upsertThreadRead(
  ctx: MutationCtx,
  opts: {
    userId: Id<"users">;
    kind: ThreadKind;
    rootKey: string;
    teamId?: Id<"teams">;
    refs: ThreadRefs;
    activityAt: number;
    readAt: number;
  },
): Promise<void> {
  const now = Date.now();
  const existing = await findRow(ctx, opts.userId, opts.kind, opts.rootKey);
  if (!existing) {
    await ctx.db.insert("thread_reads", {
      user_id: opts.userId,
      kind: opts.kind,
      root_key: opts.rootKey,
      team_id: opts.teamId,
      last_activity_at: opts.activityAt,
      last_read_at: opts.readAt,
      updated_at: now,
      ...opts.refs,
    });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (opts.activityAt > existing.last_activity_at) patch.last_activity_at = opts.activityAt;
  if (opts.readAt > existing.last_read_at) patch.last_read_at = opts.readAt;
  if (Object.keys(patch).length === 0) return;
  await ctx.db.patch(existing._id, { ...patch, updated_at: now });
}

// A per-call memo of "is this a real person": the same author repeats across
// a page of rows, and a bot must never get a row.
function personCheck(ctx: ReadCtx) {
  const cache = new Map<string, boolean>();
  return async (userId: Id<"users">): Promise<boolean> => {
    const key = String(userId);
    if (!cache.has(key)) {
      const user = await ctx.db.get(userId);
      cache.set(key, !!user && !user.is_bot);
    }
    return cache.get(key)!;
  };
}

function dedupe(ids: Array<Id<"users"> | undefined | null>, cap = THREAD_PARTICIPANT_CAP): Id<"users">[] {
  const seen = new Set<string>();
  const out: Id<"users">[] = [];
  for (const id of ids) {
    if (!id) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

/** A visible reply landed: file the thread for every participant. */
export async function touchThread(ctx: MutationCtx, opts: TouchThreadOptions): Promise<void> {
  const isPerson = personCheck(ctx);
  for (const userId of dedupe([...opts.participants, opts.actorId])) {
    if (!(await isPerson(userId))) continue;
    const isActor = String(opts.actorId) === String(userId);
    await upsertThreadRead(ctx, {
      userId,
      kind: opts.kind,
      rootKey: opts.rootKey,
      teamId: opts.teamId,
      refs: opts.refs,
      activityAt: opts.activityAt,
      // A participant pulled in by this reply starts with the whole thread
      // unread; the author starts read.
      readAt: isActor ? opts.activityAt : 0,
    });
  }
}

/** Every follow of one thread, for a hard purge of the entity. */
export async function purgeThread(ctx: MutationCtx, kind: ThreadKind, rootKey: string): Promise<number> {
  const rows = await ctx.db
    .query("thread_reads")
    .withIndex("by_kind_root", (q: any) => q.eq("kind", kind).eq("root_key", rootKey))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** Every follow in one channel, for a channel purge. No caller yet: chat has
 *  archiveChannel but no hard delete. Kept with the by_channel index it pairs
 *  with, for the day one exists. */
export async function purgeChannelThreads(ctx: MutationCtx, channelId: Id<"chat_channels">): Promise<number> {
  const rows = await ctx.db
    .query("thread_reads")
    .withIndex("by_channel", (q: any) => q.eq("channel_id", channelId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** One member's follows in one team (all kinds), or only those in one channel
 *  when `channelId` is given. Called when they leave the team or the room: the
 *  badge scan counts rows without re-reading access, so a leftover follow
 *  would keep a room they cannot see ticking their badge. */
export async function purgeUserTeam(
  ctx: MutationCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
  channelId?: Id<"chat_channels">,
): Promise<number> {
  const rows = await ctx.db
    .query("thread_reads")
    .withIndex("by_user_team_activity", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .collect();
  let count = 0;
  for (const row of rows) {
    if (channelId && String(row.channel_id) !== String(channelId)) continue;
    await ctx.db.delete(row._id);
    count++;
  }
  return count;
}

// ── Migration and backfill ──────────────────────────────────────────────────
//
// Every mutation below is paged and reschedules itself, and every row it
// writes goes through the forward-only upsert, so each can be re-run safely
// and a live touch that lands mid-run is never lowered.

const MIGRATION_PAGE = 400;

/** For the migration count check: thread_reads rows, optionally of one kind. */
export const countThreadReads = internalQuery({
  args: { kind: v.optional(threadKindValidator) },
  handler: async (ctx, args) => {
    let count = 0;
    for await (const row of ctx.db.query("thread_reads")) {
      if (!args.kind || row.kind === args.kind) count++;
    }
    return count;
  },
});

// Seeds thread_reads from existing history, one page of source rows at a
// time. Every seeded row starts READ (last_read_at = last_activity_at): the
// feature's arrival must not hand everyone months of phantom unread.
export const backfillThreadReads = internalMutation({
  args: { kind: threadKindValidator, cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isPerson = personCheck(ctx);
    const seed = async (
      userIds: Array<Id<"users"> | undefined | null>,
      opts: { kind: ThreadKind; rootKey: string; teamId?: Id<"teams">; refs: ThreadRefs; at: number },
    ) => {
      for (const userId of dedupe(userIds)) {
        if (!(await isPerson(userId))) continue;
        await upsertThreadRead(ctx, {
          userId,
          kind: opts.kind,
          rootKey: opts.rootKey,
          teamId: opts.teamId,
          refs: opts.refs,
          activityAt: opts.at,
          readAt: opts.at,
        });
      }
    };

    let scanned = 0;
    let isDone = true;
    let continueCursor = "";

    if (args.kind === "chat") {
      const page = await ctx.db
        .query("chat_messages")
        .paginate({ numItems: MIGRATION_PAGE, cursor: args.cursor ?? null });
      const rootCache = new Map<string, Doc<"chat_messages"> | null>();
      for (const row of page.page) {
        if (!row.thread_root_id || row.deleted_at || isSilentAgentRow(row)) continue;
        const rootKey = String(row.thread_root_id);
        if (!rootCache.has(rootKey)) rootCache.set(rootKey, await ctx.db.get(row.thread_root_id));
        const root = rootCache.get(rootKey);
        if (!root) continue;
        await seed([row.user_id, root.user_id], {
          kind: "chat",
          rootKey,
          teamId: row.team_id,
          refs: { channel_id: row.channel_id },
          at: row.created_at,
        });
      }
      ({ isDone, continueCursor } = page);
      scanned = page.page.length;
    } else if (args.kind === "comment") {
      const page = await ctx.db
        .query("comments")
        .withIndex("by_created_at")
        .paginate({ numItems: MIGRATION_PAGE, cursor: args.cursor ?? null });
      const conversationCache = new Map<string, Doc<"conversations"> | null>();
      for (const row of page.page) {
        // An unfinished agent placeholder is not a reply yet.
        if (row.agent_status === "thinking" || row.agent_status === "streaming") continue;
        const convKey = String(row.conversation_id);
        if (!conversationCache.has(convKey)) {
          conversationCache.set(convKey, await ctx.db.get(row.conversation_id));
        }
        const conversation = conversationCache.get(convKey);
        if (!conversation) continue;
        await seed([row.user_id, conversation.user_id], {
          kind: "comment",
          rootKey: commentThreadRootKey(convKey, row),
          teamId: conversation.team_id,
          refs: {
            conversation_id: row.conversation_id,
            message_id: row.message_id,
            file_path: row.file_path,
            line_number: row.line_number,
          },
          at: row.created_at,
        });
      }
      ({ isDone, continueCursor } = page);
      scanned = page.page.length;
    } else if (args.kind === "page") {
      const page = await ctx.db
        .query("artifact_comments")
        .paginate({ numItems: MIGRATION_PAGE, cursor: args.cursor ?? null });
      const artifactCache = new Map<string, { artifact: Doc<"artifacts">; participants: Id<"users">[] } | null>();
      for (const row of page.page) {
        const artifactKey = String(row.artifact_id);
        if (!artifactCache.has(artifactKey)) {
          const artifact = await ctx.db.get(row.artifact_id);
          artifactCache.set(artifactKey, artifact
            ? { artifact, participants: await pageThreadParticipants(ctx, artifact) }
            : null);
        }
        const entry = artifactCache.get(artifactKey);
        if (!entry) continue;
        await seed(entry.participants, {
          kind: "page",
          rootKey: artifactKey,
          refs: { artifact_id: entry.artifact._id },
          at: row.created_at,
        });
      }
      ({ isDone, continueCursor } = page);
      scanned = page.page.length;
    } else {
      const page = await ctx.db
        .query("task_comments")
        .paginate({ numItems: MIGRATION_PAGE, cursor: args.cursor ?? null });
      const taskCache = new Map<string, { task: Doc<"tasks">; participants: Id<"users">[] } | null>();
      for (const row of page.page) {
        const taskKey = String(row.task_id);
        if (!taskCache.has(taskKey)) {
          const task = await ctx.db.get(row.task_id);
          taskCache.set(taskKey, task
            ? { task, participants: await taskThreadParticipants(ctx, task) }
            : null);
        }
        const entry = taskCache.get(taskKey);
        if (!entry) continue;
        await seed(entry.participants, {
          kind: "task",
          rootKey: taskKey,
          teamId: entry.task.team_id,
          refs: { task_id: entry.task._id },
          at: row.created_at,
        });
      }
      ({ isDone, continueCursor } = page);
      scanned = page.page.length;
    }

    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.threadReads.backfillThreadReads, {
        kind: args.kind,
        cursor: continueCursor,
      });
    }
    return { scanned, done: isDone };
  },
});

/** Who a task's comment stream reaches: its unmuted subscribers who created,
 *  own, commented on or were named in it, plus its creator and assignee.
 *  Shared by the live touch in tasks.ts and the backfill above. */
export async function taskThreadParticipants(
  ctx: ReadCtx,
  task: Pick<Doc<"tasks">, "_id" | "user_id" | "assignee">,
): Promise<Id<"users">[]> {
  const subscriptions = await ctx.db
    .query("entity_subscriptions")
    .withIndex("by_entity", (q: any) => q.eq("entity_type", "task").eq("entity_id", String(task._id)))
    .collect();
  const subscribed = subscriptions
    .filter((s) => !s.muted && ["creator", "assignee", "commenter", "mentioned"].includes(s.reason))
    .map((s) => s.user_id);
  // An assignee is a user id or an agent label ("agent:codex"): only an id
  // that names a user row is a participant. normalizeId never throws.
  const assigneeId = task.assignee ? ctx.db.normalizeId("users", task.assignee) : null;
  return dedupe([...subscribed, task.user_id, assigneeId]);
}

/** Who a published page's discussion reaches: its owner and every commenter
 *  with a verified account (anonymous names have no inbox). Shared by the
 *  live touch in artifacts.ts and the backfill above. */
export async function pageThreadParticipants(
  ctx: ReadCtx,
  artifact: Pick<Doc<"artifacts">, "_id" | "user_id">,
): Promise<Id<"users">[]> {
  const comments = await ctx.db
    .query("artifact_comments")
    .withIndex("by_artifact", (q: any) => q.eq("artifact_id", artifact._id))
    .collect();
  return dedupe([artifact.user_id, ...comments.map((c) => c.author_user_id)]);
}
