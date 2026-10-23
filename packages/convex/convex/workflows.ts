import { internalMutation, mutation, query } from "./functions";
import { ConvexError, v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";
import { publishableFlowSource } from "@codecast/shared/contracts/flowPool";
import { createDataContext } from "./data";
import { computeWorkspaceKey, isTeamMember } from "./lib/access";
import { workflowEdgeValidator, workflowNodeValidator } from "./lib/workflowGraphValidators";

const nodeV = workflowNodeValidator;
const edgeV = workflowEdgeValidator;

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
  /** The graph's `label`: what a person reads as its name. A push always says ("" for none); a write that leaves it out leaves it as it was. */
  label: v.optional(v.string()),
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
  // The finding sources whose problems this line version runs (the graph's
  // `serves`): lineVersionFor routes a line run on a problem by them.
  serves: v.optional(v.array(v.string())),
  // `cast flow publish` (flows.md FL2): the workspace whose pool the flow
  // joins, named by the publisher. Any other push leaves where the row lives.
  publish: v.optional(v.object({
    workspace: v.union(v.literal("personal"), v.literal("team")),
    team_id: v.optional(v.id("teams")),
  })),
};

type Publish = { workspace: "personal" | "team"; team_id?: Id<"teams"> };

/**
 * The row's two axes (CLAUDE.md "Workspace access vs routing"), resolved
 * through the data context so a team is only ever one the publisher belongs
 * to. A publish files a flow under the workspace it names; a graph that is
 * a draft or declares no kind= is its owner's alone, whatever an earlier
 * publish said; any other push keeps the row where it is. Null: leave it.
 */
async function workflowAxes(ctx: any, userId: Id<"users">, source: string | undefined, publish: Publish | undefined, existing: any) {
  const publishable = publishableFlowSource(source);
  if (publish && !publishable) throw new ConvexError("Only a flow whose graph declares kind= and carries no draft= can be published");
  if (publish) return (await createDataContext(ctx, { userId, ...publish })).axes;
  if (publishable && existing?.workspace) return null;
  return (await createDataContext(ctx, { userId, workspace: "personal" })).axes;
}

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

// `serves`: a list or null (a push: written as the file says), undefined (the web: left as it is).
export async function upsertWorkflowFor(ctx: any, userId: Id<"users">, { create_only, serves, publish, ...args }: { name: string; slug: string; label?: string; goal?: string; source?: string; nodes: any[]; edges: any[]; model_stylesheet?: string; create_only?: boolean; origin?: any; serves?: string[] | null; publish?: Publish }) {
  const now = Date.now();
  const existing = await workflowBySlug(ctx, userId, args.slug);

  if (existing && create_only) throw new ConvexError(`${args.slug} already exists: reload to see its stations`);
  const axes = await workflowAxes(ctx, userId, args.source, publish, existing);
  if (existing) {
    await ctx.db.patch(existing._id, {
      name: args.name,
      ...(args.label !== undefined ? { label: args.label.trim() || undefined } : {}),
      goal: args.goal,
      source: args.source,
      nodes: args.nodes,
      edges: args.edges,
      model_stylesheet: args.model_stylesheet,
      // A push that does not say where the graph lives leaves what an earlier one said.
      ...(args.origin ? { origin: args.origin } : {}),
      ...(serves !== undefined ? { serves: serves ?? undefined } : {}),
      ...(axes ?? {}),
      updated_at: now,
    });
    if (args.origin) await recordGraphVersion(ctx, existing._id, userId, args.origin, now);
    return { id: existing._id, updated: true };
  }

  const id = await ctx.db.insert("workflows", {
    user_id: userId,
    // Personal unless published: workflows carry no project_path to resolve
    // a directory mapping against, so only a publish names a team.
    ...axes,
    name: args.name,
    slug: args.slug,
    ...(args.label?.trim() ? { label: args.label.trim() } : {}),
    goal: args.goal,
    source: args.source,
    nodes: args.nodes,
    edges: args.edges,
    model_stylesheet: args.model_stylesheet,
    ...(args.origin ? { origin: args.origin } : {}),
    ...(serves ? { serves } : {}),
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
    // A push says what its file serves: none named, none served.
    return await upsertWorkflowFor(ctx, result.userId, { ...args, serves: args.serves?.length ? args.serves : null });
  },
});

// The web's write (line settings, plan pl-838): the store's saveLineWorkflow
// rides dispatch here. A line slug must be one a role's line may name.
export const webUpsert = mutation({
  args: { ...upsertArgs, create_only: v.optional(v.boolean()) },
  // Only a machine's push says where a graph lives; the web never does.
  // Which sources a version serves is the graph file's to say, so the web's edit leaves it.
  // Publishing is `cast flow publish`'s; the web's edit leaves where the row lives.
  handler: async (ctx, { stack: _stack, origin: _origin, serves: _serves, publish: _publish, ...args }) => {
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

/** How many flows a pool read returns: the newest published ones. */
const POOL_CAP = 200;

/**
 * The pool's published flows in one workspace (flows.md FL2): every row
 * filed under its key, read through the data context, whose graph is still
 * publishable. A row joins only once a push filed it (a stored key): a row
 * from before keys is its owner's, whatever team it was once tagged with.
 * The owner's own rows also arrive through webList; a teammate's arrive only
 * here. A team the viewer is not in reads nothing.
 */
export async function poolFlowRows(ctx: any, userId: Id<"users">, teamId?: Id<"teams">) {
  if (teamId && !(await isTeamMember(ctx, userId, teamId))) return [];
  const db = await createDataContext(ctx, { userId, ...(teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }) });
  const rows: any[] = await db.query("workflows").collect();
  return rows
    .filter((w) => typeof w.workspace === "string" && w.workspace && publishableFlowSource(w.source))
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, POOL_CAP);
}

export const webPool = query({
  args: { team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await poolFlowRows(ctx, userId, args.team_id);
  },
});

/** `cast flow ls/show/run`: the pool's published flows, with who published each and what the CLI needs to run one. */
export const poolForCli = query({
  args: { api_token: v.string(), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };
    const rows = await poolFlowRows(ctx, result.userId, args.team_id);
    const names = new Map<string, string | null>();
    for (const r of rows) {
      const id = String(r.user_id);
      if (!names.has(id)) names.set(id, ((await ctx.db.get(r.user_id)) as any)?.name ?? null);
    }
    return {
      flows: rows.map((r) => ({
        _id: r._id, slug: r.slug, name: r.name, source: r.source, workspace: r.workspace, updated_at: r.updated_at,
        nodes: r.nodes.map((n: any) => ({ id: n.id, ...(n.prompt ? { prompt: n.prompt } : {}), ...(n.script ? { script: n.script } : {}) })),
        origin: r.origin ? { file: r.origin.file, files: r.origin.files } : null,
        by: names.get(String(r.user_id)) ?? null,
        mine: String(r.user_id) === String(result.userId),
      })),
    };
  },
});

// Rows from before keys stay their owner's (flows.md FL2): stamped personal,
// and the team tag the old insert copied from the user is dropped, so both
// axes say the same. Run repeatedly until it reports 0.
export const backfillWorkspace = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workflows")
      .withIndex("by_workspace", (q) => q.eq("workspace", undefined))
      .take(args.limit ?? 100);
    for (const r of rows) {
      await ctx.db.patch(r._id, { workspace: computeWorkspaceKey({ user_id: r.user_id }, null), team_id: undefined });
    }
    return { stamped: rows.length };
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

/** A run of the line (the shipped `line` or a role's `line-<x>`), as opposed to any other workflow. */
export const isLineRunSlug = (slug: string | null | undefined) => !!slug && (slug === "line" || slug.startsWith("line-"));

/**
 * The line version a run on this problem takes (the-line-model.md LM1: one
 * spine, a version per scenario): the runner's pushed graph that serves the
 * source of the problem's oldest finding, the newest push when two do. Null
 * for a task that is not a problem, a problem with no findings, or a source
 * no version serves; the run then takes the line it was started with.
 */
export async function lineVersionFor(ctx: any, userId: Id<"users">, task: { _id: Id<"tasks">; source?: string } | null | undefined) {
  if (!task || task.source !== "signal") return null;
  const first = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("asc").first();
  const source = first?.source?.trim().toLowerCase();
  if (!source) return null;
  const rows = await ctx.db.query("workflows").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const serving = rows.filter((w: any) => (w.serves ?? []).includes(source));
  return serving.sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0] ?? null;
}

/** `cast workflow run --task` asks which version the problem runs, to run it from its file on this machine. */
export const lineVersionForCli = query({
  args: { api_token: v.string(), task: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task)).first();
    const row = await lineVersionFor(ctx, result.userId, task);
    return { version: row ? { slug: row.slug, name: row.name, origin: row.origin ? { device_id: row.origin.device_id, root: row.origin.root, file: row.origin.file } : null } : null };
  },
});
