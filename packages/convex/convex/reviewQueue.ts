import { query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessConversation } from "./lib/access";
import { artifactUrl } from "./artifacts";
import {
  sortReviewItems,
  type ReviewItem,
} from "@codecast/shared/contracts";

// The review queue: everything open and waiting on a human, across entities,
// projected into the shared ReviewItem contract (shared/contracts/reviewQueue).
// This file is a read-only union of sources — each source's lifecycle lives in
// its own table, and an item leaves the queue by resolving THERE (a comment
// thread resolves, a page comment resolves, a gate gets its response). Adding a
// source means adding one collect-and-map block below; no new state.

// How far back the comment scan reaches. Comments are human-paced and the
// table is small; the cap exists so one loud conversation can never make this
// query walk unbounded history. An open thread whose every comment is older
// than the newest N falls out of the queue — acceptable: the rail and the
// session chip still show it.
const COMMENT_SCAN_LIMIT = 500;
// Distinct conversations worth access-checking per refresh.
const COMMENT_CONVERSATION_CAP = 60;
const ARTIFACT_CAP = 100;
const WORKFLOW_RUN_CAP = 100;

function excerpt(text: string | undefined, max = 140): string | undefined {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
}

function commentThreadKey(c: Doc<"comments">): string {
  if (c.message_id) return `msg:${c.message_id}`;
  if (c.file_path) return `file:${c.file_path}:${c.line_number ?? ""}`;
  return "global";
}

function commentAnchorTitle(c: Doc<"comments">): string {
  if (c.file_path) {
    const base = c.file_path.split("/").pop() || c.file_path;
    return c.line_number ? `${base}:${c.line_number}` : base;
  }
  if (c.message_id) return "on a message";
  return "conversation thread";
}

async function collectCommentThreadItems(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<ReviewItem[]> {
  const recent = await ctx.db
    .query("comments")
    .withIndex("by_created_at")
    .order("desc")
    .take(COMMENT_SCAN_LIMIT);

  // Group the window into threads; a thread is open while any comment in it is
  // unstamped (see comments.resolveThread).
  const threads = new Map<string, Doc<"comments">[]>();
  for (const c of recent) {
    const key = `${c.conversation_id}:${commentThreadKey(c)}`;
    const arr = threads.get(key);
    if (arr) arr.push(c);
    else threads.set(key, [c]);
  }

  // Access-check each distinct conversation once, newest threads first.
  const conversationCache = new Map<string, Doc<"conversations"> | null>();
  const canSee = async (conversationId: Id<"conversations">): Promise<Doc<"conversations"> | null> => {
    const cacheKey = String(conversationId);
    if (conversationCache.has(cacheKey)) return conversationCache.get(cacheKey)!;
    if (conversationCache.size >= COMMENT_CONVERSATION_CAP) return null;
    const conversation = await ctx.db.get(conversationId);
    const visible = conversation && (await canAccessConversation(ctx, userId, conversation))
      ? conversation
      : null;
    conversationCache.set(cacheKey, visible);
    return visible;
  };

  const items: ReviewItem[] = [];
  for (const [key, list] of threads) {
    const open = list.filter((c) => !c.resolved_at);
    if (open.length === 0) continue;
    const conversation = await canSee(list[0].conversation_id);
    if (!conversation) continue;

    const newest = [...open].sort((a, b) => b.created_at - a.created_at)[0];
    let actorName: string | undefined;
    let actorAvatar: string | undefined;
    if (newest.author_kind === "agent") {
      actorName = "Agent";
    } else {
      const author = await ctx.db.get(newest.user_id);
      actorName = author?.name || author?.github_username || undefined;
      actorAvatar = author?.image || author?.github_avatar_url || undefined;
    }

    items.push({
      key: `comment_thread:${key}`,
      kind: "comment_thread",
      title: commentAnchorTitle(newest),
      detail: excerpt(newest.content),
      actor_name: actorName,
      actor_avatar: actorAvatar,
      raised_at: newest.created_at,
      last_actor_is_viewer: newest.author_kind !== "agent" && String(newest.user_id) === String(userId),
      count: open.length,
      conversation_id: String(list[0].conversation_id),
      conversation_title: conversation.title ?? undefined,
      anchor: {
        message_id: newest.message_id ? String(newest.message_id) : undefined,
        file_path: newest.file_path,
        line_number: newest.line_number,
      },
    });
  }
  return items;
}

async function collectPageCommentItems(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<ReviewItem[]> {
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .order("desc")
    .take(ARTIFACT_CAP);

  const items: ReviewItem[] = [];
  for (const artifact of artifacts) {
    const comments = await ctx.db
      .query("artifact_comments")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    const open = comments.filter((c) => c.status === "open");
    if (open.length === 0) continue;
    const newest = [...open].sort((a, b) => b.created_at - a.created_at)[0];
    items.push({
      key: `page_comment:${artifact._id}`,
      kind: "page_comment",
      title: artifact.title || artifact.slug,
      detail: excerpt(newest.text),
      actor_name: newest.author_name || undefined,
      actor_avatar: newest.author_avatar || undefined,
      raised_at: newest.created_at,
      last_actor_is_viewer: !!newest.author_user_id && String(newest.author_user_id) === String(userId),
      count: open.length,
      artifact_slug: artifact.slug,
      artifact_url: artifactUrl(artifact.slug),
    });
  }
  return items;
}

async function collectWorkflowGateItems(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<ReviewItem[]> {
  const runs = await ctx.db
    .query("workflow_runs")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .order("desc")
    .take(WORKFLOW_RUN_CAP);

  return runs
    .filter((run) => run.status === "paused")
    .map((run) => ({
      key: `workflow_gate:${run._id}`,
      kind: "workflow_gate" as const,
      title: run.workflow_name ? `Gate · ${run.workflow_name}` : "Workflow gate",
      detail: excerpt(run.gate_prompt),
      raised_at: run.updated_at ?? run.created_at,
      conversation_id: run.primary_conversation_id
        ? String(run.primary_conversation_id)
        : undefined,
    }));
}

// Everything open and waiting on this user, newest first. Web subscribes
// directly (the trigger-dock lane — no store sync); the CLI can reuse it
// verbatim later.
export const list = query({
  args: {},
  handler: async (ctx): Promise<ReviewItem[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const [threads, pages, gates] = await Promise.all([
      collectCommentThreadItems(ctx, userId),
      collectPageCommentItems(ctx, userId),
      collectWorkflowGateItems(ctx, userId),
    ]);
    return sortReviewItems([...threads, ...pages, ...gates]);
  },
});
