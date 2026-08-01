import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";
import { nextShortId } from "./counters";
import {
  canAccessSteeringEntity,
  requireAccessibleSteeringItem,
  requireCanDeleteOwnerOrTeamEntity,
  requireCanEditOwnerOrTeamEntity,
  requireSameWorkspace,
  workspaceForResource,
} from "./lib/access";
import {
  deleteEntityRelationRows,
  listWorkspaceEntities,
  resolveCreateTeamId,
  requireValidOwner,
} from "./lib/steering";
import { invalidScope } from "./lib/auth";

const kindValidator = v.union(v.literal("objective"), v.literal("bet"), v.literal("initiative"), v.literal("question"));
const priorityValidator = v.union(v.literal("urgent"), v.literal("high"), v.literal("medium"), v.literal("low"), v.literal("none"));
const statusValidator = v.union(
  v.literal("draft"), v.literal("active"), v.literal("paused"),
  v.literal("achieved"), v.literal("supported"), v.literal("weakened"),
  v.literal("invalidated"), v.literal("completed"), v.literal("open"),
  v.literal("investigating"), v.literal("resolved"), v.literal("closed"),
  v.literal("dropped"), v.literal("archived"),
);

const sparseFields = {
  success_criteria: v.optional(v.union(v.array(v.string()), v.null())),
  hypothesis: v.optional(v.union(v.string(), v.null())),
  resolution_summary: v.optional(v.union(v.string(), v.null())),
  intent: v.optional(v.union(v.string(), v.null())),
  rationale: v.optional(v.union(v.string(), v.null())),
  result_summary: v.optional(v.union(v.string(), v.null())),
  why_it_matters: v.optional(v.union(v.string(), v.null())),
  current_answer: v.optional(v.union(v.string(), v.null())),
  resolved_at: v.optional(v.union(v.number(), v.null())),
};

function validateKindFields(kind: string, fields: Record<string, any>) {
  const allowed: Record<string, Set<string>> = {
    objective: new Set(["success_criteria"]),
    bet: new Set(["hypothesis", "resolution_summary"]),
    initiative: new Set(["intent", "rationale", "success_criteria", "result_summary"]),
    question: new Set(["why_it_matters", "current_answer", "resolved_at"]),
  };
  for (const key of Object.keys(sparseFields)) {
    if (fields[key] !== undefined && fields[key] !== null && !allowed[kind]?.has(key)) {
      invalidScope(`${key} is not valid for a ${kind}`);
    }
  }
}

function validateStatus(kind: string, status: string) {
  const allowed: Record<string, Set<string>> = {
    objective: new Set(["draft", "active", "paused", "achieved", "dropped", "archived"]),
    bet: new Set(["draft", "active", "supported", "weakened", "invalidated", "closed", "dropped", "archived"]),
    initiative: new Set(["draft", "active", "paused", "completed", "dropped", "archived"]),
    question: new Set(["open", "investigating", "resolved", "dropped", "archived"]),
  };
  if (!allowed[kind]?.has(status)) invalidScope(`${status} is not a valid lifecycle state for a ${kind}`);
}

async function requireValidParent(ctx: any, userId: any, item: any, parentId: any) {
  const parent = await requireAccessibleSteeringItem(ctx, userId, parentId);
  requireSameWorkspace(parent, workspaceForResource(item), "parent item");
  let cursor: any = parent;
  for (let depth = 0; cursor && depth < 200; depth++) {
    if (item._id && String(cursor._id) === String(item._id)) invalidScope("Steering hierarchy cannot contain a cycle");
    cursor = cursor.parent_item_id ? await ctx.db.get(cursor.parent_item_id) : null;
  }
  if (cursor) invalidScope("Steering hierarchy is too deep or corrupted");
}

export const webList = query({
  args: { kind: v.optional(kindValidator), team_id: v.optional(v.id("teams")), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await listWorkspaceEntities(ctx, userId, "steering_items", args);
    return args.kind ? rows.filter((row: any) => row.kind === args.kind) : rows;
  },
});

export const webGet = query({
  args: { id: v.id("steering_items") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const item = await ctx.db.get(id);
    return item && await canAccessSteeringEntity(ctx, userId, item) ? item : null;
  },
});

export const webGetByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = [];
    for (const raw of args.ids.slice(0, 300)) {
      const id = ctx.db.normalizeId("steering_items", raw);
      if (!id) continue;
      const item = await ctx.db.get(id);
      if (item && await canAccessSteeringEntity(ctx, userId, item)) rows.push(item);
    }
    return rows;
  },
});

export const webCreate = mutation({
  args: {
    kind: kindValidator, parent_item_id: v.optional(v.id("steering_items")), title: v.string(), description: v.optional(v.string()),
    owner_id: v.optional(v.id("users")), priority: v.optional(priorityValidator), status: v.optional(statusValidator), sort_order: v.optional(v.number()),
    target_date: v.optional(v.number()), started_at: v.optional(v.number()), review_at: v.optional(v.number()), completed_at: v.optional(v.number()),
    success_criteria: v.optional(v.array(v.string())), hypothesis: v.optional(v.string()), resolution_summary: v.optional(v.string()), intent: v.optional(v.string()), rationale: v.optional(v.string()), result_summary: v.optional(v.string()), why_it_matters: v.optional(v.string()), current_answer: v.optional(v.string()), resolved_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!args.title.trim()) invalidScope("Title cannot be empty");
    validateKindFields(args.kind, args);
    const status = args.status ?? (args.kind === "question" ? "open" : "draft");
    validateStatus(args.kind, status);
    const parent = args.parent_item_id ? await requireAccessibleSteeringItem(ctx, userId, args.parent_item_id) : null;
    const team_id = parent ? parent.team_id : await resolveCreateTeamId(ctx, userId, args);
    const scope = { user_id: userId, team_id };
    if (args.owner_id) await requireValidOwner(ctx, scope, args.owner_id);
    if (args.parent_item_id) await requireValidParent(ctx, userId, scope, args.parent_item_id);
    let sort_order = args.sort_order;
    if (sort_order === undefined) {
      const siblings = await ctx.db.query("steering_items").withIndex("by_parent_item_id", q => q.eq("parent_item_id", args.parent_item_id)).collect();
      const scopedSiblings = args.parent_item_id ? siblings : siblings.filter((sibling: any) => team_id ? String(sibling.team_id) === String(team_id) : !sibling.team_id && String(sibling.user_id) === String(userId));
      sort_order = scopedSiblings.reduce((max: number, sibling: any) => Math.max(max, sibling.sort_order ?? 0), 0) + 1;
    }
    const now = Date.now();
    const short_id = await nextShortId(ctx.db, "si");
    const { workspace: _workspace, ...fields } = args;
    const id = await ctx.db.insert("steering_items", { ...fields, sort_order, team_id, user_id: userId, short_id, owner_id: args.owner_id ?? userId, priority: args.priority ?? "medium", status, created_at: now, updated_at: now });
    return { id, short_id };
  },
});

export const webUpdate = mutation({
  args: { id: v.id("steering_items"), kind: v.optional(kindValidator), parent_item_id: v.optional(v.union(v.id("steering_items"), v.null())), title: v.optional(v.string()), description: v.optional(v.union(v.string(), v.null())), owner_id: v.optional(v.id("users")), priority: v.optional(priorityValidator), status: v.optional(statusValidator), sort_order: v.optional(v.union(v.number(), v.null())), target_date: v.optional(v.union(v.number(), v.null())), started_at: v.optional(v.union(v.number(), v.null())), review_at: v.optional(v.union(v.number(), v.null())), completed_at: v.optional(v.union(v.number(), v.null())), ...sparseFields },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const item = await requireAccessibleSteeringItem(ctx, userId, args.id);
    await requireCanEditOwnerOrTeamEntity(ctx, userId, item, "steering item");
    const kind = args.kind ?? item.kind;
    validateKindFields(kind, args);
    if (args.status !== undefined) validateStatus(kind, args.status);
    const updates: any = { updated_at: Date.now() };
    for (const [key, value] of Object.entries(args)) if (key !== "id" && value !== undefined) updates[key] = value ?? undefined;
    if (args.title !== undefined && !args.title.trim()) invalidScope("Title cannot be empty");
    if (args.owner_id) await requireValidOwner(ctx, item, args.owner_id);
    if (args.parent_item_id) await requireValidParent(ctx, userId, item, args.parent_item_id);
    if (args.kind && args.kind !== item.kind) {
      if (args.status === undefined) updates.status = kind === "question" ? "open" : "draft";
      for (const key of Object.keys(sparseFields)) if (!({ objective: ["success_criteria"], bet: ["hypothesis", "resolution_summary"], initiative: ["intent", "rationale", "success_criteria", "result_summary"], question: ["why_it_matters", "current_answer", "resolved_at"] } as any)[kind].includes(key)) updates[key] = undefined;
    }
    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

export const webDelete = mutation({
  args: { id: v.id("steering_items") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const item = await requireAccessibleSteeringItem(ctx, userId, args.id);
    await requireCanDeleteOwnerOrTeamEntity(ctx, userId, item, "steering item");
    const child = await ctx.db.query("steering_items").withIndex("by_parent_item_id", q => q.eq("parent_item_id", args.id)).first();
    if (child) invalidScope("Steering item still has children; move or delete them first");
    await deleteEntityRelationRows(ctx, "steering_item", String(args.id));
    await ctx.db.delete(args.id);
    return { success: true };
  },
});

export const webReorder = mutation({
  args: { id: v.id("steering_items"), before_id: v.id("steering_items") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const item = await requireAccessibleSteeringItem(ctx, userId, args.id);
    const other = await requireAccessibleSteeringItem(ctx, userId, args.before_id);
    await requireCanEditOwnerOrTeamEntity(ctx, userId, item, "steering item");
    await requireCanEditOwnerOrTeamEntity(ctx, userId, other, "steering item");
    requireSameWorkspace(item, workspaceForResource(other), "reorder target");
    if (String(item.parent_item_id ?? "") !== String(other.parent_item_id ?? "")) invalidScope("Items must share a parent to reorder");
    const now = Date.now();
    const itemOrder = item.sort_order ?? 0;
    const otherOrder = other.sort_order ?? 0;
    await ctx.db.patch(item._id, { sort_order: otherOrder, updated_at: now });
    await ctx.db.patch(other._id, { sort_order: itemOrder, updated_at: now });
    return { success: true };
  },
});
