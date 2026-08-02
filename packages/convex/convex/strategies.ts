// Steering: Strategy rows — identity, scope, lifecycle, ownership and review
// timing around a Doc that holds the structured narrative. See
// docs/plans/2026-08-01-organizational-steering.md.
//
// Access: owner-or-team (canAccessSteeringEntity). Edits are collaborative
// (any team member); hard deletes are owner-or-team-admin. All writes flow
// through ./functions so the change feed tracks every row.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { nextShortId } from "./counters";
import {
  canAccessSteeringEntity,
  requireCanDeleteOwnerOrTeamEntity,
  requireCanEditOwnerOrTeamEntity,
  requireSameWorkspace,
  workspaceForResource,
} from "./lib/access";
import { requireAccessibleDoc } from "./lib/access";
import {
  deleteEntityRelationRows,
  listWorkspaceEntities,
  resolveCreateTeamId,
  requireValidOwner,
} from "./lib/steering";
import { invalidScope } from "./lib/auth";

const statusValidator = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("archived"),
);

// A strategy's doc must live in the same workspace as the strategy itself —
// a link to a foreign or personal doc would leak or dangle across the
// authorization boundary.
async function requireValidDocRef(ctx: any, userId: any, strategy: any, docId: any) {
  const doc = await requireAccessibleDoc(ctx, userId, docId);
  requireSameWorkspace(doc, workspaceForResource(strategy), "doc");
}

export const webList = query({
  args: {
    status: v.optional(statusValidator),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    let rows = await listWorkspaceEntities(ctx, userId, "strategies", args);
    if (args.status) rows = rows.filter((r: any) => r.status === args.status);
    return rows;
  },
});

export const webGet = query({
  args: { id: v.id("strategies") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const strategy = await ctx.db.get(args.id);
    if (!strategy || !(await canAccessSteeringEntity(ctx, userId, strategy))) return null;
    return strategy;
  },
});

export const webGetRef = query({
  args: { id: v.optional(v.string()), short_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const normalized = args.id ? ctx.db.normalizeId("strategies", args.id) : null;
    const strategy = normalized
      ? await ctx.db.get(normalized)
      : args.short_id
        ? await ctx.db.query("strategies").withIndex("by_short_id", q => q.eq("short_id", args.short_id!)).unique()
        : null;
    return strategy && await canAccessSteeringEntity(ctx, userId, strategy) ? strategy : null;
  },
});

// Change-feed batch fetch: current state for a set of strategy ids the user
// can access (own or team). Inaccessible / gone ids are omitted; the feed
// drives the prune. See changeFeed.ts.
export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const result: any[] = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("strategies", raw);
      if (!id) continue;
      const strategy = await ctx.db.get(id);
      if (!strategy || !(await canAccessSteeringEntity(ctx, userId, strategy))) continue;
      result.push(strategy);
    }
    return result;
  },
});

export const webCreate = mutation({
  args: {
    title: v.string(),
    status: v.optional(statusValidator),
    owner_id: v.optional(v.id("users")),
    doc_id: v.optional(v.id("docs")),
    review_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const team_id = await resolveCreateTeamId(ctx, userId, args);
    const scope = { user_id: userId, team_id };
    if (args.owner_id) await requireValidOwner(ctx, scope, args.owner_id);
    if (args.doc_id) await requireValidDocRef(ctx, userId, scope, args.doc_id);

    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "st");
    const id = await ctx.db.insert("strategies", {
      user_id: userId,
      team_id,
      short_id,
      title: args.title,
      status: args.status ?? "draft",
      owner_id: args.owner_id ?? userId,
      doc_id: args.doc_id,
      review_at: args.review_at,
      created_at: now,
      updated_at: now,
    });
    return { id, short_id };
  },
});

export const webUpdate = mutation({
  args: {
    id: v.id("strategies"),
    title: v.optional(v.string()),
    status: v.optional(statusValidator),
    owner_id: v.optional(v.id("users")),
    doc_id: v.optional(v.union(v.id("docs"), v.null())),
    review_at: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const strategy = await ctx.db.get(args.id);
    if (!strategy || !(await canAccessSteeringEntity(ctx, userId, strategy))) {
      throw new Error("Strategy not found");
    }
    await requireCanEditOwnerOrTeamEntity(ctx, userId, strategy, "strategy");

    const updates: any = { updated_at: Date.now() };
    if (args.title !== undefined) {
      if (!args.title.trim()) invalidScope("Title cannot be empty");
      updates.title = args.title;
    }
    if (args.status !== undefined) updates.status = args.status;
    if (args.owner_id !== undefined) {
      await requireValidOwner(ctx, strategy, args.owner_id);
      updates.owner_id = args.owner_id;
    }
    if (args.doc_id !== undefined) {
      if (args.doc_id === null) {
        updates.doc_id = undefined;
      } else {
        await requireValidDocRef(ctx, userId, strategy, args.doc_id);
        updates.doc_id = args.doc_id;
      }
    }
    if (args.review_at !== undefined) updates.review_at = args.review_at ?? undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

export const webDelete = mutation({
  args: { id: v.id("strategies") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const strategy = await ctx.db.get(args.id);
    if (!strategy || !(await canAccessSteeringEntity(ctx, userId, strategy))) {
      throw new Error("Strategy not found");
    }
    await requireCanDeleteOwnerOrTeamEntity(ctx, userId, strategy, "strategy");

    await deleteEntityRelationRows(ctx, "strategy", String(args.id));
    await ctx.db.delete(args.id);
    return { success: true };
  },
});
