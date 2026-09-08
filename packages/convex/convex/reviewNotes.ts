// Review notes: what `cast review` writes, lists and hands to a session.
//
// A note is a comment on a file and a line, so it is a review_comments row and
// the web diff view already renders it (codeComments.listForFile). What is new
// here is the BATCH: notes accumulate in one worktree while the human reads a
// diff, then go to an agent together, once, in the order they were written.
//
// Why these are not codeComments.create: that mutation demands a GitHub App
// installation on the repository (requireRepositoryTeam) and mirrors the
// comment onto an open pull request. A note written in a scratch worktree of a
// repository GitHub has never heard of must still work, and must not appear on
// anyone's pull request. Everything downstream of the insert — access, edit,
// delete, the web reads — is the shared code in codeComments.ts.

import { v } from "convex/values";
import { mutation, query } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { canAccessComment } from "./codeComments";
import { createDataContext } from "./data";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { normalizeRepository } from "./lib/gitRefs";
import { canSendProductMessage, enqueuePendingMessage } from "./pendingMessages";
import { buildReviewBatchPrompt } from "@codecast/shared/comments";

/** The notes one author wrote in one worktree, oldest first. */
async function batchRows(
  ctx: { db: any },
  userId: Id<"users">,
  gitRoot: string,
): Promise<Doc<"review_comments">[]> {
  const rows = await ctx.db
    .query("review_comments")
    .withIndex("by_author_git_root", (q: any) => q.eq("author_user_id", userId).eq("git_root", gitRoot))
    .collect();
  return rows.sort((a: any, b: any) => a.created_at - b.created_at);
}

function actorNameOf(user: any): string {
  return user?.name || user?.github_username || user?.email || "Someone";
}

export const add = mutation({
  args: {
    api_token: v.optional(v.string()),
    // The worktree the note belongs to. It is also the path whose directory
    // mapping decides the workspace, so a note written in a team directory is
    // the team's and one written anywhere else is private to its author.
    git_root: v.string(),
    repository: v.optional(v.string()),
    ref: v.optional(v.string()),
    file_path: v.string(),
    // Absent or 0 means the note is about the whole file.
    line_number: v.optional(v.number()),
    line_end: v.optional(v.number()),
    content: v.string(),
    diff_identity: v.optional(v.string()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const content = args.content.trim();
    if (!content) throw new Error("A review note needs a body");

    // The workspace chokepoint decides the key; review_comments is not one of
    // its scoped tables, so the row is stamped here from what it resolved.
    const data = await createDataContext(ctx, {
      userId,
      project_path: args.git_root,
      workspace: args.workspace,
      team_id: args.team_id,
    });

    const now = Date.now();
    const id = await ctx.db.insert("review_comments", {
      repository: args.repository ? normalizeRepository(args.repository) : undefined,
      ref: args.ref,
      file_path: args.file_path,
      line_number: args.line_number || undefined,
      line_end: args.line_end || undefined,
      author_user_id: userId,
      author_kind: "user" as const,
      content,
      resolved: false,
      created_at: now,
      updated_at: now,
      codecast_origin: true,
      workspace: data.workspaceKey,
      git_root: args.git_root,
      diff_identity: args.diff_identity,
    });
    return { id, workspace: data.workspaceKey };
  },
});

export const list = query({
  args: {
    api_token: v.optional(v.string()),
    git_root: v.string(),
    /** Notes already handed to a session come along too. */
    include_sent: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const rows = await batchRows(ctx, userId, args.git_root);
    return rows.filter((r) => args.include_sent || !r.sent_at);
  },
});

export const send = mutation({
  args: {
    api_token: v.optional(v.string()),
    git_root: v.string(),
    /** Any session reference: a conversation id, a session uuid, a short id. */
    conversation_ref: v.string(),
    /** Notes the caller found stale against the tree as it stands now. */
    stale_ids: v.optional(v.array(v.id("review_comments"))),
    /** The batch's page, when the caller knows it. */
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conversation = await findConversationByAnyRef(ctx, args.conversation_ref, userId);
    if (!conversation) throw new Error(`No session matches ${args.conversation_ref}`);
    if (!(await canSendProductMessage(ctx, userId, conversation))) {
      throw new Error("Forbidden: you cannot send to that session");
    }

    const pending = (await batchRows(ctx, userId, args.git_root)).filter((r) => !r.sent_at);
    if (pending.length === 0) throw new Error("No unsent review notes in this worktree");

    const stale = new Set((args.stale_ids ?? []).map(String));
    const user = await ctx.db.get(userId);
    const newest = pending[pending.length - 1];
    const content = buildReviewBatchPrompt({
      actorName: actorNameOf(user),
      repository: newest.repository ?? undefined,
      ref: newest.ref ?? undefined,
      url: args.url ?? null,
      notes: pending.map((r) => ({
        file_path: r.file_path ?? "",
        line_number: r.line_number,
        line_end: r.line_end,
        content: r.content,
        stale: stale.has(String(r._id)),
      })),
    });

    const now = Date.now();
    await enqueuePendingMessage(ctx, conversation, userId, {
      content,
      // Idempotency is sent_at, not this key: a retry finds the batch already
      // stamped and stops. The key only has to be distinct per delivery, so a
      // second batch to the same session is not mistaken for the first.
      client_id: `review-batch:${conversation._id}:${pending[0]._id}:${now}`,
      human: true,
    });
    for (const row of pending) await ctx.db.patch(row._id, { sent_at: now });

    return { sent: pending.length, conversation_id: conversation._id, content };
  },
});

/** One note by id, for `cast review rm` / `edit` to confirm before acting. */
export const get = query({
  args: { api_token: v.optional(v.string()), comment_id: v.id("review_comments") },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await ctx.db.get(args.comment_id);
    if (!row || !(await canAccessComment(ctx, userId, row))) return null;
    return row;
  },
});
