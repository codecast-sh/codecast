// The kit every Threads kind resolver shares (threads.ts, threadPageCodeKinds.ts):
// the per-request page cache, the resolver contract, and the Threads badge rule.

import type { ListMinePayload, ThreadLastReply, ThreadRead } from "./threadsTypes";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { extractMentionHandles } from "@codecast/shared/chat";
import { UNREAD_CAP } from "./chatText";
import type { ConversationComment } from "./lib/conversationCommentRows";
import { matchHandle } from "./lib/mentionResolve";
import { type TaskThreadMembership } from "./threadReads";

export type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Per-request memo: the same channel, conversation, task and author repeat
 *  across a page of rows, and a subscription read set should not grow with
 *  duplicates. */
export type PageCache = {
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

export function newPageCache(): PageCache {
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

export async function memo<T>(map: Map<string, T>, key: string, load: () => Promise<T>): Promise<T> {
  if (!map.has(key)) map.set(key, await load());
  return map.get(key)!;
}

export async function userFor(ctx: ReadCtx, cache: PageCache, userId: Id<"users"> | undefined): Promise<Doc<"users"> | null> {
  if (!userId) return null;
  return await memo(cache.users, String(userId), () => ctx.db.get(userId));
}

export function displayName(user: Doc<"users"> | null): string | undefined {
  return user?.name || user?.github_username || user?.email || undefined;
}

/** How many comment rows one thread ships per page: the newest, so a long
 *  thread still renders and replies in place. */
export const THREAD_PAYLOAD_ROWS = 50;

export function capped(counted: number): { unread: number; unread_capped: boolean } {
  return { unread: Math.min(counted, UNREAD_CAP), unread_capped: counted > UNREAD_CAP };
}

export type ThreadKindResolver = {
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
export async function namesViewer(ctx: ReadCtx, cache: PageCache, userId: Id<"users">, text: string | undefined): Promise<boolean> {
  const handles = extractMentionHandles(text ?? "");
  if (!handles.length) return false;
  const viewer = await userFor(ctx, cache, userId);
  return !!viewer && handles.some((h) => matchHandle([viewer], h));
}

/** The rule every kind shares for the Threads badge: an unread reply from a
 *  person waits on the viewer; an agent's only when it names them or answers
 *  something they asked. An agent's progress in a thread they follow is
 *  activity: shown, never counted. */
export async function waitsOnViewer<T>(
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
