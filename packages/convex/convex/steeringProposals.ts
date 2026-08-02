import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { nextShortId } from "./counters";
import { canAccessConversation, requireAccessibleSteeringItem, requireCanEditOwnerOrTeamEntity, requireTeamMembership, workspaceForConversation } from "./lib/access";
import {
  linkWorkspace,
  requireAccessibleLinkableEntity,
  requireAllowedLink,
  requireAllowedSteeringItemKinds,
  resolveCreateTeamId,
  type LinkableEntityType,
  type SteeringLinkType,
} from "./lib/steering";
import { requireWorkspaceMatch } from "./lib/access";

type Operation = Record<string, any>;

const itemKinds = new Set(["objective", "bet", "initiative", "question"]);
const priorities = new Set(["urgent", "high", "medium", "low", "none"]);
const statusByKind: Record<string, Set<string>> = {
  objective: new Set(["draft", "active", "paused", "achieved", "dropped", "archived"]),
  bet: new Set(["draft", "active", "supported", "weakened", "invalidated", "closed", "dropped", "archived"]),
  initiative: new Set(["draft", "active", "paused", "completed", "dropped", "archived"]),
  question: new Set(["open", "investigating", "resolved", "dropped", "archived"]),
};
const fieldsByKind: Record<string, Set<string>> = {
  objective: new Set(["success_criteria"]),
  bet: new Set(["hypothesis", "resolution_summary"]),
  initiative: new Set(["intent", "rationale", "success_criteria", "result_summary"]),
  question: new Set(["why_it_matters", "current_answer", "resolved_at"]),
};
const kindFields = ["success_criteria", "hypothesis", "resolution_summary", "intent", "rationale", "result_summary", "why_it_matters", "current_answer", "resolved_at"];
const commonItemUpdateFields = new Set(["kind", "title", "description", "priority", "status", "target_date", "started_at", "review_at", "completed_at", ...kindFields]);
const strategyUpdateFields = new Set(["title", "status", "review_at"]);

async function apiUser(ctx: any, token?: string) {
  if (token) {
    const auth = await verifyApiToken(ctx, token);
    if (!auth) throw new Error("Unauthorized");
    return auth.userId;
  }
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

async function sourceConversation(ctx: any, userId: any, raw?: string) {
  if (!raw) return undefined;
  const normalized = ctx.db.normalizeId("conversations", raw);
  const conversation = normalized
    ? await ctx.db.get(normalized)
    : await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", raw)).first();
  if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) throw new Error("Conversation not found");
  return conversation;
}

async function canUseProposal(ctx: any, userId: any, proposal: any) {
  if (String(proposal.user_id) === String(userId) && !proposal.team_id) return true;
  if (proposal.team_id) {
    try { await requireTeamMembership(ctx, userId, proposal.team_id); return true; } catch { return false; }
  }
  return false;
}

function validateOperations(operations: Operation[]) {
  if (!operations.length) throw new Error("A Steering proposal needs at least one operation");
  if (operations.length > 100) throw new Error("A Steering proposal may contain at most 100 operations");
  const keys = new Set<string>();
  for (const op of operations) {
    if (!op || typeof op !== "object" || typeof op.op !== "string" || typeof op.key !== "string") throw new Error("Every operation needs op and key");
    if (keys.has(op.key)) throw new Error(`Duplicate proposal key: ${op.key}`);
    keys.add(op.key);
    if (op.op === "create_item") {
      if (!itemKinds.has(op.kind) || !String(op.title ?? "").trim()) throw new Error(`Invalid Steering Item operation: ${op.key}`);
      const status = op.status ?? (op.kind === "question" ? "open" : "draft");
      if (!statusByKind[op.kind].has(status)) throw new Error(`Invalid ${op.kind} status: ${status}`);
      if (op.priority != null && !priorities.has(op.priority)) throw new Error(`Invalid priority: ${op.priority}`);
      for (const field of kindFields) if (op[field] != null && !fieldsByKind[op.kind].has(field)) throw new Error(`${field} is not valid for ${op.kind}`);
    } else if (op.op === "create_strategy") {
      if (!String(op.title ?? "").trim()) throw new Error(`Invalid Strategy operation: ${op.key}`);
      if (op.status != null && !["draft", "active", "archived"].includes(op.status)) throw new Error(`Invalid Strategy status: ${op.status}`);
    } else if (op.op === "update_item") {
      if (!String(op.item_ref ?? "").trim() || !op.fields || typeof op.fields !== "object" || Array.isArray(op.fields)) throw new Error(`Invalid Steering Item update: ${op.key}`);
      for (const field of Object.keys(op.fields)) if (!commonItemUpdateFields.has(field)) throw new Error(`Unsupported Steering Item update field: ${field}`);
      for (const field of ["kind", "status", "priority"]) if (field in op.fields && op.fields[field] == null) throw new Error(`${field} cannot be cleared`);
      if (op.fields.kind != null && !itemKinds.has(op.fields.kind)) throw new Error(`Invalid Steering Item kind: ${op.fields.kind}`);
      if (op.fields.priority != null && !priorities.has(op.fields.priority)) throw new Error(`Invalid priority: ${op.fields.priority}`);
      if ("title" in op.fields && !String(op.fields.title ?? "").trim()) throw new Error("Title cannot be empty");
    } else if (op.op === "update_strategy") {
      if (!String(op.strategy_ref ?? "").trim() || !op.fields || typeof op.fields !== "object" || Array.isArray(op.fields)) throw new Error(`Invalid Strategy update: ${op.key}`);
      for (const field of Object.keys(op.fields)) if (!strategyUpdateFields.has(field)) throw new Error(`Unsupported Strategy update field: ${field}`);
      if ("status" in op.fields && op.fields.status == null) throw new Error("status cannot be cleared");
      if (op.fields.status != null && !["draft", "active", "archived"].includes(op.fields.status)) throw new Error(`Invalid Strategy status: ${op.fields.status}`);
      if ("title" in op.fields && !String(op.fields.title ?? "").trim()) throw new Error("Title cannot be empty");
    } else if (op.op === "link") {
      if (!op.from_type || !op.to_type || !op.link_type || !op.from_ref || !op.to_ref) throw new Error(`Invalid link operation: ${op.key}`);
    } else {
      throw new Error(`Unsupported proposal operation: ${op.op}`);
    }
  }
  for (const op of operations) {
    if (op.parent_ref && !keys.has(op.parent_ref) && !String(op.parent_ref).match(/^[a-z0-9]{32}$/)) throw new Error(`Unknown parent_ref: ${op.parent_ref}`);
  }
}

async function createProposal(ctx: any, args: any) {
  const userId = await apiUser(ctx, args.api_token);
  validateOperations(args.operations);
  const conversation = await sourceConversation(ctx, userId, args.conversation_id);
  const conversationWorkspace = conversation ? workspaceForConversation(conversation) : undefined;
  const team_id = conversationWorkspace
    ? conversationWorkspace.type === "team" ? conversationWorkspace.teamId : undefined
    : await resolveCreateTeamId(ctx, userId, { team_id: args.team_id, workspace: args.workspace });
  const now = Date.now();
  const short_id = await nextShortId(ctx.db, "sp");
  const id = await ctx.db.insert("steering_proposals", {
    user_id: userId, team_id, conversation_id: conversation?._id, short_id,
    title: String(args.title).trim(), summary: args.summary, status: "proposed",
    operations: args.operations, created_at: now, updated_at: now,
  });
  return { id, short_id };
}

async function applyProposal(ctx: any, userId: any, proposal: any) {
  if (!(await canUseProposal(ctx, userId, proposal))) throw new Error("Proposal not found");
  if (proposal.status !== "proposed") throw new Error(`Proposal is already ${proposal.status}`);
  validateOperations(proposal.operations);
  const refs = new Map<string, { type: string; id: string; row: any; short_id?: string }>();
  const applied: any[] = [];
  const now = Date.now();
  const scope = { user_id: userId, team_id: proposal.team_id };

  for (const op of proposal.operations as Operation[]) {
    if (op.op === "create_strategy") {
      const short_id = await nextShortId(ctx.db, "st");
      const id = await ctx.db.insert("strategies", { ...scope, short_id, title: op.title.trim(), status: op.status ?? "draft", owner_id: userId, created_at: now, updated_at: now });
      const row = { _id: id, ...scope, short_id, title: op.title.trim(), status: op.status ?? "draft" };
      refs.set(op.key, { type: "strategy", id: String(id), row, short_id });
      applied.push({ key: op.key, type: "strategy", id: String(id), short_id });
    }
    if (op.op === "create_item") {
      const parent = op.parent_ref ? refs.get(op.parent_ref) : undefined;
      const parentId = parent?.type === "steering_item" ? parent.id : op.parent_ref;
      if (parentId) {
        const parentRow = parent?.row ?? await requireAccessibleSteeringItem(ctx, userId, parentId);
        requireWorkspaceMatch(linkWorkspace(scope), linkWorkspace(parentRow), `parent for ${op.key}`);
      }
      const short_id = await nextShortId(ctx.db, "si");
      const status = op.status ?? (op.kind === "question" ? "open" : "draft");
      const fields: any = {};
      for (const field of kindFields) if (op[field] != null) fields[field] = op[field];
      const normalizedParentId = parentId ? ctx.db.normalizeId("steering_items", parentId) : undefined;
      if (parentId && !normalizedParentId) throw new Error(`Invalid parent for ${op.key}`);
      const siblings = await ctx.db.query("steering_items").withIndex("by_parent_item_id", (q: any) => q.eq("parent_item_id", normalizedParentId)).collect();
      const scopedSiblings = normalizedParentId ? siblings : siblings.filter((row: any) => proposal.team_id ? String(row.team_id) === String(proposal.team_id) : !row.team_id && String(row.user_id) === String(userId));
      const sort_order = op.sort_order ?? scopedSiblings.reduce((max: number, row: any) => Math.max(max, row.sort_order ?? 0), 0) + 1;
      const id = await ctx.db.insert("steering_items", {
        ...scope, ...fields, short_id, kind: op.kind, parent_item_id: normalizedParentId,
        title: op.title.trim(), description: op.description, owner_id: userId, priority: op.priority ?? "medium",
        status, sort_order, created_at: now, updated_at: now,
      });
      const row = { _id: id, ...scope, short_id, kind: op.kind, title: op.title.trim(), status };
      refs.set(op.key, { type: "steering_item", id: String(id), row, short_id });
      applied.push({ key: op.key, type: "steering_item", id: String(id), short_id });
    }
  }

  for (const op of proposal.operations as Operation[]) {
    if (op.op === "update_item") {
      const localRef = refs.get(op.item_ref);
      const item = localRef?.type === "steering_item"
        ? localRef.row
        : await requireAccessibleLinkableEntity(ctx, userId, "steering_item", op.item_ref);
      await requireCanEditOwnerOrTeamEntity(ctx, userId, item, "steering item");
      requireWorkspaceMatch(linkWorkspace(scope), linkWorkspace(item), "proposal update");
      const fields = op.fields as Record<string, any>;
      const kind = fields.kind ?? item.kind;
      if (!itemKinds.has(kind)) throw new Error(`Invalid Steering Item kind: ${kind}`);
      for (const field of kindFields) if (fields[field] != null && !fieldsByKind[kind].has(field)) throw new Error(`${field} is not valid for ${kind}`);
      if (fields.status != null && !statusByKind[kind].has(fields.status)) throw new Error(`Invalid ${kind} status: ${fields.status}`);
      const updates: any = { updated_at: now };
      for (const [field, value] of Object.entries(fields)) updates[field] = value ?? undefined;
      if (fields.kind && fields.kind !== item.kind) {
        if (fields.status === undefined) updates.status = kind === "question" ? "open" : "draft";
        for (const field of kindFields) if (!fieldsByKind[kind].has(field)) updates[field] = undefined;
      }
      await ctx.db.patch(item._id, updates);
      Object.assign(item, updates);
      applied.push({ key: op.key, type: "steering_item_update", id: String(item._id), short_id: item.short_id });
    }
    if (op.op === "update_strategy") {
      const localRef = refs.get(op.strategy_ref);
      const strategy = localRef?.type === "strategy"
        ? localRef.row
        : await requireAccessibleLinkableEntity(ctx, userId, "strategy", op.strategy_ref);
      await requireCanEditOwnerOrTeamEntity(ctx, userId, strategy, "strategy");
      requireWorkspaceMatch(linkWorkspace(scope), linkWorkspace(strategy), "proposal update");
      const updates: any = { updated_at: now };
      for (const [field, value] of Object.entries(op.fields as Record<string, any>)) updates[field] = value ?? undefined;
      await ctx.db.patch(strategy._id, updates);
      Object.assign(strategy, updates);
      applied.push({ key: op.key, type: "strategy_update", id: String(strategy._id), short_id: strategy.short_id });
    }
  }

  for (const op of proposal.operations as Operation[]) if (op.op === "link") {
    const fromRef = refs.get(op.from_ref);
    const toRef = refs.get(op.to_ref);
    const fromType = (fromRef?.type ?? op.from_type) as LinkableEntityType;
    const toType = (toRef?.type ?? op.to_type) as LinkableEntityType;
    const from = fromRef?.row ?? await requireAccessibleLinkableEntity(ctx, userId, fromType, op.from_ref);
    const to = toRef?.row ?? await requireAccessibleLinkableEntity(ctx, userId, toType, op.to_ref);
    requireAllowedLink(fromType, op.link_type as SteeringLinkType, toType);
    if (fromType === "steering_item" && toType === "steering_item") requireAllowedSteeringItemKinds(from, op.link_type, to);
    const workspace = linkWorkspace(from);
    requireWorkspaceMatch(workspace, linkWorkspace(to), "link target");
    requireWorkspaceMatch(linkWorkspace(scope), workspace, "proposal link");
    const id = await ctx.db.insert("entity_links", { ...scope, from_type: fromType, from_id: String(from._id), link_type: op.link_type, to_type: toType, to_id: String(to._id), created_at: now });
    applied.push({ key: op.key, type: "entity_link", id: String(id) });
  }
  await ctx.db.patch(proposal._id, { status: "applied", applied_entities: applied, applied_at: now, updated_at: now });
  return { success: true, proposal_id: proposal._id, entities: applied };
}

const proposalArgs = {
  title: v.string(), summary: v.optional(v.string()), operations: v.array(v.any()),
  conversation_id: v.optional(v.string()), team_id: v.optional(v.id("teams")),
  workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
};

export const webCreate = mutation({ args: proposalArgs, handler: createProposal });
export const cliCreate = mutation({ args: { api_token: v.string(), ...proposalArgs }, handler: createProposal });

export const webList = query({
  args: { conversation_id: v.optional(v.id("conversations")), status: v.optional(v.string()), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await apiUser(ctx);
    let rows: any[];
    if (args.conversation_id) rows = await ctx.db.query("steering_proposals").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id)).collect();
    else if (args.workspace === "team" && args.team_id) {
      await requireTeamMembership(ctx, userId, args.team_id);
      rows = await ctx.db.query("steering_proposals").withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id)).collect();
    } else {
      rows = (await ctx.db.query("steering_proposals").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect()).filter((row: any) => args.workspace !== "personal" || !row.team_id);
    }
    const visible = [];
    for (const row of rows) if ((!args.status || row.status === args.status) && await canUseProposal(ctx, userId, row)) visible.push(row);
    return visible.sort((a: any, b: any) => b.updated_at - a.updated_at);
  },
});

export const webGetRef = query({
  args: { id: v.optional(v.string()), short_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await apiUser(ctx);
    const normalized = args.id ? ctx.db.normalizeId("steering_proposals", args.id) : null;
    const row = normalized
      ? await ctx.db.get(normalized)
      : args.short_id
        ? await ctx.db.query("steering_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id!)).unique()
        : null;
    return row && await canUseProposal(ctx, userId, row) ? row : null;
  },
});

export const cliGet = query({
  args: { api_token: v.string(), short_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await apiUser(ctx, args.api_token);
    const row = await ctx.db.query("steering_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id)).unique();
    return row && await canUseProposal(ctx, userId, row) ? row : null;
  },
});

export const webApply = mutation({ args: { id: v.id("steering_proposals") }, handler: async (ctx, args) => {
  const userId = await apiUser(ctx);
  const proposal = await ctx.db.get(args.id);
  if (!proposal) throw new Error("Proposal not found");
  return applyProposal(ctx, userId, proposal);
} });
export const cliApply = mutation({ args: { api_token: v.string(), short_id: v.string() }, handler: async (ctx, args) => {
  const userId = await apiUser(ctx, args.api_token);
  const proposal = await ctx.db.query("steering_proposals").withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id)).unique();
  if (!proposal) throw new Error("Proposal not found");
  return applyProposal(ctx, userId, proposal);
} });

export const webDismiss = mutation({ args: { id: v.id("steering_proposals") }, handler: async (ctx, args) => {
  const userId = await apiUser(ctx); const proposal = await ctx.db.get(args.id);
  if (!proposal || !(await canUseProposal(ctx, userId, proposal))) throw new Error("Proposal not found");
  if (proposal.status !== "proposed") throw new Error(`Proposal is already ${proposal.status}`);
  await ctx.db.patch(args.id, { status: "dismissed", updated_at: Date.now() }); return { success: true };
} });
