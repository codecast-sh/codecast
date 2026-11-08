// The published-page and code-review kinds of the Threads inbox (threads.ts).

import type { PageComment, ThreadRead } from "./threadsTypes";
import type { Doc, Id } from "./_generated/dataModel";
import { parseCodeThreadRootKey } from "@codecast/shared/comments";
import { plainPreview } from "./chatText";
import { canAccessComment, codeThreadRows } from "./codeComments";
import {
  type ReadCtx,
  type PageCache,
  memo,
  userFor,
  displayName,
  THREAD_PAYLOAD_ROWS,
  capped,
  type ThreadKindResolver,
  waitsOnViewer,
} from "./threadKit";

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

export const pageKind: ThreadKindResolver = {
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

export const codeKind: ThreadKindResolver = {
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
