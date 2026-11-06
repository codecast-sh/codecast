// The Threads inbox: every conversation the caller is part of, across chat
// threads, session comment threads and task comment streams, newest activity
// first, with per-thread unread. One table (thread_reads), one query, one
// kind registry: each kind says how to re-check access, count unread, find
// its newest stamp, load the rows a card renders, and preview the last reply.
//
// Scope is (user, team_id) and team_id is optional: absence is the personal
// inbox, a value of its own, never a fallback to some default team. This is
// why nothing here goes through chat's resolveTeamForRead — a person with no
// team still has comments and tasks.
//
// Access is re-checked per row, never trusted from the row: comments and
// tasks have no leave event, and chat membership changes under the rows. A
// row that fails is dropped silently, and the badge counts only rows that
// pass.

import { mutation, query } from "./functions";
import type { CommentWithUser, ListMinePayload, PageComment, PageThreadEntity, ThreadInboxEntry, ThreadLastReply, ThreadRead } from "./threadsTypes";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { getAuthenticatedUserId } from "./pendingMessages";
import { extractMentionHandles, isLiveVoiceRow, isSilentAgentRow } from "@codecast/shared/chat";
import { parseCodeThreadRootKey, parseCommentThreadRootKey } from "@codecast/shared/comments";
import { UNREAD_CAP, plainPreview } from "./chatText";
import {
  THREAD_UNREAD_SCAN,
  authorsFor,
  readChannel,
  requireCaller,
  threadSummariesFor,
  threadUnreadFor,
} from "./chat";
import { isInCommentThread } from "./comments";
import { listConversationComments } from "./commentStore";
import type { ConversationComment } from "./lib/conversationCommentRows";
import { canAccessComment, codeThreadRows } from "./codeComments";
import { canAccessConversation, canAccessTask } from "./lib/access";
import { attachCommentSessionInfo } from "./lib/commentSessionInfo";
import { matchHandle } from "./lib/mentionResolve";
import { decisionThreadKind } from "./decisionThread";
import {
  THREAD_BADGE_SCAN,
  agentCommentLevelOf,
  dropThreadRead,
  taskCommentAuthorKind,
  taskCommentIsForYou,
  taskCommentIsNews,
  taskThreadMembership,
  threadKindValidator,
  type TaskThreadMembership,
  type ThreadKind,
} from "./threadReads";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Per-request memo: the same channel, conversation, task and author repeat
 *  across a page of rows, and a subscription read set should not grow with
 *  duplicates. */
type PageCache = {
  channels: Map<string, Doc<"chat_channels"> | null>;
  roots: Map<string, Doc<"chat_messages"> | null>;
  conversations: Map<string, Doc<"conversations"> | null>;
  commentThreads: Map<string, ConversationComment[]>;
  conversationComments: Map<string, ConversationComment[]>;
  tasks: Map<string, Doc<"tasks"> | null>;
  taskMembership: Map<string, TaskThreadMembership>;
  taskComments: Map<string, Doc<"task_comments">[]>;
  artifacts: Map<string, Doc<"artifacts"> | null>;
  artifactComments: Map<string, Doc<"artifact_comments">[]>;
  codeThreads: Map<string, Doc<"review_comments">[]>;
  users: Map<string, Doc<"users"> | null>;
};

function newPageCache(): PageCache {
  return {
    channels: new Map(),
    roots: new Map(),
    conversations: new Map(),
    commentThreads: new Map(),
    conversationComments: new Map(),
    tasks: new Map(),
    taskMembership: new Map(),
    taskComments: new Map(),
    artifacts: new Map(),
    artifactComments: new Map(),
    codeThreads: new Map(),
    users: new Map(),
  };
}

async function memo<T>(map: Map<string, T>, key: string, load: () => Promise<T>): Promise<T> {
  if (!map.has(key)) map.set(key, await load());
  return map.get(key)!;
}

async function userFor(ctx: ReadCtx, cache: PageCache, userId: Id<"users"> | undefined): Promise<Doc<"users"> | null> {
  if (!userId) return null;
  return await memo(cache.users, String(userId), () => ctx.db.get(userId));
}

function displayName(user: Doc<"users"> | null): string | undefined {
  return user?.name || user?.github_username || user?.email || undefined;
}

/** How many comment rows one thread ships per page: the newest, so a long
 *  thread still renders and replies in place. */
const THREAD_PAYLOAD_ROWS = 50;

function capped(counted: number): { unread: number; unread_capped: boolean } {
  return { unread: Math.min(counted, UNREAD_CAP), unread_capped: counted > UNREAD_CAP };
}

type ThreadKindResolver = {
  access(ctx: ReadCtx, userId: Id<"users">, row: ThreadRead, cache: PageCache): Promise<boolean>;
  unread(ctx: ReadCtx, userId: Id<"users">, row: ThreadRead, cache: PageCache): Promise<{ unread: number; unread_capped: boolean }>;
  /** The newest counted row's stamp, 0 when none. A read mark clamps to it. */
  newestAt(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<number>;
  load(ctx: ReadCtx, userId: Id<"users">, row: ThreadRead, cache: PageCache, payload: ListMinePayload): Promise<void>;
  /** The reply the collapsed row previews: the newest one that is news for
   *  the viewer, else the newest at all. */
  preview(ctx: ReadCtx, userId: Id<"users">, row: ThreadRead, cache: PageCache): Promise<ThreadLastReply | null>;
  title?(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<string | undefined>;
  /** Whether the unread part waits on the viewer (waitsOnViewer's rule).
   *  Only these threads count on the Threads badge; the rest read as
   *  activity. A kind without it never counts (a decision's thread is the
   *  Decisions badge's). */
  forYou?(ctx: ReadCtx, userId: Id<"users">, row: ThreadRead, cache: PageCache): Promise<boolean>;
};

/** Does this text @-name the viewer? */
async function namesViewer(ctx: ReadCtx, cache: PageCache, userId: Id<"users">, text: string | undefined): Promise<boolean> {
  const handles = extractMentionHandles(text ?? "");
  if (!handles.length) return false;
  const viewer = await userFor(ctx, cache, userId);
  return !!viewer && handles.some((h) => matchHandle([viewer], h));
}

/** The rule every kind shares for the Threads badge: an unread reply from a
 *  person waits on the viewer; an agent's only when it names them or answers
 *  something they asked. An agent's progress in a thread they follow is
 *  activity: shown, never counted. */
async function waitsOnViewer<T>(
  ctx: ReadCtx,
  cache: PageCache,
  userId: Id<"users">,
  unread: T[],
  rule: { isAgent: (c: T) => boolean; answersViewer: (c: T) => boolean; text: (c: T) => string | undefined },
): Promise<boolean> {
  for (const c of unread) {
    if (!rule.isAgent(c) || rule.answersViewer(c)) return true;
    if (await namesViewer(ctx, cache, userId, rule.text(c))) return true;
  }
  return false;
}

// ── chat ────────────────────────────────────────────────────────────────────

function chatRootId(row: ThreadRead): Id<"chat_messages"> {
  return row.root_key as Id<"chat_messages">;
}

async function chatRoot(ctx: ReadCtx, row: ThreadRead, cache: PageCache) {
  return await memo(cache.roots, row.root_key, () => ctx.db.get(chatRootId(row)));
}

// The newest visible reply: a tombstone or a silent placeholder at the head
// must not blank the preview.
async function newestChatReply(ctx: ReadCtx, rootId: Id<"chat_messages">) {
  const rows = await ctx.db
    .query("chat_messages")
    .withIndex("by_thread_created", (q: any) => q.eq("thread_root_id", rootId))
    .order("desc")
    .take(4);
  return rows.find((r) => !r.deleted_at && !isSilentAgentRow(r)) ?? null;
}

const chatKind: ThreadKindResolver = {
  async access(ctx, userId, row, cache) {
    // A deleted root still heads its thread (the replies remain), so it
    // renders as the tombstone it is. Only a missing root — a hard purge —
    // drops the entry. Access comes from the channel, not the row: leaving a
    // private room or the team silently removes its threads. Archived rooms
    // leave with it, like the rail.
    const root = await chatRoot(ctx, row, cache);
    if (!root) return false;
    const channelId = row.channel_id ?? root.channel_id;
    const channel = await memo(cache.channels, String(channelId), () => readChannel(ctx, userId, channelId));
    return !!channel && !channel.archived_at;
  },
  async unread(ctx, userId, row) {
    return await threadUnreadFor(ctx, userId, chatRootId(row), row.last_read_at);
  },
  async newestAt(ctx, row) {
    // The newest reply's OWN stamp, not last_activity_at. A visible agent
    // error row is a reply the reader sees and the unread count counts, but it
    // never moves the activity mark (no notification fans out for it) — a mark
    // clamped to activity could never clear past it.
    const newest = await ctx.db
      .query("chat_messages")
      .withIndex("by_thread_created", (q: any) => q.eq("thread_root_id", chatRootId(row)))
      .order("desc")
      .first();
    return newest?.created_at ?? 0;
  },
  async load(ctx, _userId, row, cache, payload) {
    const root = await chatRoot(ctx, row, cache);
    if (root) payload.chat.roots.push(root);
  },
  async forYou(ctx, userId, row, cache) {
    const root = await chatRoot(ctx, row, cache);
    if (!root) return false;
    const channelId = row.channel_id ?? root.channel_id;
    const channel = await memo(cache.channels, String(channelId), () => readChannel(ctx, userId, channelId));
    const unread = (await ctx.db
      .query("chat_messages")
      .withIndex("by_thread_created", (q: any) => q.eq("thread_root_id", root._id).gt("created_at", row.last_read_at))
      .take(THREAD_UNREAD_SCAN))
      .filter((r) => !r.deleted_at && !isSilentAgentRow(r) && !isLiveVoiceRow(r) && String(r.user_id) !== String(userId));
    if (!unread.length) return false;
    if (channel?.kind === "dm") return true;
    const bots = new Set<string>();
    for (const r of unread) if ((await userFor(ctx, cache, r.user_id))?.is_bot) bots.add(String(r.user_id));
    return waitsOnViewer(ctx, cache, userId, unread, {
      isAgent: (r) => r.author_kind === "agent" || bots.has(String(r.user_id)),
      // An agent replying under the viewer's own root answers them.
      answersViewer: (r) => String(root.user_id) === String(userId)
        || (r.mentions ?? []).some((m) => String(m) === String(userId)),
      text: (r) => r.content,
    });
  },
  async preview(ctx, _userId, row, cache) {
    const newest = await newestChatReply(ctx, chatRootId(row));
    if (!newest) return null;
    return {
      _id: String(newest._id),
      user_id: String(newest.user_id),
      author_kind: newest.author_kind ?? "user",
      author_name: displayName(await userFor(ctx, cache, newest.user_id)),
      created_at: newest.created_at,
      preview: plainPreview(newest.content, 160),
    };
  },
};

// ── comment ─────────────────────────────────────────────────────────────────

function commentConversationId(row: ThreadRead): Id<"conversations"> {
  return row.conversation_id ?? (parseCommentThreadRootKey(row.root_key).conversationId as Id<"conversations">);
}

async function commentThread(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<ConversationComment[]> {
  return await memo(cache.commentThreads, row.root_key, async () => {
    const conversationId = commentConversationId(row);
    const anchor = {
      message_id: row.message_id,
      file_path: row.file_path,
      line_number: row.line_number,
    };
    // Read the conversation's comments ONCE and filter per anchor, so N
    // anchored threads cost one collect, not N.
    const all = await memo(cache.conversationComments, String(conversationId), () =>
      listConversationComments(ctx, conversationId));
    return all
      .filter((c) => isInCommentThread(c, anchor))
      .sort((a, b) => a.created_at - b.created_at || String(a._id).localeCompare(String(b._id)));
  });
}

/** An unfinished agent placeholder is not a reply yet: it neither counts nor
 *  previews. Once it lands (done, or error) it reads as another person's. */
function isLandedComment(c: ConversationComment): boolean {
  return c.agent_status !== "thinking" && c.agent_status !== "streaming";
}

function isOthersComment(c: ConversationComment, userId: Id<"users">): boolean {
  // An agent row carries the asker's user_id; the answer is still news to
  // the asker, so it counts as someone else's reply.
  return c.author_kind === "agent" || String(c.user_id) !== String(userId);
}

const commentKind: ThreadKindResolver = {
  async access(ctx, userId, row, cache) {
    const id = commentConversationId(row);
    const conversation = await memo(cache.conversations, String(id), () => ctx.db.get(id));
    return !!conversation && (await canAccessConversation(ctx, userId, conversation));
  },
  async unread(ctx, userId, row, cache) {
    const rows = await commentThread(ctx, row, cache);
    const counted = rows.filter((c) =>
      c.created_at > row.last_read_at && isLandedComment(c) && isOthersComment(c, userId)).length;
    return capped(counted);
  },
  async forYou(ctx, userId, row, cache) {
    const rows = await commentThread(ctx, row, cache);
    const unread = rows.filter((c) =>
      c.created_at > row.last_read_at && isLandedComment(c) && isOthersComment(c, userId));
    return waitsOnViewer(ctx, cache, userId, unread, {
      isAgent: (c) => c.author_kind === "agent",
      // An agent row carries the asker's user_id: it answers them.
      answersViewer: (c) => String(c.user_id) === String(userId),
      text: (c) => c.content,
    });
  },
  async newestAt(ctx, row, cache) {
    const rows = await commentThread(ctx, row, cache);
    let newest = 0;
    for (const c of rows) if (isLandedComment(c) && c.created_at > newest) newest = c.created_at;
    return newest;
  },
  async load(ctx, _userId, row, cache, payload) {
    const rows = (await commentThread(ctx, row, cache)).slice(-THREAD_PAYLOAD_ROWS);
    for (const comment of rows) {
      const user = await userFor(ctx, cache, comment.user_id);
      payload.comments.push({
        ...comment,
        user: {
          _id: user?._id,
          name: user?.name,
          github_username: user?.github_username,
          github_avatar_url: user?.github_avatar_url,
        },
      });
    }
  },
  async preview(ctx, _userId, row, cache) {
    const rows = await commentThread(ctx, row, cache);
    const newest = [...rows].reverse().find(isLandedComment);
    if (!newest) return null;
    return {
      _id: String(newest._id),
      user_id: String(newest.user_id),
      author_kind: newest.author_kind ?? "user",
      author_name: displayName(await userFor(ctx, cache, newest.user_id)),
      created_at: newest.created_at,
      preview: plainPreview(newest.content, 160),
    };
  },
};

// ── task ────────────────────────────────────────────────────────────────────

function taskId(row: ThreadRead): Id<"tasks"> {
  return row.task_id ?? (row.root_key as Id<"tasks">);
}

async function taskFor(ctx: ReadCtx, row: ThreadRead, cache: PageCache) {
  return await memo(cache.tasks, row.root_key, () => ctx.db.get(taskId(row)));
}

/** The newest THREAD_PAYLOAD_ROWS comments, newest first. */
async function taskCommentsFor(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<Doc<"task_comments">[]> {
  return await memo(cache.taskComments, row.root_key, () =>
    ctx.db
      .query("task_comments")
      .withIndex("by_task_created", (q: any) => q.eq("task_id", taskId(row)))
      .order("desc")
      .take(THREAD_PAYLOAD_ROWS));
}

/** Did the viewer write in this thread themself? A task comment carries
 *  author_user_id only for a person's own act (never an agent's), so this is
 *  the durable trace of a touchThread actor row. */
async function viewerCommentedOnTask(ctx: ReadCtx, userId: Id<"users">, taskId: Id<"tasks">): Promise<boolean> {
  const own = await ctx.db
    .query("task_comments")
    .withIndex("by_task_created", (q: any) => q.eq("task_id", taskId))
    .filter((q: any) => q.eq(q.field("author_user_id"), userId))
    .first();
  return !!own;
}

/** Whether one task comment is news for the viewer (threadReads.
 *  taskCommentIsNews): the reader's own level, the author's kind, and
 *  whether the text names them. */
async function taskCommentNewsFor(
  ctx: ReadCtx,
  cache: PageCache,
  userId: Id<"users">,
  c: Doc<"task_comments">,
): Promise<boolean> {
  const author = taskCommentAuthorKind(c, await userFor(ctx, cache, c.author_user_id), userId);
  const mentioned = author === "agent" && (await namesViewer(ctx, cache, userId, c.text));
  return taskCommentIsNews(c, author, agentCommentLevelOf(await userFor(ctx, cache, userId)), mentioned);
}

/** The task comments past the viewer's mark, oldest first. */
async function unreadTaskComments(ctx: ReadCtx, row: ThreadRead): Promise<Doc<"task_comments">[]> {
  return await ctx.db
    .query("task_comments")
    .withIndex("by_task_created", (q: any) =>
      q.eq("task_id", taskId(row)).gt("created_at", row.last_read_at))
    .take(THREAD_UNREAD_SCAN);
}

const taskKind: ThreadKindResolver = {
  // Access is membership, not the task ACL: a row survives only while the
  // viewer is a participant under taskThreadMembership's human-act rule, or
  // wrote in the thread themself (touchThread files the actor even when the
  // rule would not). A mute — a handoff or an explicit unwatch — beats both,
  // including the wrote-in-the-thread backstop. Rows filed under the older
  // identity rule (the owner of every agent task) drop here until the sweep
  // purges them, and stay out whatever an old client files.
  async access(ctx, userId, row, cache) {
    const task = await taskFor(ctx, row, cache);
    if (!task || !(await canAccessTask(ctx, userId, task))) return false;
    const membership = await memo(cache.taskMembership, row.root_key, () => taskThreadMembership(ctx, task));
    if (membership.muted.has(String(userId))) return false;
    if (membership.participants.some((id) => String(id) === String(userId))) return true;
    return await viewerCommentedOnTask(ctx, userId, task._id);
  },
  async unread(ctx, userId, row, cache) {
    let counted = 0;
    for (const c of await unreadTaskComments(ctx, row)) if (await taskCommentNewsFor(ctx, cache, userId, c)) counted++;
    return capped(counted);
  },
  async forYou(ctx, userId, row, cache) {
    for (const c of await unreadTaskComments(ctx, row)) {
      const author = taskCommentAuthorKind(c, await userFor(ctx, cache, c.author_user_id), userId);
      if (author === "self") continue;
      if (taskCommentIsForYou(author, await namesViewer(ctx, cache, userId, c.text))) return true;
    }
    return false;
  },
  async newestAt(ctx, row, cache) {
    return (await taskCommentsFor(ctx, row, cache))[0]?.created_at ?? 0;
  },
  async load(ctx, userId, row, cache, payload) {
    const task = await taskFor(ctx, row, cache);
    if (!task) return;
    const comments = await attachCommentSessionInfo(ctx, [...(await taskCommentsFor(ctx, row, cache))].reverse(), userId);
    payload.tasks.push({ ...task, comments });
  },
  async preview(ctx, userId, row, cache) {
    // Newest first. The row previews the newest UNREAD reply that is news for
    // the viewer — an agent's progress notes after a teammate's question must
    // not hide the question — else the newest reply at all.
    const comments = await taskCommentsFor(ctx, row, cache);
    let newest: Doc<"task_comments"> | undefined;
    for (const c of comments) {
      if (c.created_at <= row.last_read_at) break;
      if (await taskCommentNewsFor(ctx, cache, userId, c)) { newest = c; break; }
    }
    newest ??= comments[0];
    if (!newest) return null;
    const user = await userFor(ctx, cache, newest.author_user_id);
    const kind = taskCommentAuthorKind(newest, user, userId);
    const [withSession] = await attachCommentSessionInfo(ctx, [newest], userId);
    return {
      _id: String(newest._id),
      user_id: newest.author_user_id ? String(newest.author_user_id) : undefined,
      author_kind: kind === "agent" ? "agent" : "user",
      author_name: displayName(user) ?? newest.author,
      session_title: withSession.session_info?.title ?? undefined,
      created_at: newest.created_at,
      preview: plainPreview(newest.text, 160),
    };
  },
};

// ── page ────────────────────────────────────────────────────────────────────

function artifactId(row: ThreadRead): Id<"artifacts"> {
  return row.artifact_id ?? (row.root_key as Id<"artifacts">);
}

async function artifactFor(ctx: ReadCtx, row: ThreadRead, cache: PageCache) {
  return await memo(cache.artifacts, row.root_key, () => ctx.db.get(artifactId(row)));
}

/** The whole discussion, oldest first. Bounded by the page's real comment
 *  volume, like the owner panel and the CLI listing. */
async function pageCommentsFor(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<Doc<"artifact_comments">[]> {
  return await memo(cache.artifactComments, row.root_key, () =>
    ctx.db
      .query("artifact_comments")
      .withIndex("by_artifact", (q: any) => q.eq("artifact_id", artifactId(row)))
      .collect());
}

function stripCommentEmail(c: Doc<"artifact_comments">): PageComment {
  const { author_email: _email, ...rest } = c;
  return rest;
}

const pageKind: ThreadKindResolver = {
  async access(ctx, userId, row, cache) {
    // The owner and the verified commenters. A mention alone files the row
    // but does not open the discussion: access arrives with their first
    // comment. Anonymous commenters have no account and no inbox.
    const artifact = await artifactFor(ctx, row, cache);
    if (!artifact) return false;
    if (String(artifact.user_id) === String(userId)) return true;
    const comments = await pageCommentsFor(ctx, row, cache);
    return comments.some((c) => String(c.author_user_id) === String(userId));
  },
  async unread(ctx, userId, row, cache) {
    const rows = await pageCommentsFor(ctx, row, cache);
    // A comment with no author_user_id is an anonymous viewer's: news.
    const counted = rows.filter((c) =>
      c.created_at > row.last_read_at && String(c.author_user_id) !== String(userId)).length;
    return capped(counted);
  },
  async forYou(ctx, userId, row, cache) {
    // Every page comment is a person's (a signed-in viewer or an anonymous
    // one), so any unread comment waits on the owner and the commenters.
    const rows = await pageCommentsFor(ctx, row, cache);
    return rows.some((c) => c.created_at > row.last_read_at && String(c.author_user_id) !== String(userId));
  },
  async newestAt(ctx, row, cache) {
    const rows = await pageCommentsFor(ctx, row, cache);
    let newest = 0;
    for (const c of rows) if (c.created_at > newest) newest = c.created_at;
    return newest;
  },
  async load(ctx, _userId, row, cache, payload) {
    const artifact = await artifactFor(ctx, row, cache);
    if (!artifact) return;
    const comments = (await pageCommentsFor(ctx, row, cache)).slice(-THREAD_PAYLOAD_ROWS);
    payload.pages.push({
      _id: String(artifact._id),
      slug: artifact.slug,
      title: artifact.title,
      kind: artifact.kind,
      user_id: String(artifact.user_id),
      updated_at: artifact.updated_at,
      comments: comments.map(stripCommentEmail),
    });
  },
  async preview(ctx, _userId, row, cache) {
    const rows = await pageCommentsFor(ctx, row, cache);
    const newest = rows.reduce<Doc<"artifact_comments"> | null>(
      (best, c) => (!best || c.created_at >= best.created_at ? c : best), null);
    if (!newest) return null;
    const user = await userFor(ctx, cache, newest.author_user_id);
    return {
      _id: String(newest._id),
      user_id: newest.author_user_id ? String(newest.author_user_id) : undefined,
      author_kind: "user",
      author_name: displayName(user) ?? newest.author_name,
      created_at: newest.created_at,
      preview: plainPreview(newest.text, 160),
    };
  },
};

// ── code ────────────────────────────────────────────────────────────────────

/** The whole thread, oldest first: every review_comments row on the anchor
 *  the root key names. The row's typed refs win over the parsed key. */
async function codeThreadFor(ctx: ReadCtx, row: ThreadRead, cache: PageCache): Promise<Doc<"review_comments">[]> {
  return await memo(cache.codeThreads, row.root_key, () => {
    const parsed = parseCodeThreadRootKey(row.root_key);
    return codeThreadRows(ctx as any, {
      repository: row.repository ?? parsed.repository,
      ref: row.ref ?? parsed.ref,
      file_path: row.file_path ?? parsed.filePath,
      line_number: row.line_number ?? parsed.lineNumber,
    });
  });
}

function isOthersCodeComment(c: Doc<"review_comments">, userId: Id<"users">): boolean {
  // A GitHub or agent row has no codecast author; it is always news.
  return !c.author_user_id || String(c.author_user_id) !== String(userId);
}

async function codeAuthorName(ctx: ReadCtx, cache: PageCache, c: Doc<"review_comments">): Promise<string | undefined> {
  if (c.author_kind === "agent") return "Agent";
  return displayName(await userFor(ctx, cache, c.author_user_id)) ?? c.author_github_username ?? undefined;
}

const codeKind: ThreadKindResolver = {
  // A thread is readable when its root is: the author, the pull request, the
  // session it came from, or the team that installed the App. One check per
  // thread, on its oldest row.
  async access(ctx, userId, row, cache) {
    const rows = await codeThreadFor(ctx, row, cache);
    const root = rows[0];
    return !!root && (await canAccessComment(ctx as any, userId, root));
  },
  async unread(ctx, userId, row, cache) {
    const rows = await codeThreadFor(ctx, row, cache);
    const counted = rows.filter((c) => c.created_at > row.last_read_at && isOthersCodeComment(c, userId)).length;
    return capped(counted);
  },
  async forYou(ctx, userId, row, cache) {
    const rows = await codeThreadFor(ctx, row, cache);
    const unread = rows.filter((c) => c.created_at > row.last_read_at && isOthersCodeComment(c, userId));
    const viewerWroteBefore = (at: number) =>
      rows.some((c) => !!c.author_user_id && String(c.author_user_id) === String(userId) && c.created_at < at);
    return waitsOnViewer(ctx, cache, userId, unread, {
      isAgent: (c) => c.author_kind === "agent",
      answersViewer: (c) => viewerWroteBefore(c.created_at),
      text: (c) => c.content,
    });
  },
  async newestAt(ctx, row, cache) {
    const rows = await codeThreadFor(ctx, row, cache);
    let newest = 0;
    for (const c of rows) if (c.created_at > newest) newest = c.created_at;
    return newest;
  },
  async load(ctx, _userId, row, cache, payload) {
    const rows = (await codeThreadFor(ctx, row, cache)).slice(-THREAD_PAYLOAD_ROWS);
    payload.codeComments.push(...rows);
  },
  async preview(ctx, _userId, row, cache) {
    const rows = await codeThreadFor(ctx, row, cache);
    const newest = rows[rows.length - 1];
    if (!newest) return null;
    return {
      _id: String(newest._id),
      user_id: newest.author_user_id ? String(newest.author_user_id) : undefined,
      author_kind: newest.author_kind === "agent" ? "agent" : "user",
      author_name: await codeAuthorName(ctx, cache, newest),
      created_at: newest.created_at,
      preview: plainPreview(newest.content, 160),
    };
  },
};

const THREAD_KINDS: Record<ThreadKind, ThreadKindResolver> = {
  chat: chatKind,
  comment: commentKind,
  task: taskKind,
  page: pageKind,
  code: codeKind,
  // A decision's team thread (decisionThread.ts).
  decision: decisionThreadKind as ThreadKindResolver,
};

// ── Queries ─────────────────────────────────────────────────────────────────

function scopeQuery(ctx: ReadCtx, userId: Id<"users">, teamId: Id<"teams"> | undefined) {
  // eq("team_id", undefined) is the personal inbox: rows with no team.
  return ctx.db
    .query("thread_reads")
    .withIndex("by_user_team_activity", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .order("desc");
}

/** Published pages have no routing team (artifacts are personal property), so
 *  their rows live in the personal scope — but a publisher working in a team
 *  workspace still owns them. A team-scoped read therefore carries the
 *  viewer's newest personal PAGE rows along; discussions are few, so a
 *  bounded take instead of a second cursor. */
const PERSONAL_PAGE_CARRY = 20;
async function personalPageRows(ctx: ReadCtx, userId: Id<"users">, teamId: Id<"teams"> | undefined): Promise<ThreadRead[]> {
  if (!teamId) return [];
  const personal = await scopeQuery(ctx, userId, undefined).take(THREAD_BADGE_SCAN);
  return personal.filter((r) => r.kind === "page").slice(0, PERSONAL_PAGE_CARRY);
}

export const listMine = query({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Sent by web clients from Oct 24 to Nov 3 2026; every client now reads
    // the same comments, so it changes nothing.
    comments_from_review: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const payload: ListMinePayload = {
      chat: { roots: [], threads: [], authors: [] },
      comments: [],
      tasks: [],
      pages: [],
      codeComments: [],
    };
    const empty = { entries: [] as ThreadInboxEntry[], payload, has_more: false, next_cursor: null as string | null };
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return empty;

    const limit = Math.min(Math.max(args.limit ?? 30, 1), 50);
    const page = await scopeQuery(ctx, userId, args.team_id)
      .paginate({ numItems: limit, cursor: args.cursor ?? null });

    // Personal page rows ride the FIRST team-scoped page only (they have no
    // cursor of their own), newest first like everything else.
    const carried = args.cursor ? [] : await personalPageRows(ctx, userId, args.team_id);

    const cache = newPageCache();
    const entries: ThreadInboxEntry[] = [];
    for (const row of [...carried, ...page.page]) {
      const kind = THREAD_KINDS[row.kind];
      if (!kind || !(await kind.access(ctx, userId, row, cache))) continue;
      const { unread, unread_capped } = await kind.unread(ctx, userId, row, cache);
      await kind.load(ctx, userId, row, cache, payload);
      entries.push({
        _id: `${row.kind}:${row.root_key}`,
        kind: row.kind,
        root_key: row.root_key,
        team_id: row.team_id,
        channel_id: row.channel_id,
        conversation_id: row.conversation_id,
        task_id: row.task_id,
        artifact_id: row.artifact_id,
        message_id: row.message_id,
        file_path: row.file_path,
        line_number: row.line_number,
        repository: row.repository,
        ref: row.ref,
        pull_request_id: row.pull_request_id,
        decision_id: row.decision_id,
        title: kind.title ? await kind.title(ctx, row, cache) : undefined,
        last_activity_at: row.last_activity_at,
        last_read_at: row.last_read_at,
        updated_at: row.updated_at,
        unread,
        unread_capped,
        for_you: unread > 0 && !!kind.forYou && (await kind.forYou(ctx, userId, row, cache)),
        last_reply: await kind.preview(ctx, userId, row, cache),
      });
    }
    payload.chat.threads = await threadSummariesFor(ctx, payload.chat.roots);
    payload.chat.authors = await authorsFor(ctx, payload.chat.roots);
    return {
      entries,
      payload,
      has_more: !page.isDone,
      next_cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

// The sidebar badge: how many threads wait on the viewer (forYou). Other
// unread threads show as activity in the list and are not counted. A bounded
// scan of the newest-activity rows — an inbox whose unread tail is deeper
// than the scan shows a floor, never a lie. Access is re-checked on every
// unread row because comments and tasks have no leave event.
export const unreadCount = query({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    // Sent by web clients from Oct 24 to Nov 3 2026; every client now reads
    // the same comments, so it changes nothing.
    comments_from_review: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return 0;
    return (await countForYou(ctx, userId, [
      ...(await personalPageRows(ctx, userId, args.team_id)),
      ...(await scopeQuery(ctx, userId, args.team_id).take(THREAD_BADGE_SCAN)),
    ])).count;
  },
});

/** How many of these thread rows wait on the viewer, and the newest such
 *  row's activity stamp (the switcher's dot compares it with the viewer's last
 *  visit). Callers pass a bounded scan of the newest-activity rows, so a deep
 *  unread tail shows a floor, never a lie. */
async function countForYou(ctx: ReadCtx, userId: Id<"users">, rows: ThreadRead[]): Promise<{ count: number; newest_at: number }> {
  const cache = newPageCache();
  let count = 0;
  let newest_at = 0;
  for (const row of rows) {
    // A kind this deployment does not know yet (mid-rollout) is skipped,
    // never a crash that blanks the badge.
    const kind = THREAD_KINDS[row.kind];
    if (!kind) continue;
    if (row.last_activity_at <= row.last_read_at) continue;
    if (!(await kind.access(ctx, userId, row, cache))) continue;
    // Activity past the mark is the cheap test; the kind's own count is
    // the honest one — a task row moved by an agent's notes under an
    // older rule holds nothing the reader's level counts.
    if ((await kind.unread(ctx, userId, row, cache)).unread === 0) continue;
    if (!kind.forYou || !(await kind.forYou(ctx, userId, row, cache))) continue;
    count++;
    newest_at = Math.max(newest_at, row.last_activity_at);
  }
  return { count, newest_at };
}

// The workspace switcher's badges: threads waiting on the viewer in the
// workspaces not on screen, each counted once, under the workspace it lives
// in, with the newest one's stamp so the client can tell what arrived since
// its last visit (clientState.ui.workspace_seen_at).
// The active workspace is skipped (its count is unreadCount's), and so are the
// personal page rows a team view carries: they are already on screen there,
// and they belong to no team, so no team badge counts them. Only workspaces
// with unread come back.
export const unreadByWorkspace = query({
  args: {
    api_token: v.optional(v.string()),
    // The workspace on screen: a team id, or "personal".
    active: v.optional(v.union(v.id("teams"), v.literal("personal"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx as any, args.api_token);
    if (!userId) return [];
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const workspaces: Array<Id<"teams"> | undefined> = [undefined, ...memberships.map((m) => m.team_id)];
    const out: Array<{ team_id: string | null; count: number; newest_at: number }> = [];
    for (const teamId of workspaces) {
      if ((teamId ?? "personal") === args.active) continue;
      let rows = await scopeQuery(ctx, userId, teamId).take(THREAD_BADGE_SCAN);
      if (!teamId && args.active !== undefined && args.active !== "personal") {
        rows = rows.filter((r) => r.kind !== "page");
      }
      const { count, newest_at } = await countForYou(ctx, userId, rows);
      if (count > 0) out.push({ team_id: teamId ? String(teamId) : null, count, newest_at });
    }
    return out;
  },
});

// ── Mutations ───────────────────────────────────────────────────────────────

/** Move one row's mark to its newest activity: max(last_activity_at, the
 *  kind's newest counted stamp), forward only. Returns the mark written. */
async function clampRead(ctx: MutationCtx, row: ThreadRead, cache: PageCache, now: number): Promise<number> {
  const readAt = Math.max(row.last_activity_at, await THREAD_KINDS[row.kind].newestAt(ctx, row, cache));
  if (row.last_read_at < readAt) await ctx.db.patch(row._id, { last_read_at: readAt, updated_at: now });
  return Math.max(row.last_read_at, readAt);
}

// The caller's own mark on one thread. No access gate: the row only exists
// because they participated, and moving one's own mark reveals nothing.
export const markRead = mutation({
  args: {
    api_token: v.optional(v.string()),
    kind: threadKindValidator,
    root_key: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const row = await ctx.db
      .query("thread_reads")
      .withIndex("by_user_kind_root", (q: any) =>
        q.eq("user_id", userId).eq("kind", args.kind).eq("root_key", args.root_key))
      .first();
    if (!row) return { kind: args.kind, root_key: args.root_key, last_read_at: null };
    const last_read_at = await clampRead(ctx, row, newPageCache(), Date.now());
    return { kind: args.kind, root_key: args.root_key, last_read_at };
  },
});

// One sweep for the "Mark all read" affordance, scoped like the page it sits
// on: the (user, team) inbox, optionally narrowed to one kind (one chip).
export const markAllRead = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    kind: v.optional(threadKindValidator),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const rows = [
      // The carried personal page rows are part of the view being swept.
      ...(!args.kind || args.kind === "page" ? await personalPageRows(ctx, userId, args.team_id) : []),
      ...(await scopeQuery(ctx, userId, args.team_id).take(THREAD_BADGE_SCAN)),
    ];
    const cache = newPageCache();
    const now = Date.now();
    let marked = 0;
    for (const row of rows) {
      if (args.kind && row.kind !== args.kind) continue;
      if (!THREAD_KINDS[row.kind]) continue;
      const before = row.last_read_at;
      if ((await clampRead(ctx, row, cache, now)) > before) marked++;
    }
    return { marked };
  },
});

// One card's "done": the caller archives their own follow of a thread. The
// row leaves the inbox now; the next qualifying reply files a fresh one
// (touchThread), so this is triage, not an unfollow — a task handoff
// (assigning it to someone else) is the durable exit. No access gate, like
// markRead: dropping one's own row reveals nothing.
export const dismiss = mutation({
  args: {
    api_token: v.optional(v.string()),
    kind: threadKindValidator,
    root_key: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const dropped = await dropThreadRead(ctx, userId, args.kind, args.root_key);
    return { kind: args.kind, root_key: args.root_key, dropped };
  },
});
