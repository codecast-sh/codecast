import { internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";
import { ConvexError, v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { normalizeRepository } from "./lib/gitRefs";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";
import { publishableFlowSource } from "@codecast/shared/contracts/flowPool";
import { createDataContext } from "./data";
import { computeWorkspaceKey, isTeamMember } from "./lib/access";
import { workflowEdgeValidator, workflowNodeValidator } from "./lib/workflowGraphValidators";
import { libraryOfFlow, recordWorkflowVersion } from "./flowVersions";
import { flowRouteFor, type FlowRoute } from "./lib/flowRoute";
import { isJudgeProblem } from "@codecast/shared/contracts/judgeReview";
import { LIBRARY_LINE, newestOfLine, nextSeq } from "./lib/runGraph";

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
  // `serves`): lineRouteFor routes a line run on a problem by them.
  serves: v.optional(v.array(v.string())),
  // `cast flow publish` (flows.md FL2): the workspace whose pool the flow
  // joins, named by the publisher. Any other push leaves where the row lives.
  publish: v.optional(v.object({
    workspace: v.union(v.literal("personal"), v.literal("team")),
    team_id: v.optional(v.id("teams")),
  })),
  // A save (flowVersions.ts): `cast workflow push`, `cast flow save`. Only a
  // save or a publish changes a library flow; a run's own push leaves it.
  save: v.optional(v.boolean()),
  // `cast flow save`: the flow's runs read the library from now on.
  library: v.optional(v.boolean()),
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
 * version of the step): each station's hash, which stations changed since the
 * version before, and its number in the row's history. `kept.line` is the
 * line it extends (lib/runGraph.ts): a later push from the same place, or a
 * library save. A version with no line (a push from no file) is the newest
 * no-file version again when its graph is the same.
 */
export async function recordGraphVersion(ctx: any, workflowId: Id<"workflows">, userId: Id<"users">, origin: { graph_hash: string; nodes: Array<{ id: string; h: string }> }, now: number, snapshot: Doc<"workflow_versions">["snapshot"] | undefined, kept: { line?: string; pushed_from?: Doc<"workflow_versions">["pushed_from"]; graph?: () => Promise<Id<"workflow_version_graphs">>; segments?: SegmentPins }): Promise<{ id: Id<"workflow_versions">; created: boolean }> {
  const newest: Doc<"workflow_versions"> | null = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).order("desc").first();
  // The version this one would be again: the newest of its line; a library flow's, the newest of the row, so its
  // first save of the graph its history already names keeps that version; a push from no file, the newest when it too
  // came from no file.
  const prev: Doc<"workflow_versions"> | null = kept.line === LIBRARY_LINE ? newest
    : kept.line ? await newestOfLine(ctx, workflowId, kept.line)
    : newest && !newest.line && !newest.pushed_from ? newest : null;
  // A library version is its graph and the segment versions it pins: the same graph saved when a segment has moved on
  // is a new version, so a version's runs never change under it. A version no run read yet (no content) takes them.
  if (prev?.graph_hash === origin.graph_hash && (!kept.segments || !prev.snapshot || sameSegmentPins(prev.segments, kept.segments))) {
    if (snapshot && !prev.snapshot) await ctx.db.patch(prev._id, { snapshot, ...(kept.line ? { line: kept.line } : {}), ...(kept.segments?.length ? { segments: kept.segments } : {}) });
    if (kept.graph && !prev.graph_id) await ctx.db.patch(prev._id, { graph_id: await kept.graph() });
    return { id: prev._id, created: false };
  }
  // Stations that moved since its line's version before, else the row's (a checkout's first push of a graph the row
  // already has shows no change); all of them when that version has no hashes to compare.
  const basis = prev ?? newest;
  const was = new Map<string, string>((basis?.nodes ?? []).map((n: any) => [n.id, n.h]));
  const changed = origin.nodes.filter((n) => !was.size || was.get(n.id) !== n.h).map((n) => n.id);
  const graph_id = kept.graph ? await kept.graph() : undefined;
  const seq = newest?.seq ? newest.seq + 1 : await nextSeq(ctx, workflowId);
  return { id: await ctx.db.insert("workflow_versions", { workflow_id: workflowId, graph_hash: origin.graph_hash, nodes: origin.nodes, changed, by: userId, at: now, seq, ...(kept.line ? { line: kept.line } : {}), ...(snapshot ? { snapshot } : {}), ...(graph_id ? { graph_id } : {}), ...(kept.pushed_from ? { pushed_from: kept.pushed_from } : {}), ...(kept.segments?.length ? { segments: kept.segments } : {}) }), created: true };
}

export type SegmentPins = NonNullable<Doc<"workflow_versions">["segments"]>;
const sameSegmentPins = (a: SegmentPins | undefined, b: SegmentPins) =>
  JSON.stringify((a ?? []).map((x) => [x.slug, String(x.version_id)])) === JSON.stringify(b.map((x) => [x.slug, String(x.version_id)]));

// `serves`: a list or null (a push: written as the file says), undefined (the web: left as it is).
// `library`: "switch" puts the flow in the library (`cast flow save`, a session's Save); "new" only a flow this write creates (the web's).
// `web`: the web's settings edit, which never moves a flow off its file's version (flowVersions.ts recordWorkflowVersion).
export async function upsertWorkflowFor(ctx: any, userId: Id<"users">, { create_only, serves, publish, save, library, web, ...args }: { name: string; slug: string; label?: string; goal?: string; source?: string; nodes: any[]; edges: any[]; model_stylesheet?: string; create_only?: boolean; origin?: any; serves?: string[] | null; publish?: Publish; save?: boolean; library?: "switch" | "new"; web?: boolean }) {
  const now = Date.now();
  const existing = await workflowBySlug(ctx, userId, args.slug);

  if (existing && create_only) throw new ConvexError(`${args.slug} already exists: reload to see its stations`);
  // A library flow changes only on a save (flowVersions.ts).
  if (existing?.runs_from === "library" && !save && !publish) return { id: existing._id, updated: false, held: true };
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
      ...(library === "switch" && existing.runs_from !== "library" ? { runs_from: "library" as const } : {}),
      updated_at: now,
    });
    const version = await recordWorkflowVersion(ctx, existing._id, userId, args.origin, now, web);
    return { id: existing._id, updated: true, ...(version ? { version_id: version.id } : {}) };
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
    ...(library ? { runs_from: "library" as const } : {}),
    created_at: now,
    updated_at: now,
  });
  const version = await recordWorkflowVersion(ctx, id, userId, args.origin, now);
  return { id, updated: false, ...(version ? { version_id: version.id } : {}) };
}

export const upsert = mutation({
  args: { api_token: v.string(), ...upsertArgs },
  handler: async (ctx, { api_token, stack: _stack, ...args }) => {
    const result = await verifyApiToken(ctx, api_token);
    if (!result) return { error: "Unauthorized" };
    const user = await ctx.db.get(result.userId);
    if (!user) return { error: "User not found" };
    // A push says what its file serves: none named, none served.
    return await upsertWorkflowFor(ctx, result.userId, { ...args, serves: args.serves?.length ? args.serves : null, library: args.library ? "switch" : undefined, save: args.save || args.library });
  },
});

// The web's write (line settings, plan pl-838): the store's saveLineWorkflow
// rides dispatch here. A line slug must be one a role's line may name.
export const webUpsert = mutation({
  args: { ...upsertArgs, create_only: v.optional(v.boolean()) },
  // Only a machine's push says where a graph lives; the web never does.
  // Which sources a version serves is the graph file's to say, so the web's edit leaves it.
  // Publishing is `cast flow publish`'s; the web's edit leaves where the row lives.
  // The web's edit is a save, and a flow it creates runs from the library (ct-70169).
  handler: async (ctx, { stack: _stack, origin: _origin, serves: _serves, publish: _publish, save: _save, library: _library, ...args }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    if (!LINE_SLUG_RE.test(args.slug)) throw new Error("A workflow slug is 1 to 64 characters of a-z, 0-9 and -");
    return await upsertWorkflowFor(ctx, userId, { ...args, save: true, library: "new", web: true });
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
      // Whether the workspace has the Flows feature on: session start names the pool only then.
      flows_on: await workspaceHasFeature(ctx, { team_id: args.team_id ?? null, user_id: result.userId }, "line"),
      // The flow the team set as its default (teams.default_flow): a nameless `cast flow run` resolves it with defaultFlowOf.
      default_flow: args.team_id && (await isTeamMember(ctx, result.userId, args.team_id)) ? (await ctx.db.get(args.team_id))?.default_flow ?? null : null,
      flows: rows.map((r) => ({
        _id: r._id, slug: r.slug, name: r.name, source: r.source, workspace: r.workspace, updated_at: r.updated_at, runs_from: r.runs_from ?? null,
        nodes: r.nodes.map((n: any) => ({ id: n.id, ...(n.prompt ? { prompt: n.prompt } : {}), ...(n.script ? { script: n.script } : {}) })),
        origin: r.origin ? { file: r.origin.file, files: r.origin.files } : null,
        by: names.get(String(r.user_id)) ?? null,
        mine: String(r.user_id) === String(result.userId),
      })),
    };
  },
});

/**
 * What `cast flow` needs to tell a personal checkout (cli directoryTeam.ts): the workspace the calling session is
 * stamped into (its team_id, which the web's Ship reads; null when there is no session or the caller owns none by that
 * ref), and whether any team the caller belongs to already knows the checkout's repository, whatever folder it sits in:
 * a teammate's published checkout of it (repo_sources), a pull request of it the team holds (pull_requests), a
 * commit of it the team's sessions made (commits), or a share rule of a member's that names it (directory_team_mappings). `in_team`
 * says whether the caller belongs to any team: one who belongs to none has nobody to share a checkout with. Internal:
 * only the http route /cli/workflows/workspace-facts runs it, for the caller its token names.
 */
export const workspaceFactsForCli = internalQuery({
  args: { api_token: v.string(), session: v.optional(v.string()), repository: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };
    const conv = args.session ? await findConversationByAnyRef(ctx, args.session, result.userId) : null;
    // A session the server bound to an open team task (tasks.spawnSessionForTask) works for that team, whatever its
    // own stamp: its change is never personal.
    const bound: any = conv?.active_task_id ? await ctx.db.get(conv.active_task_id) : null;
    const teamTask = bound?.team_id && bound.status !== "done" && bound.status !== "dropped" ? bound.team_id : null;
    const workspace = conv ? (conv.team_id ? `team:${conv.team_id}` : teamTask ? `team:${teamTask}` : "personal") : null;
    const membership = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", result.userId)).first();
    return {
      workspace,
      team_repository: args.repository ? await teamKnowsRepository(ctx, result.userId, normalizeRepository(args.repository)) : false,
      in_team: !!membership,
    };
  },
});

async function teamKnowsRepository(ctx: { db: any }, userId: Id<"users">, repository: string): Promise<boolean> {
  const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  for (const m of memberships) {
    const source = await ctx.db.query("repo_sources").withIndex("by_team_repository", (q: any) => q.eq("team_id", m.team_id).eq("repository", repository)).first();
    if (source) return true;
    const pr = await ctx.db.query("pull_requests").withIndex("by_team_repository", (q: any) => q.eq("team_id", m.team_id).eq("repository", repository)).first();
    if (pr) return true;
    const commit = await ctx.db.query("commits").withIndex("by_team_repository", (q: any) => q.eq("team_id", m.team_id).eq("repository", repository)).first();
    if (commit) return true;
    // A teammate's share rule on a checkout of it, auto-shared or not: the team works in it, privately or openly.
    const rules = await ctx.db.query("directory_team_mappings").withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id)).collect();
    if (rules.some((r: any) => !r.private && r.repository && normalizeRepository(r.repository) === repository)) return true;
  }
  return false;
}

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
    if (row) {
      await ctx.db.delete(row._id);
      // The graphs its versions kept go with it.
      await removeKeptGraphsCore(ctx, row._id);
    }
    return { removed: !!row };
  },
});

// A kept graph is up to SNAPSHOT_MAX_BYTES, so a heavily edited flow's graphs go a few at a time, each batch its own
// mutation, until none is left.
const KEPT_GRAPH_BATCH = 8;
async function removeKeptGraphsCore(ctx: any, workflowId: Id<"workflows">) {
  const batch = await ctx.db.query("workflow_version_graphs").withIndex("by_workflow_key", (q: any) => q.eq("workflow_id", workflowId)).take(KEPT_GRAPH_BATCH + 1);
  for (const g of batch.slice(0, KEPT_GRAPH_BATCH)) await ctx.db.delete(g._id);
  if (batch.length > KEPT_GRAPH_BATCH) await ctx.scheduler.runAfter(0, internal.workflows.removeKeptGraphs, { workflow_id: workflowId });
}

export const removeKeptGraphs = internalMutation({
  args: { workflow_id: v.id("workflows") },
  handler: async (ctx, args) => {
    await removeKeptGraphsCore(ctx, args.workflow_id);
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

/** The source of a problem: its oldest finding's, lowercased; null for a task that is not a problem or has no findings. */
export async function problemSourceOf(ctx: any, task: { _id: Id<"tasks">; source?: string } | null | undefined): Promise<string | null> {
  if (!task || task.source !== "signal") return null;
  const first = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("asc").first();
  return first?.source?.trim().toLowerCase() || null;
}

type RouteTask = { _id: Id<"tasks">; source?: string; workspace?: string; cause?: any };

/**
 * The route a task takes under its workspace's live flow (lib/flowRoute): a
 * member of the flow's family, whoever runs it. Null when the workspace has
 * no live flow that is on.
 */
export async function liveFlowRouteOf(ctx: any, task: RouteTask | null | undefined): Promise<FlowRoute<Doc<"workflows">> | null> {
  if (!task?.workspace) return null;
  const flows: any[] = await ctx.db.query("live_flows").withIndex("by_workspace", (q: any) => q.eq("workspace", task.workspace)).collect();
  const flow = flows.find((f) => f.on);
  if (!flow) return null;
  const rows: Doc<"workflows">[] = await ctx.db.query("workflows").withIndex("by_workspace", (q: any) => q.eq("workspace", flow.workspace)).collect();
  return flowRouteFor({ flow, spine: await ctx.db.get(flow.workflow_id), rows, source: await problemSourceOf(ctx, task), judge: isJudgeProblem(task.cause) });
}

/**
 * The line version a run on this task takes (the-line-model.md LM1: one
 * spine, a version per scenario). Under a live flow that is on, the flow's
 * family picks it (liveFlowRouteOf), and `waiting` says why a problem it
 * routes nowhere yet must not start. Otherwise the runner's pushed graph
 * that serves the source of the problem's oldest finding, the newest push
 * when two do; null for a task that is not a problem, a problem with no
 * findings, or a source no version serves, and the run then takes the line
 * it was started with.
 */
export async function lineRouteFor(ctx: any, userId: Id<"users">, task: RouteTask | null | undefined): Promise<{ workflow: Doc<"workflows"> | null; waiting?: string }> {
  const route = await liveFlowRouteOf(ctx, task);
  if (route) return route.workflow ? { workflow: route.workflow } : { workflow: null, waiting: route.waiting };
  const source = await problemSourceOf(ctx, task);
  if (!source) return { workflow: null };
  const rows = await ctx.db.query("workflows").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const serving = rows.filter((w: any) => (w.serves ?? []).includes(source));
  return { workflow: serving.sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0] ?? null };
}

/** `cast workflow run --task` asks which version the problem runs, to run it from its file on this machine. */
export const lineVersionForCli = query({
  args: { api_token: v.string(), task: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };
    const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", args.task)).first();
    const { workflow: row, waiting } = await lineRouteFor(ctx, result.userId, task);
    if (waiting) return { version: null, waiting };
    return { version: row ? { slug: row.slug, name: row.name, origin: row.origin ? { device_id: row.origin.device_id, root: row.origin.root, file: row.origin.file } : null, ...(await libraryOfFlow(ctx, row._id)) } : null };
  },
});
