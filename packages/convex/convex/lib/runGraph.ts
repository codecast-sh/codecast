// The graph a run executes (ct-98653). A workflows row is one per (user, slug),
// and every checkout and team that pushes the slug rewrites it, so the row is
// whatever was pushed last, from anywhere. A run pins the version it started on
// (workflow_runs.graph_version_id; a library run's flow_versions), and every
// reader of a run's stations reads that version, never the row. A run from
// before pins, or one whose version kept no content, reads the row as before.
import type { Doc, Id } from "../_generated/dataModel";

type Ctx = { db: any };
type PinnedRun = Pick<Doc<"workflow_runs">, "graph_version_id" | "flow_versions">;
export type VersionGraph = NonNullable<Doc<"workflow_versions">["snapshot"]>;
/** A version and its graph. */
export type Pinned = { ver: Doc<"workflow_versions">; graph: VersionGraph };

/**
 * What one call has read already: versions by id, graphs by the row that keeps
 * them, and each line's newest version. A queue of decisions asked by runs on
 * different versions of a few lines reads each of them once.
 */
export type GraphMemo = {
  versions: Map<string, Promise<Doc<"workflow_versions"> | null>>;
  graphs: Map<string, Promise<VersionGraph | null>>;
  lines: Map<string, Promise<Doc<"workflow_versions"> | null>>;
};
export const newGraphMemo = (): GraphMemo => ({ versions: new Map(), graphs: new Map(), lines: new Map() });

function once<T>(map: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  if (!map.has(key)) map.set(key, read());
  return map.get(key)!;
}

/**
 * A version's line (workflow_versions.line): the versions a run pinned to it
 * resumes with, so only a later one of them supersedes it (line-versions.md
 * LV1). A run pinned to a push from a file resumes from that checkout's file,
 * so its line is the place; a library run resumes with the library's current
 * version. A push from no file (a CLI built-in, a web or session save) has no
 * line: its run resumes with its own pinned graph, which nothing replaces.
 */
export const LIBRARY_LINE = "library";
export const placeLine = (p: { device_id: string; root: string }) => `place:${p.device_id}:${p.root}`;

/** Whether a version keeps its graph, without reading it. */
export const holdsGraph = (ver: Pick<Doc<"workflow_versions">, "snapshot" | "graph_id"> | null | undefined) => !!(ver?.snapshot || ver?.graph_id);

/** One version by id, once per memo. */
export function versionById(ctx: Ctx, id: Id<"workflow_versions"> | undefined | null, memo: GraphMemo = newGraphMemo()): Promise<Doc<"workflow_versions"> | null> {
  return id ? once(memo.versions, String(id), () => ctx.db.get(id)) : Promise.resolve(null);
}

/** A version's graph: a library version holds its own; any other keeps it apart, shared by the versions that pushed it. */
export async function graphOfVersion(ctx: Ctx, ver: Doc<"workflow_versions"> | null, memo: GraphMemo = newGraphMemo()): Promise<VersionGraph | null> {
  if (!ver) return null;
  if (ver.snapshot) return ver.snapshot;
  if (!ver.graph_id) return null;
  return once(memo.graphs, String(ver.graph_id), async () => ((await ctx.db.get(ver.graph_id)) as Doc<"workflow_version_graphs"> | null)?.snapshot ?? null);
}

/** The id of the version a run executes: a library run's flow version, else its pin. */
export const pinIdOf = (run: PinnedRun) => run.flow_versions?.[0]?.version_id ?? run.graph_version_id;

/** The version a run pinned, when it keeps a graph; its graph is not read. */
export async function pinnedRowOf(ctx: Ctx, run: PinnedRun, memo: GraphMemo = newGraphMemo()): Promise<Doc<"workflow_versions"> | null> {
  const ver = await versionById(ctx, pinIdOf(run), memo);
  return holdsGraph(ver) ? ver : null;
}

/** The version a run executes, with its graph. */
export async function pinnedVersionOf(ctx: Ctx, run: PinnedRun, memo: GraphMemo = newGraphMemo()): Promise<Pinned | null> {
  const ver = await pinnedRowOf(ctx, run, memo);
  const graph = await graphOfVersion(ctx, ver, memo);
  return ver && graph ? { ver, graph } : null;
}

/** The row with a version's graph laid over it: where that version was pushed from, never where the row was last pushed from. */
export function rowAtVersion(row: Doc<"workflows">, { ver, graph: s }: Pinned): Doc<"workflows"> {
  return {
    ...row,
    name: s.name,
    label: s.label,
    goal: s.goal,
    source: s.source,
    nodes: s.nodes,
    edges: s.edges,
    model_stylesheet: s.model_stylesheet,
    origin: ver.pushed_from ? { ...ver.pushed_from, file: s.file, files: s.files, graph_hash: ver.graph_hash, nodes: ver.nodes } : undefined,
  };
}

/** The run's workflows row as the run executes it. `row` when the caller already read it. */
export async function runWorkflowOf(ctx: Ctx, run: PinnedRun & Pick<Doc<"workflow_runs">, "workflow_id">, row?: Doc<"workflows"> | null, memo: GraphMemo = newGraphMemo()): Promise<Doc<"workflows"> | null> {
  const wf: Doc<"workflows"> | null = row !== undefined ? row : run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
  if (!wf) return null;
  const pinned = await pinnedVersionOf(ctx, run, memo);
  return pinned ? rowAtVersion(wf, pinned) : wf;
}

/**
 * The version a run starting now pins: the one its push named, when it is a
 * version of the run's own row (`cast workflow run` pushes, then creates, and
 * another checkout's push may land between), else the row's newest.
 */
export async function versionToPin(ctx: Ctx, workflowId: Id<"workflows"> | undefined, named?: string | null): Promise<Doc<"workflow_versions"> | null> {
  if (!workflowId) return null;
  const id = named ? ctx.db.normalizeId("workflow_versions", named) : null;
  const ver: Doc<"workflow_versions"> | null = id ? await ctx.db.get(id) : null;
  if (ver && String(ver.workflow_id) === String(workflowId)) return ver;
  return await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).order("desc").first();
}

/** A line's newest version, read through the line's index, once per memo. */
export function newestOfLine(ctx: Ctx, workflowId: Id<"workflows">, line: string, memo: GraphMemo = newGraphMemo()): Promise<Doc<"workflow_versions"> | null> {
  return once(memo.lines, `${workflowId}|${line}`, () => ctx.db.query("workflow_versions").withIndex("by_workflow_line", (q: any) => q.eq("workflow_id", workflowId).eq("line", line)).order("desc").first());
}

/**
 * The newest version of a pinned version's own line, when it was published
 * after the pin: what a checkout's own later push, or a library save, says the
 * line is now. Null while the pin is its line's newest (line-versions.md LV1).
 */
export async function ownLineAfter(ctx: Ctx, pinned: Doc<"workflow_versions">, memo: GraphMemo = newGraphMemo()): Promise<Doc<"workflow_versions"> | null> {
  if (!pinned.line) return null;
  const newest = await newestOfLine(ctx, pinned.workflow_id, pinned.line, memo);
  return newest && newest._id !== pinned._id && newest.at > pinned.at ? newest : null;
}

/**
 * The number the row's history gives a version inserted now: one past the
 * newest version's, counted once for a row whose versions are from before
 * numbers.
 */
export async function nextSeq(ctx: Ctx, workflowId: Id<"workflows">): Promise<number> {
  const newest: Doc<"workflow_versions"> | null = await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).order("desc").first();
  if (!newest) return 1;
  if (newest.seq) return newest.seq + 1;
  return (await ctx.db.query("workflow_versions").withIndex("by_workflow_at", (q: any) => q.eq("workflow_id", workflowId)).take(VERSION_COUNT_CAP)).length + 1;
}

/** How far a count of a row's versions from before numbers reads. */
export const VERSION_COUNT_CAP = 1000;

/**
 * A runner reported loading a graph other than its run's pin (a resume that
 * read its file again and published it): the pin moves to that graph's
 * version on the pin's own line, so its origin stays the run's own checkout.
 */
export async function repinToReported(ctx: Ctx, run: Pick<Doc<"workflow_runs">, "graph_version_id" | "workflow_id">, hash: string): Promise<{ graph_version_id?: Id<"workflow_versions"> }> {
  if (!run.graph_version_id || !run.workflow_id) return {};
  const pinned: Doc<"workflow_versions"> | null = await ctx.db.get(run.graph_version_id);
  if (!pinned?.line || pinned.graph_hash === hash) return {};
  const recent: Doc<"workflow_versions">[] = await ctx.db.query("workflow_versions").withIndex("by_workflow_line", (q: any) => q.eq("workflow_id", run.workflow_id).eq("line", pinned.line)).order("desc").take(20);
  const hit = recent.find((v) => v.graph_hash === hash && holdsGraph(v));
  return hit ? { graph_version_id: hit._id } : {};
}
