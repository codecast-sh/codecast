import { mutation } from "./functions";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { teamVisibleConvTeam } from "./privacy";
import { computeWorkspaceKey, resolveSessionConversation } from "./lib/access";
import { heldKeysFor } from "./lib/accessKeys";
import { getRepoKeyFromRemote } from "./projectPaths";
import { decisionTouches, normalizeDecisionFiles, type DecisionTouch } from "./lib/decisionMatch";
import type { Doc, Id } from "./_generated/dataModel";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    rationale: v.string(),
    alternatives: v.optional(v.array(v.string())),
    session_id: v.optional(v.string()),
    message_index: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    project_path: v.optional(v.string()),
    git_remote: v.optional(v.string()),
    files: v.optional(v.array(v.string())),
    // The decision this one reverses, by full id or the 7-character prefix
    // the list prints; it is marked superseded and stops binding.
    supersedes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let reversed: Doc<"decisions"> | null = null;
    if (args.supersedes) {
      reversed = await findReadableDecision(ctx, result.userId, args.supersedes);
      if (!reversed) return { error: `No decision ${args.supersedes} you can read` };
    }

    let sourceConv = null;
    if (args.session_id) {
      // Only a session the caller can read places the decision: another
      // person's session must never donate its team (and so its workspace).
      sourceConv = await resolveSessionConversation(ctx, result.userId, args.session_id);
    }
    const id = await insertDecision(ctx, result.userId, {
      title: args.title,
      rationale: args.rationale,
      alternatives: args.alternatives,
      message_index: args.message_index,
      tags: args.tags,
      project_path: args.project_path,
      session_id: args.session_id,
      repo: getRepoKeyFromRemote(args.git_remote) ?? reversed?.repo,
      files: args.files?.length ? normalizeDecisionFiles(args.files) : reversed?.files,
    }, sourceConv);
    if (!id) return { error: "User not found" };
    if (reversed) await ctx.db.patch(reversed._id, { superseded_by: id, updated_at: Date.now() });

    return { id, success: true };
  },
});

/**
 * One recorded decision (`cast decisions add`, and an answered card gate,
 * the-line-end-to-end.md LE12). The source session, when there is one, places
 * it: only a team visible session donates its team, so a private session's
 * routing team_id never becomes a team readable decision.
 */
export async function insertDecision(
  ctx: { db: any },
  userId: Id<"users">,
  fields: {
    title: string;
    rationale: string;
    alternatives?: string[];
    message_index?: number;
    tags?: string[];
    project_path?: string;
    session_id?: string;
    repo?: string;
    files?: string[];
    source?: "automatic";
  },
  sourceConv: Doc<"conversations"> | null,
): Promise<Id<"decisions"> | null> {
  const user = await ctx.db.get(userId);
  if (!user) return null;
  let teamId = user.team_id;
  const visibleTeam = sourceConv ? teamVisibleConvTeam(sourceConv) : undefined;
  if (visibleTeam) teamId = visibleTeam;
  const now = Date.now();
  return await ctx.db.insert("decisions", {
    user_id: userId,
    team_id: teamId,
    // Stored access key, computed from the same rule at write time: a private
    // source session makes this decision personal to its owner.
    workspace: computeWorkspaceKey({ user_id: userId, team_id: teamId }, sourceConv),
    project_path: fields.project_path,
    title: fields.title,
    rationale: fields.rationale,
    alternatives: fields.alternatives,
    session_id: fields.session_id ?? sourceConv?.session_id,
    conversation_id: sourceConv?._id,
    message_index: fields.message_index,
    tags: fields.tags,
    repo: fields.repo,
    files: fields.files,
    source: fields.source,
    created_at: now,
    updated_at: now,
  });
}

/**
 * The decisions a viewer can read: every row whose stored `workspace` key is
 * one the viewer holds (their personal key and each team they belong to), so
 * a team's decisions are shared among its members. Access reads `workspace`
 * only; `team_id` is routing. A search walks the title index and keeps the
 * rows the viewer may read, so it agrees with the list.
 */
export async function listDecisionsForViewer(
  ctx: { db: any },
  userId: Id<"users">,
  opts: { project_path?: string; search?: string; limit: number; offset: number },
): Promise<Doc<"decisions">[]> {
  const held = await heldKeysFor(ctx, userId);
  const want = opts.limit + opts.offset;
  let rows: Doc<"decisions">[];
  if (opts.search) {
    const found: Doc<"decisions">[] = await ctx.db
      .query("decisions")
      .withSearchIndex("search_decisions_v2", (q: any) =>
        opts.project_path ? q.search("title", opts.search!).eq("project_path", opts.project_path) : q.search("title", opts.search!),
      )
      .take(Math.min(want * 4, 200));
    rows = found.filter((d) => d.workspace && held.has(d.workspace));
  } else {
    const perKey = await Promise.all(
      [...held].map((key) =>
        ctx.db
          .query("decisions")
          .withIndex("by_workspace", (q: any) => q.eq("workspace", key))
          .order("desc")
          .take(want) as Promise<Doc<"decisions">[]>,
      ),
    );
    rows = perKey
      .flat()
      .filter((d) => !opts.project_path || d.project_path === opts.project_path)
      .sort((a, b) => b.created_at - a.created_at);
  }
  return rows.slice(opts.offset, opts.offset + opts.limit);
}

/** Every decision the viewer can read, newest first: the touching scan's input. */
async function allReadableDecisions(ctx: { db: any }, userId: Id<"users">): Promise<Doc<"decisions">[]> {
  const held = await heldKeysFor(ctx, userId);
  const perKey = await Promise.all(
    [...held].map((key) =>
      ctx.db.query("decisions").withIndex("by_workspace", (q: any) => q.eq("workspace", key)).order("desc").take(2000),
    ),
  );
  return (perKey.flat() as Doc<"decisions">[]).sort((a, b) => b.created_at - a.created_at);
}

/** A decision by full id or the 7-character prefix the list prints, only when the viewer can read it. */
async function findReadableDecision(ctx: { db: any }, userId: Id<"users">, ref: string): Promise<Doc<"decisions"> | null> {
  const held = await heldKeysFor(ctx, userId);
  const readable = (d: Doc<"decisions"> | null) => (d && d.workspace && held.has(d.workspace) ? d : null);
  const exact = ctx.db.normalizeId("decisions", ref);
  if (exact) return readable(await ctx.db.get(exact));
  const hits = (await allReadableDecisions(ctx, userId)).filter((d) => String(d._id).startsWith(ref));
  return hits.length === 1 ? hits[0] : null;
}

function formatDecision(d: Doc<"decisions">, touch?: DecisionTouch) {
  return {
    id: d._id,
    title: d.title,
    rationale: d.rationale,
    alternatives: d.alternatives,
    tags: d.tags,
    repo: d.repo,
    files: d.files,
    superseded_by: d.superseded_by,
    session_id: d.session_id,
    conversation_id: d.conversation_id,
    message_index: d.message_index,
    project_path: d.project_path,
    source: d.source,
    created_at: new Date(d.created_at).toISOString(),
    ...(touch ? { touches: touch } : {}),
  };
}

export const list = mutation({
  args: {
    api_token: v.string(),
    // Touching mode: the decisions that bear on a change, given the paths it
    // changes (repo-relative, in the repo `git_remote` names) and the
    // conversations that wrote the lines it changes. Superseded ones are left out.
    touching: v.optional(v.object({
      git_remote: v.optional(v.string()),
      files: v.array(v.string()),
      conversation_ids: v.array(v.string()),
    })),
    project_path: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;

    if (args.touching) {
      const change = {
        repo: getRepoKeyFromRemote(args.touching.git_remote),
        files: normalizeDecisionFiles(args.touching.files),
        conversationIds: new Set(args.touching.conversation_ids),
      };
      const hits = (await allReadableDecisions(ctx, result.userId)).flatMap((d) => {
        const touch = decisionTouches(d, change);
        return touch ? [{ touch, row: formatDecision(d, touch) }] : [];
      });
      // Every decision governing a changed path, then up to `limit` of the
      // ones matched only by the session that wrote the changed lines.
      const governing = hits.filter((h) => h.touch.files.length).map((h) => h.row);
      const bySession = hits.filter((h) => !h.touch.files.length).slice(0, limit).map((h) => h.row);
      return { decisions: [...governing, ...bySession], count: governing.length + bySession.length, repo: change.repo };
    }

    let decisions = await listDecisionsForViewer(ctx, result.userId, {
      project_path: args.project_path,
      search: args.search,
      limit,
      offset,
    });

    if (args.tags && args.tags.length > 0) {
      decisions = decisions.filter((d) =>
        args.tags!.some((tag) => d.tags?.includes(tag))
      );
    }

    const formatted = decisions.map((d) => formatDecision(d));

    return { decisions: formatted, count: formatted.length };
  },
});

export const get = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const decisionId = ctx.db.normalizeId("decisions", args.decision_id);
    const decision = decisionId ? await ctx.db.get(decisionId) : null;

    if (!decision || decision.user_id.toString() !== result.userId.toString()) {
      return { error: "Decision not found" };
    }

    return {
      id: decision._id,
      title: decision.title,
      rationale: decision.rationale,
      alternatives: decision.alternatives,
      tags: decision.tags,
      session_id: decision.session_id,
      message_index: decision.message_index,
      project_path: decision.project_path,
      created_at: new Date(decision.created_at).toISOString(),
    };
  },
});

export const remove = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.id("decisions"),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const decision = await ctx.db.get(args.decision_id);
    if (!decision || decision.user_id.toString() !== result.userId.toString()) {
      return { error: "Decision not found" };
    }

    await ctx.db.delete(args.decision_id);
    return { success: true };
  },
});
