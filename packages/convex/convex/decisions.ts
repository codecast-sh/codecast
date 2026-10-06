import { mutation } from "./functions";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { teamVisibleConvTeam } from "./privacy";
import { computeWorkspaceKey } from "./lib/access";
import { heldKeysFor } from "./lib/accessKeys";
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
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let sourceConv = null;
    if (args.session_id) {
      sourceConv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .first();
    }
    const id = await insertDecision(ctx, result.userId, {
      title: args.title,
      rationale: args.rationale,
      alternatives: args.alternatives,
      message_index: args.message_index,
      tags: args.tags,
      project_path: args.project_path,
      session_id: args.session_id,
    }, sourceConv);
    if (!id) return { error: "User not found" };

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

export const list = mutation({
  args: {
    api_token: v.string(),
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

    const formatted = decisions.map((d) => ({
      id: d._id,
      title: d.title,
      rationale: d.rationale,
      alternatives: d.alternatives,
      tags: d.tags,
      session_id: d.session_id,
      message_index: d.message_index,
      project_path: d.project_path,
      source: d.source,
      created_at: new Date(d.created_at).toISOString(),
    }));

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

    const decision = await ctx.db
      .query("decisions")
      .filter((q) => q.eq(q.field("_id"), args.decision_id as any))
      .first();

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
