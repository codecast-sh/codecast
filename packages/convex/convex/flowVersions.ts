// Flows live in the library (ct-70169): a flow whose runs read the library
// (`workflows.runs_from = "library"`) runs its current version on every
// machine, whatever any checkout's file says, and each run records the
// versions it executes. The row is the current version; every change to it
// is a version with its content (workflow_versions.snapshot), so a run
// reads exactly what it started on and a bad edit is undone in one step.
//
//   - A library flow changes only on a save: `cast flow save` / `cast flow
//     publish`, `cast workflow push` (the Flows page's step edit), the web's
//     edit, a session's Save, a restore. A run's own push of its file
//     (`cast workflow run <file>`, the daemon's publish-on-read) leaves it
//     (workflows.upsertWorkflowFor).
//   - A variant's base (`extends`) is the base flow's current version at the
//     run's start, so an edit to the spine reaches its variants.
//   - `runs_from = "repo"` pins a flow to its checkout's file; unset is the
//     resolution from before the library, byte for byte (cli daemonGraph.ts).
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { workspaceGrantsAccess } from "./lib/access";
import { recordGraphVersion } from "./workflows";
import { extendsFile, isExtendsPath } from "./lib/flowRoute";

type Snapshot = NonNullable<Doc<"workflow_versions">["snapshot"]>;

/** A version past this is refused, under Convex's 1 MiB document cap. */
export const SNAPSHOT_MAX_BYTES = 900_000;

/** The row as one version's content. */
export function snapshotOfRow(row: Doc<"workflows">): Snapshot {
  return {
    name: row.name,
    ...(row.label ? { label: row.label } : {}),
    ...(row.goal ? { goal: row.goal } : {}),
    source: row.source ?? "",
    nodes: row.nodes,
    edges: row.edges,
    file: row.origin?.file || `${row.slug}.cast`,
    files: row.origin?.files ?? [],
  };
}

/** A content hash for a version no parser hashed (the web's edit): FNV-1a over its content, 16 hex digits. */
export function contentHash(s: Snapshot): string {
  const text = JSON.stringify([s.source, s.nodes, s.edges, s.files]);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return "w" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(7, "0").slice(0, 7);
}

/**
 * A version of the row as it now stands, when its graph moved: with its
 * content for a library flow (a run reads it), the hashes only otherwise,
 * as before the library. `origin` is what a push from a file says; a write
 * with none (the web's) is hashed by content.
 */
export async function recordWorkflowVersion(ctx: any, workflowId: Id<"workflows">, userId: Id<"users">, origin: { graph_hash: string; nodes: Array<{ id: string; h: string }> } | undefined, now = Date.now()) {
  const row: Doc<"workflows"> | null = await ctx.db.get(workflowId);
  if (!row) return null;
  if (row.runs_from !== "library") return origin ? await recordGraphVersion(ctx, workflowId, userId, origin, now) : null;
  const snapshot = snapshotOfRow(row);
  if (JSON.stringify(snapshot).length > SNAPSHOT_MAX_BYTES) throw new ConvexError(`${row.slug} is too big to keep as a library version (over ${SNAPSHOT_MAX_BYTES} bytes)`);
  return await recordGraphVersion(ctx, workflowId, userId, origin ?? { graph_hash: contentHash(snapshot), nodes: [] }, now, snapshot);
}

/** The newest version that holds its content: the one a run starting now reads. */
async function currentVersion(ctx: any, workflowId: Id<"workflows">): Promise<Doc<"workflow_versions"> | null> {
  for await (const ver of ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).order("desc")) {
    if (ver.snapshot) return ver;
  }
  return null;
}

/** The base flow a library flow extends: the owner's flow whose file the `extends` path names, from the same checkout when two match. */
async function baseOf(ctx: any, row: Doc<"workflows">): Promise<Doc<"workflows"> | null> {
  const ext = flowGraphAttr(row.source, "extends");
  if (!ext) return null;
  // A library flow by slug: the owner's, else the one in the flow's workspace.
  if (!isExtendsPath(ext)) {
    const own = await ctx.db.query("workflows").withIndex("by_user_slug", (q: any) => q.eq("user_id", row.user_id).eq("slug", ext)).first();
    if (own && own._id !== row._id) return own;
    const pool: Doc<"workflows">[] = row.workspace ? await ctx.db.query("workflows").withIndex("by_workspace", (q: any) => q.eq("workspace", row.workspace)).collect() : [];
    return pool.find((w) => w.slug === ext && w._id !== row._id) ?? null;
  }
  const file = extendsFile(row);
  if (!file) return null;
  const rows: Doc<"workflows">[] = await ctx.db.query("workflows").withIndex("by_user_id", (q: any) => q.eq("user_id", row.user_id)).collect();
  const hits = rows.filter((w) => w._id !== row._id && w.origin?.file === file);
  return hits.find((w) => w.origin?.root === row.origin?.root) ?? hits.sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
}

/**
 * The library versions a run on this flow executes, the flow first and then
 * each base it extends: the run records them at its start
 * (workflow_runs.flow_versions). Nothing for a flow that does not run from
 * the library, or has no version with content yet: that run resolves its
 * graph as before.
 */
export async function runFlowVersions(ctx: any, workflowId: Id<"workflows"> | undefined): Promise<{ flow_versions?: Array<{ workflow_id: Id<"workflows">; version_id: Id<"workflow_versions"> }> }> {
  const row: Doc<"workflows"> | null = workflowId ? await ctx.db.get(workflowId) : null;
  if (row?.runs_from !== "library") return {};
  const out: Array<{ workflow_id: Id<"workflows">; version_id: Id<"workflow_versions"> }> = [];
  for (let at: Doc<"workflows"> | null = row; at && out.length < 8; at = await baseOf(ctx, at)) {
    if (out.some((x) => x.workflow_id === at!._id)) break;
    const ver = await currentVersion(ctx, at._id);
    if (!ver) return at === row ? {} : { flow_versions: out };
    out.push({ workflow_id: at._id, version_id: ver._id });
  }
  return { flow_versions: out };
}

type FlowVersions = Array<{ workflow_id: Id<"workflows">; version_id: Id<"workflow_versions"> }>;

/** Every station a run on these versions can stand at. A version lists only some of its nodes, and a variant's holds
 *  only what it changes, so the ids also come from each version's own graph source, the flow's and its bases'. */
async function stationsOf(ctx: any, flowVersions: FlowVersions): Promise<Set<string>> {
  const stations = new Set<string>();
  for (const fv of flowVersions) {
    const ver: Doc<"workflow_versions"> | null = await ctx.db.get(fv.version_id);
    for (const n of ver?.nodes ?? []) stations.add(n.id);
    for (const n of ver?.snapshot?.nodes ?? []) stations.add(n.id);
    for (const m of (ver?.snapshot?.source ?? "").matchAll(/^\s*([A-Za-z_]\w*)\s*\[/gm)) stations.add(m[1]!);
  }
  return stations;
}

/**
 * One run onto its flow's current library versions before it resumes at `at` (`cast workflow resume --current-flow`):
 * a fix saved since the run started reaches it. Refused for a flow outside the library, or one whose current graph
 * has no `at`. `check` refuses the same way and moves nothing.
 */
export async function repinRunForResume(ctx: any, run: Doc<"workflow_runs">, at: string, opts: { check?: boolean } = {}): Promise<void> {
  const { flow_versions } = await runFlowVersions(ctx, run.workflow_id);
  if (!flow_versions?.length) throw new ConvexError("The run's flow does not run from the library, so it has no current version to move onto");
  if (!(await stationsOf(ctx, flow_versions)).has(at)) throw new ConvexError(`The flow's current version has no station ${at}`);
  if (!opts.check) await ctx.db.patch(run._id, { flow_versions });
}

/**
 * Moves a library flow's live runs onto its current versions (run with
 * packages/convex/run.sh). A run reads the versions it started on, resume
 * included, so a fix saved to a station a waiting run has not reached yet
 * never reaches it: Union's Ship answers on runs started on agentwatch v17
 * failed at an Eval line v18 had fixed (ct-61712, 2026-10-27). A run whose
 * current station the current graph lacks keeps its versions. `dry` reports.
 */
export const repinLiveRuns = internalMutation({
  args: { workflow_id: v.id("workflows"), started_before: v.optional(v.number()), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const flow: Doc<"workflows"> | null = await ctx.db.get(args.workflow_id);
    const { flow_versions } = await runFlowVersions(ctx, args.workflow_id);
    if (!flow?.workspace || !flow_versions?.length) throw new ConvexError("That flow does not run from the library");
    const stations = await stationsOf(ctx, flow_versions);
    const key = (fv: ReadonlyArray<{ version_id: Id<"workflow_versions"> }> | undefined) => (fv ?? []).map((x) => String(x.version_id)).join(",");
    const moved: string[] = [];
    const kept: Array<{ run: string; why: string }> = [];
    for (const status of ["pending", "running", "paused"] as const) {
      const runs: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_workspace_status_updated", (q: any) => q.eq("workspace", flow.workspace).eq("status", status)).collect();
      for (const run of runs) {
        if (String(run.workflow_id) !== String(args.workflow_id) || !run.flow_versions?.length) continue;
        if (args.started_before && run.created_at >= args.started_before) continue;
        if (key(run.flow_versions) === key(flow_versions)) continue;
        if (run.current_node_id && !stations.has(run.current_node_id)) { kept.push({ run: String(run._id), why: `the current graph has no ${run.current_node_id}` }); continue; }
        if (!args.dry) await ctx.db.patch(run._id, { flow_versions });
        const task: Doc<"tasks"> | null = run.task_id ? await ctx.db.get(run.task_id) : null;
        moved.push(`${task?.short_id ?? String(run._id)}@${run.current_node_id ?? "start"}`);
      }
    }
    return { versions: flow_versions.map((x) => String(x.version_id)), moved, kept };
  },
});

/** What a runner materializes for a run that recorded library versions (getForDaemon's `library`), in the order it writes them: the flow, then its bases. */
export async function libraryOfRun(ctx: any, run: Pick<Doc<"workflow_runs">, "flow_versions">): Promise<{ library?: { versions: Array<{ workflow_id: string; version_id: string; slug: string | null; snapshot: Snapshot }> } }> {
  if (!run.flow_versions?.length) return {};
  const versions = [];
  for (const fv of run.flow_versions) {
    const ver: Doc<"workflow_versions"> | null = await ctx.db.get(fv.version_id);
    if (!ver?.snapshot) return {};
    const row: Doc<"workflows"> | null = await ctx.db.get(fv.workflow_id);
    versions.push({ workflow_id: String(fv.workflow_id), version_id: String(fv.version_id), slug: row?.slug ?? null, snapshot: ver.snapshot });
  }
  return { library: { versions } };
}

/** The library as a line version's run will read it (`cast workflow run --task`, repoLine.lineVersionFile), versions picked now. */
export async function libraryOfFlow(ctx: any, workflowId: Id<"workflows">) {
  const { flow_versions } = await runFlowVersions(ctx, workflowId);
  return flow_versions ? await libraryOfRun(ctx, { flow_versions }) : {};
}

// ── versions, restore and pin, for the CLI and the web ──────────────────────

async function flowFor(ctx: any, userId: Id<"users">, ref: string): Promise<Doc<"workflows">> {
  const byId = /^[a-z0-9]{32}$/.test(ref) ? await ctx.db.get(ref as Id<"workflows">).catch(() => null) : null;
  const row: Doc<"workflows"> | null = byId ?? await ctx.db.query("workflows").withIndex("by_user_slug", (q: any) => q.eq("user_id", userId).eq("slug", ref)).first();
  if (!row || (String(row.user_id) !== String(userId) && !(await workspaceGrantsAccess(ctx, userId, row.workspace)))) throw new ConvexError(`No flow ${ref}`);
  return row;
}

async function versionsOf(ctx: any, row: Doc<"workflows">) {
  const vs: Doc<"workflow_versions">[] = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", row._id)).order("asc").take(500);
  const names = new Map<string, string | null>();
  for (const ver of vs) if (!names.has(String(ver.by))) names.set(String(ver.by), ((await ctx.db.get(ver.by)) as any)?.name ?? null);
  const current = row.runs_from === "library" ? [...vs].reverse().find((x) => x.snapshot)?._id : undefined;
  return vs.map((ver, i) => ({
    n: i + 1, id: ver._id, at: ver.at, by: names.get(String(ver.by)) ?? null, graph_hash: ver.graph_hash, changed: ver.changed,
    restorable: !!ver.snapshot, current: ver._id === current,
  })).reverse();
}

/** A flow's versions, newest first, and where its runs read it. */
async function versionsCore(ctx: any, userId: Id<"users">, ref: string) {
  const row = await flowFor(ctx, userId, ref);
  return { slug: row.slug, runs_from: row.runs_from ?? null, versions: await versionsOf(ctx, row) };
}

/** That version's content written back as the flow's current one: a new version, so history stays linear. */
async function restoreCore(ctx: any, userId: Id<"users">, ref: string, version: string, now = Date.now()) {
  const row = await flowFor(ctx, userId, ref);
  const list = await versionsOf(ctx, row);
  const want = list.find((x) => String(x.id) === version || `v${x.n}` === version || String(x.n) === version);
  if (!want) throw new ConvexError(`${row.slug} has no version ${version}`);
  const ver: Doc<"workflow_versions"> | null = await ctx.db.get(want.id);
  if (!ver?.snapshot) throw new ConvexError(`v${want.n} of ${row.slug} was kept before versions held their content, so it cannot be restored`);
  const s = ver.snapshot;
  await ctx.db.patch(row._id, {
    name: s.name, label: s.label, goal: s.goal, source: s.source, nodes: s.nodes, edges: s.edges,
    ...(row.origin ? { origin: { ...row.origin, file: s.file, files: s.files, graph_hash: ver.graph_hash, nodes: ver.nodes } } : {}),
    updated_at: now,
  });
  // The same graph as that version: a new row in the history, so the restore is itself a version.
  const id = await ctx.db.insert("workflow_versions", { workflow_id: row._id, graph_hash: ver.graph_hash, nodes: ver.nodes, changed: [], by: userId, at: now, snapshot: s });
  return { slug: row.slug, restored: want.n, version: list.length + 1, version_id: id };
}

/** Where a flow's runs read its graph: the library's current version, or the checkout's file. A switch to the library keeps the flow as it stands as its first version with content. */
async function pinCore(ctx: any, userId: Id<"users">, ref: string, to: "library" | "repo", now = Date.now()) {
  const row = await flowFor(ctx, userId, ref);
  await ctx.db.patch(row._id, { runs_from: to, updated_at: now });
  if (to === "library" && !(await currentVersion(ctx, row._id))) await recordWorkflowVersion(ctx, row._id, userId, row.origin ? { graph_hash: row.origin.graph_hash, nodes: row.origin.nodes } : undefined, now);
  return { slug: row.slug, runs_from: to };
}

const cliAuth = async (ctx: any, token: string) => {
  const auth = await verifyApiToken(ctx, token);
  if (!auth) throw new ConvexError("Unauthorized");
  return auth.userId as Id<"users">;
};
const webAuth = async (ctx: any) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
};

/** `cast flow versions|restore|pin` (cli flowVersionsCommand.ts), one route for the three. */
export const fromCli = mutation({
  args: { api_token: v.string(), op: v.union(v.literal("versions"), v.literal("restore"), v.literal("pin")), flow: v.string(), version: v.optional(v.string()), to: v.optional(v.union(v.literal("library"), v.literal("repo"))) },
  handler: async (ctx, args) => {
    const userId = await cliAuth(ctx, args.api_token);
    if (args.op === "versions") return await versionsCore(ctx, userId, args.flow);
    if (args.op === "restore") return await restoreCore(ctx, userId, args.flow, args.version ?? "");
    if (!args.to) throw new ConvexError("Say where the flow's runs read it: library or repo");
    return await pinCore(ctx, userId, args.flow, args.to);
  },
});
export const webVersions = query({
  args: { flow: v.string() },
  handler: async (ctx, args) => versionsCore(ctx, await webAuth(ctx), args.flow),
});
export const webRestore = mutation({
  args: { flow: v.string(), version: v.string() },
  handler: async (ctx, args) => restoreCore(ctx, await webAuth(ctx), args.flow, args.version),
});
export const webPin = mutation({
  args: { flow: v.string(), to: v.union(v.literal("library"), v.literal("repo")) },
  handler: async (ctx, args) => pinCore(ctx, await webAuth(ctx), args.flow, args.to),
});
