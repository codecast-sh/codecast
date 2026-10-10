import { mutation, query } from "./functions";
import { ConvexError, v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";

const nodeV = v.object({
  id: v.string(),
  label: v.string(),
  shape: v.string(),
  type: v.string(),
  prompt: v.optional(v.string()),
  script: v.optional(v.string()),
  reasoning_effort: v.optional(v.string()),
  model: v.optional(v.string()),
  max_visits: v.optional(v.number()),
  max_retries: v.optional(v.number()),
  retry_target: v.optional(v.string()),
  goal_gate: v.optional(v.boolean()),
  // The CLI pushes these three; a validator without them rejected every push
  // that named a backend (the run then went unrendered in the web UI).
  backend: v.optional(v.string()),
  agent: v.optional(v.string()),
  isolated: v.optional(v.boolean()),
  // the-line.md L8: every attribute the runner reads survives the push.
  definition: v.optional(v.string()),
  reviewer: v.optional(v.boolean()),
  timeout: v.optional(v.number()),
  temperature: v.optional(v.number()),
  doc: v.optional(v.string()),
  category: v.optional(v.string()),
  card: v.optional(v.string()),
});

const edgeV = v.object({
  from: v.string(),
  to: v.string(),
  label: v.optional(v.string()),
  condition: v.optional(v.string()),
});

// Where a pushed graph lives (schema workflows.origin, line-workspace.md LW4).
export const graphOriginV = v.object({
  device_id: v.string(),
  root: v.string(),
  file: v.string(),
  files: v.array(v.object({ node: v.string(), prompt: v.optional(v.string()), script: v.optional(v.string()) })),
  graph_hash: v.string(),
  nodes: v.array(v.object({ id: v.string(), h: v.string() })),
});

const upsertArgs = {
  name: v.string(),
  slug: v.string(),
  goal: v.optional(v.string()),
  source: v.optional(v.string()),
  nodes: v.array(nodeV),
  edges: v.array(edgeV),
  model_stylesheet: v.optional(v.string()),
  // The graph attribute stack (the-line.md L4). Accepted so the push does
  // not fail; the row has no stack column yet, so a daemon run reads it
  // back from `source` (daemonGraph.ts). Store it here once
  // `workflows.stack` exists in the schema.
  stack: v.optional(v.string()),
  // Only a push from a file in a checkout carries it (cli lineGraphEdit.graphOrigin).
  origin: v.optional(graphOriginV),
};

// One body for the CLI push and the web's edit: a row per (user, slug).
// `create_only` refuses a slug that already has a row (the line's fork).
const workflowBySlug = (ctx: any, userId: Id<"users">, slug: string) =>
  ctx.db.query("workflows").withIndex("by_user_slug", (q: any) => q.eq("user_id", userId).eq("slug", slug)).first();

/**
 * A new version of the graph when its hash moved (LW4: every save is a
 * version of the step): each station's hash, and which stations changed
 * since the version before.
 */
export async function recordGraphVersion(ctx: any, workflowId: Id<"workflows">, userId: Id<"users">, origin: { graph_hash: string; nodes: Array<{ id: string; h: string }> }, now = Date.now()) {
  const last = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).order("desc").first();
  if (last?.graph_hash === origin.graph_hash) return null;
  const was = new Map<string, string>((last?.nodes ?? []).map((n: any) => [n.id, n.h]));
  const changed = origin.nodes.filter((n) => was.get(n.id) !== n.h).map((n) => n.id);
  return await ctx.db.insert("workflow_versions", { workflow_id: workflowId, graph_hash: origin.graph_hash, nodes: origin.nodes, changed, by: userId, at: now });
}

async function upsertWorkflowFor(ctx: any, userId: Id<"users">, { create_only, ...args }: { name: string; slug: string; goal?: string; source?: string; nodes: any[]; edges: any[]; model_stylesheet?: string; create_only?: boolean; origin?: any }) {
  const now = Date.now();
  const existing = await workflowBySlug(ctx, userId, args.slug);

  if (existing && create_only) throw new ConvexError(`${args.slug} already exists: reload to see its stations`);
  if (existing) {
    await ctx.db.patch(existing._id, {
      name: args.name,
      goal: args.goal,
      source: args.source,
      nodes: args.nodes,
      edges: args.edges,
      model_stylesheet: args.model_stylesheet,
      // A push that does not say where the graph lives leaves what an earlier one said.
      ...(args.origin ? { origin: args.origin } : {}),
      updated_at: now,
    });
    if (args.origin) await recordGraphVersion(ctx, existing._id, userId, args.origin, now);
    return { id: existing._id, updated: true };
  }

  const id = await ctx.db.insert("workflows", {
    user_id: userId,
    // Personal by default: workflows carry no project_path to resolve a
    // directory mapping against, and stamping the active team here would
    // expose them wholesale the day a team read path lands on by_team_id.
    name: args.name,
    slug: args.slug,
    goal: args.goal,
    source: args.source,
    nodes: args.nodes,
    edges: args.edges,
    model_stylesheet: args.model_stylesheet,
    ...(args.origin ? { origin: args.origin } : {}),
    created_at: now,
    updated_at: now,
  });
  if (args.origin) await recordGraphVersion(ctx, id, userId, args.origin, now);
  return { id, updated: false };
}

export const upsert = mutation({
  args: { api_token: v.string(), ...upsertArgs },
  handler: async (ctx, { api_token, stack: _stack, ...args }) => {
    const result = await verifyApiToken(ctx, api_token);
    if (!result) return { error: "Unauthorized" };
    const user = await ctx.db.get(result.userId);
    if (!user) return { error: "User not found" };
    return await upsertWorkflowFor(ctx, result.userId, args);
  },
});

// The web's write (line settings, plan pl-838): the store's saveLineWorkflow
// rides dispatch here. A line slug must be one a role's line may name.
export const webUpsert = mutation({
  args: { ...upsertArgs, create_only: v.optional(v.boolean()) },
  // Only a machine's push says where a graph lives; the web never does.
  handler: async (ctx, { stack: _stack, origin: _origin, ...args }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    if (!LINE_SLUG_RE.test(args.slug)) throw new Error("A workflow slug is 1 to 64 characters of a-z, 0-9 and -");
    return await upsertWorkflowFor(ctx, userId, args);
  },
});

export const list = mutation({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };

    const workflows = await ctx.db
      .query("workflows")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .order("desc")
      .take(50);

    return { workflows };
  },
});

export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    return await ctx.db
      .query("workflows")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(50);
  },
});

// One workflow by slug, whatever its age: webList is a 50-newest window, and
// the line's fork must reach the page that decides whether it exists.
export const webGetBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await workflowBySlug(ctx, userId, args.slug);
  },
});

// Stop customizing a line (line settings): the viewer's own row by slug goes.
export const webRemove = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    const row = await workflowBySlug(ctx, userId, args.slug);
    if (row) await ctx.db.delete(row._id);
    return { removed: !!row };
  },
});

export const webGet = query({
  args: { id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const w = await ctx.db.get(args.id);
    if (!w || w.user_id !== userId) return null;
    return w;
  },
});
