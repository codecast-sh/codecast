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
import { internalMutation, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { canAccessComment } from "./codeComments";
import { createDataContext } from "./data";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { normalizeRepository } from "./lib/gitRefs";
import { canSendProductMessage, enqueuePendingMessage } from "./pendingMessages";
import { buildReviewBatchPrompt, type ReviewVerdict } from "@codecast/shared/comments";
import { codeAnchorValidator } from "./lib/codeAnchorValidator";

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

const dispositionArgs = {
  disposition: v.optional(v.union(v.literal("fixed"), v.literal("deferred"), v.literal("rejected"))),
  owner_user_id: v.optional(v.id("users")),
  owner_role_id: v.optional(v.id("org_roles")),
  // A role handle (@growth) or a user's name/handle/email, resolved here.
  owner: v.optional(v.string()),
  due_at: v.optional(v.number()),
  promise_task_id: v.optional(v.id("tasks")),
};

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
    // The noted lines' text and context (shared/comments/codeAnchor.ts).
    anchor_lines: v.optional(codeAnchorValidator),
    content: v.string(),
    diff_identity: v.optional(v.string()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    // A line reviewer's finding (cast task verdict --note): the task it was
    // found on, its severity, and the disposition the reviewer accepted.
    task_id: v.optional(v.id("tasks")),
    conversation_id: v.optional(v.id("conversations")),
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    severity: v.optional(v.string()),
    ...dispositionArgs,
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const content = args.content.trim();
    if (!content) throw new Error("A review note needs a body");
    const promise = await resolvePromise(ctx, args);

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
      anchor_lines: args.line_number ? args.anchor_lines : undefined,
      author_user_id: userId,
      author_kind: args.author_kind ?? ("user" as const),
      content,
      resolved: false,
      created_at: now,
      updated_at: now,
      codecast_origin: true,
      workspace: data.workspaceKey,
      git_root: args.git_root,
      diff_identity: args.diff_identity,
      task_id: args.task_id,
      conversation_id: args.conversation_id,
      severity: args.severity,
      ...promise,
    });
    return { id, workspace: data.workspaceKey };
  },
});

// ── Findings as promises ──
//
// A finding's disposition is fixed, deferred or rejected. Deferred is a
// promise, and a promise with nobody to keep it or no day to keep it by is
// refused here, the one write path, so no caller can file a vague one.


type DispositionFields = {
  disposition?: "fixed" | "deferred" | "rejected";
  owner_user_id?: Id<"users">;
  owner_role_id?: Id<"org_roles">;
  owner?: string;
  due_at?: number;
  promise_task_id?: Id<"tasks">;
};

export const DEFERRAL_NEEDS_OWNER = "A deferred finding is a promise: name who keeps it (--owner <@role or user>) and when (--due <date>)";

/** The fields to store for a disposition, or a thrown refusal. Pure on its inputs. */
export function promiseFields(fields: DispositionFields, owner: { user_id?: Id<"users">; role_id?: Id<"org_roles"> }) {
  if (!fields.disposition) return {};
  const out: Record<string, unknown> = { disposition: fields.disposition };
  if (fields.disposition === "deferred") {
    if ((!owner.user_id && !owner.role_id) || !fields.due_at) throw new Error(DEFERRAL_NEEDS_OWNER);
    if (fields.due_at < Date.now() - 86_400_000) throw new Error("A promise's due date is in the future, not the past");
    Object.assign(out, { owner_user_id: owner.user_id, owner_role_id: owner.role_id, due_at: fields.due_at, promise_task_id: fields.promise_task_id });
  }
  return out;
}

async function resolvePromise(ctx: any, fields: DispositionFields) {
  let user_id = fields.owner_user_id;
  let role_id = fields.owner_role_id;
  const name = fields.owner?.trim();
  if (name && !user_id && !role_id) {
    const handle = name.replace(/^@/, "").toLowerCase();
    const role = (await ctx.db.query("org_roles").collect()).find((r: any) => (r.handle ?? "").toLowerCase() === handle);
    if (role) role_id = role._id;
    else {
      const user = (await ctx.db.query("users").collect()).find((u: any) => [u.github_username, u.email, u.name].some((x: string | undefined) => x && x.toLowerCase() === handle));
      if (user) user_id = user._id;
      else throw new Error(`No role or user named ${name}`);
    }
  }
  return promiseFields(fields, { user_id, role_id });
}

export const setDisposition = mutation({
  args: { api_token: v.optional(v.string()), comment_id: v.id("review_comments"), ...dispositionArgs },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await ctx.db.get(args.comment_id);
    if (!row || !(await canAccessComment(ctx, userId, row))) throw new Error("Finding not found");
    const fields = await resolvePromise(ctx, args);
    const now = Date.now();
    await ctx.db.patch(args.comment_id, { ...fields, updated_at: now, ...(args.disposition === "fixed" || args.disposition === "rejected" ? { resolved: true, resolved_at: now, resolved_by: userId } : {}) });
    return { id: args.comment_id, ...fields };
  },
});

const PROMISE_SWEEP_BATCH = 50;

/** Deferred findings past due and still open, not yet signalled: one signal each. Returns what it filed. */
export async function overduePromises(db: any, now: number): Promise<Doc<"review_comments">[]> {
  const due: Doc<"review_comments">[] = await db
    .query("review_comments")
    .withIndex("by_disposition_due", (q: any) => q.eq("disposition", "deferred").lt("due_at", now))
    .take(PROMISE_SWEEP_BATCH * 4);
  return due.filter((r) => !r.resolved && !r.promise_signaled_at).slice(0, PROMISE_SWEEP_BATCH);
}

/** The cron's pass over promises (crons.ts, beside close quiet watches). */
export const sweepOverduePromises = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await overduePromises(ctx.db, now);
    for (const row of due) {
      // Stamped before the signal is scheduled, so a retry of this pass sees
      // the row as done and the finding never fires twice.
      await ctx.db.patch(row._id, { promise_signaled_at: now });
      const filer = row.owner_user_id ?? row.author_user_id;
      if (!filer) continue;
      const where = `${row.file_path ?? "?"}${row.line_number ? `:${row.line_number}` : ""}`;
      await ctx.scheduler.runAfter(0, internal.signals.ingestAs, {
        user_id: filer,
        source: "promise",
        kind: "bug",
        fingerprint: `promise:${row._id}`,
        title: `Deferred finding past due: ${where}`,
        detail_md: `${row.content}

Deferred on ${new Date(row.updated_at ?? row.created_at).toISOString().slice(0, 10)}, due ${new Date(row.due_at ?? now).toISOString().slice(0, 10)}, still open.`,
        subject: row.file_path,
        project_path: row.git_root,
        role_id: row.owner_role_id,
        observed_at: now,
      });
    }
    if (due.length === PROMISE_SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.reviewNotes.sweepOverduePromises, {});
    return { filed: due.length };
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
    const newest = pending[pending.length - 1];
    return await sendNotesToSession(ctx, userId, args.conversation_ref, pending, {
      repository: newest.repository ?? undefined,
      ref: newest.ref ?? undefined,
      url: args.url ?? undefined,
      stale_ids: args.stale_ids,
    }, conversation);
  },
});

/**
 * Deliver a batch of notes to a session as one message, oldest first, and
 * stamp each note sent. The worktree batch (`cast review send`), the notes
 * handed over from a pull request (reviews.handPendingToSession) and a
 * submitted review (reviews.deliverSubmittedReview) all come through here, so
 * a session reads the same shape whichever surface wrote the notes. A review
 * carries its verdict and summary, and may carry no notes at all.
 */
export async function sendNotesToSession(
  ctx: any,
  userId: Id<"users">,
  conversationRef: string,
  rows: Doc<"review_comments">[],
  opts: {
    repository?: string;
    ref?: string;
    url?: string;
    stale_ids?: Id<"review_comments">[];
    pullRequest?: { number: number; url?: string | null };
    verdict?: ReviewVerdict;
    summary?: string | null;
  },
  resolved?: Doc<"conversations">,
): Promise<{ sent: number; conversation_id: Id<"conversations">; short_id?: string; content: string }> {
  const conversation = resolved ?? (await findConversationByAnyRef(ctx, conversationRef, userId));
  if (!conversation) throw new Error(`No session matches ${conversationRef}`);
  if (!(await canSendProductMessage(ctx, userId, conversation))) {
    throw new Error("Forbidden: you cannot send to that session");
  }
  const stale = new Set((opts.stale_ids ?? []).map(String));
  const user = await ctx.db.get(userId);
  const content = buildReviewBatchPrompt({
    actorName: actorNameOf(user),
    repository: opts.repository,
    ref: opts.ref,
    url: opts.url ?? null,
    pullRequest: opts.pullRequest,
    verdict: opts.verdict,
    summary: opts.summary,
    notes: rows.map((r) => ({
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
    client_id: `review-batch:${conversation._id}:${rows[0]?._id ?? opts.verdict ?? "review"}:${now}`,
    human: true,
  });
  for (const row of rows) await ctx.db.patch(row._id, { sent_at: now });

  return { sent: rows.length, conversation_id: conversation._id, short_id: conversation.short_id ?? undefined, content };
}

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
