import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "../proc.js";
import { parseWorkflowFile, parseWorkflowSource, resolveFlowSource, type ResolveFlow } from "./parser.js";
import { resolveWorkflowSource } from "./templates.js";
import type { WorkflowGraph } from "./types.js";
import { repoLineForRun } from "../repoLine.js";
import { materializePushedFlow, repoFlowsDir } from "./flowPool.js";
import { codecastPath } from "../codecastDir.js";
import { flowCopyRepo } from "./flowCopy.js";

// The graph `cast workflow run-daemon` executes for a run (the-line.md L9).
//
// A run backed by a pushed workflows row arrives with its nodes and runs as
// they are. A run the sweep started under a slug the host never pushed (the
// shipped "line", the default for every role) arrives with no nodes and only
// `run.workflow_name`; that name is resolved the way `cast workflow run
// <name>` resolves it: a file under the run's project path, else a shipped
// template. Null when neither the row nor the name yields a graph.
//
// The graph attribute stack (the-line.md L4: one decision stack per run)
// comes from the row when it carries one, else from the stored DOT source,
// so a daemon run creates the same stack a local run does.
//
// A run the server queued against a graph pushed from a file on this machine
// (a trial's rerun or dispatch: `fresh_branch`) reads that file again, so
// station edits made since the last push take effect, as they would for
// `cast workflow run <file>`. So does a resume of any run pushed from a file
// here (`resume`): a run that waited at a gate continues on the stations as
// they are now, when the file still has the station it stands at.
export function graphForDaemonRun(...args: Parameters<typeof daemonRunGraph>): WorkflowGraph | null {
  return daemonRunGraph(...args).graph;
}

/** One library version a run executes (convex flowVersions.libraryOfRun): its graph, each station's text, and where they sit in a checkout. */
export type LibraryVersion = {
  workflow_id: string;
  version_id: string;
  /** The flow's slug, by which a variant may extend it (`extends="<slug>"`). */
  slug?: string | null;
  snapshot: { name: string; label?: string; goal?: string; source: string; nodes: Array<{ id: string; prompt?: string; script?: string }>; file: string; files: Array<{ node: string; prompt?: string; script?: string }> };
};

/**
 * A library run's versions as files (ct-70169): the flow and each base it
 * extends written at their checkout paths into one directory named by the
 * versions, the flow first and its bases after, so a base's current text is
 * what its stations read. Returns the flow's graph file.
 */
export function materializeLibraryRun(versions: LibraryVersion[], cacheRoot = codecastPath("flows")): string {
  return materializeLibraryFiles(versions, cacheRoot)[0];
}

/** Each version's graph file, in the order given. */
function materializeLibraryFiles(versions: LibraryVersion[], cacheRoot = codecastPath("flows")): string[] {
  // A run with its segments' versions can name more than fit a directory's name: those are named by a hash of them all,
  // so two runs that share the first few versions never write into one directory.
  const ids = versions.map((v) => v.version_id.replace(/[^\w-]/g, "")).join("-");
  const key = ids.length <= 198 ? `v-${ids}` : `v-h${createHash("sha256").update(ids).digest("hex").slice(0, 40)}`;
  return versions.map((v) => materializePushedFlow({ _id: key, slug: v.snapshot.name, name: v.snapshot.name, source: v.snapshot.source, nodes: v.snapshot.nodes, origin: { file: v.snapshot.file, files: v.snapshot.files } }, cacheRoot));
}

/** A library run's graph: a base or a segment the flow names by slug reads the version the run recorded, written beside
 *  the others, ahead of anything on this machine; one it recorded no version of resolves here (resolveFlowSource). */
export function parseLibraryRun(versions: LibraryVersion[], cacheRoot = codecastPath("flows")): WorkflowGraph {
  const files = materializeLibraryFiles(versions, cacheRoot);
  const bySlug = new Map(versions.slice(1).flatMap((v, i) => (v.slug ? [[v.slug, files[i + 1]] as const] : [])));
  const resolveFlow: ResolveFlow = (slug, dir, read) => {
    const file = bySlug.get(slug.replace(/\.cast$/, ""));
    const src = file ? read(file) : null;
    return file && src !== null ? { src, dir: path.dirname(file), file } : resolveFlowSource(slug, dir, read);
  };
  return parseWorkflowFile(files[0], { resolveFlow });
}

type DaemonRun = { workflow_name?: string | null; goal_override?: string | null; project_path?: string | null; task_short_id?: string | null; fresh_branch?: boolean | null; current_node_id?: string | null };
type DaemonRow = { name?: string; slug?: string; goal?: string; model_stylesheet?: string; nodes?: any[]; edges?: any[]; stack?: string; source?: string; origin?: { device_id: string; root: string; file: string } | null; library?: { versions: LibraryVersion[] } } | null | undefined;

/** The graph a daemon run executes, with the graph file on this machine it was read from: null when the stations came from anywhere else. */
export function daemonRunGraph(
  run: DaemonRun,
  wf: DaemonRow,
  cwd: string = run.project_path || process.cwd(),
  deviceId?: string,
  resume = false,
): { graph: WorkflowGraph | null; file: string | null } {
  // A run that recorded library versions runs them, on any machine, start or resume; no checkout's file is read.
  if (wf?.library?.versions?.length) {
    const graph = parseLibraryRun(wf.library.versions);
    if (run.goal_override) graph.goal = run.goal_override;
    if (wf.stack) graph.stack = wf.stack;
    if (wf.name) graph.name = wf.name;
    return { graph, file: null };
  }
  const origin = (run.fresh_branch || resume) && deviceId && wf?.origin?.device_id === deviceId && !foreignOrigin(wf, cwd, deviceId) ? path.join(wf.origin.root, wf.origin.file) : null;
  if (origin && fs.existsSync(origin)) {
    const graph = parseWorkflowFile(origin);
    if (run.goal_override) graph.goal = run.goal_override;
    if (run.fresh_branch || !run.current_node_id || graph.nodes.has(run.current_node_id)) return { graph, file: origin };
  }
  return { graph: graphElsewhere(run, wf, cwd, deviceId), file: null };
}

function graphElsewhere(run: DaemonRun, wf: DaemonRow, cwd: string, deviceId?: string): WorkflowGraph | null {
  // A task-bound run of a line in a checkout with its own line runs that,
  // ahead of the role's pushed line and the shipped one (line-map.md LX5).
  const repo = repoLineForRun(run, wf, cwd);
  if (repo) {
    const graph = parseWorkflowSource(repo.source, repo.dir);
    if (run.goal_override) graph.goal = run.goal_override;
    return graph;
  }
  // The row holds whichever checkout pushed its slug last (one row per user and slug), so a row pushed from a
  // checkout of another repo on this machine is that repo's flow: Union's `change` once answered codecast's runs.
  // Such a run resolves the name in its own checkout, its repo flow else the shipped one.
  if (foreignOrigin(wf, cwd, deviceId)) {
    const own = ownFlowByName(wf?.slug || run.workflow_name, cwd);
    if (own) {
      if (run.goal_override) own.goal = run.goal_override;
      return own;
    }
  }
  // The pushed source is the whole graph; the stored node copy keeps only the
  // attributes its table names (a stop exit's words, a segment's routing are
  // not among them). Read the source when it stands alone, or from the file
  // this machine pushed it from.
  const fromSource = sourceGraph(wf, cwd, deviceId);
  if (fromSource) {
    if (run.goal_override) fromSource.goal = run.goal_override;
    if (wf?.stack) fromSource.stack = wf.stack;
    if (wf?.name) fromSource.name = wf.name;
    return fromSource;
  }
  if (wf?.nodes?.length) {
    const nodes = new Map<string, any>();
    for (const n of wf.nodes) nodes.set(n.id, n);
    const stack = wf.stack ?? stackFromSource(wf.source);
    return {
      name: wf.name ?? "workflow",
      goal: run.goal_override || wf.goal,
      model_stylesheet: wf.model_stylesheet,
      ...(stack ? { stack } : {}),
      nodes,
      edges: wf.edges ?? [],
    };
  }
  if (!run.workflow_name) return null;
  const resolved = resolveWorkflowSource(run.workflow_name, cwd);
  if (!resolved) return null;
  const graph = parseWorkflowSource(resolved.source, resolved.dir);
  if (run.goal_override) graph.goal = run.goal_override;
  return graph;
}

/**
 * Publish the graph file a daemon run reads (daemonRunGraph's `file`), the
 * way `cast workflow run <file>` publishes before it starts, so the line's
 * published version is the stations its runs execute: a waiting decision is
 * then judged against the line as it runs now (line-versions.md LV1), and a
 * restarted runner leaves its decision current. A run that stands at a
 * station the file no longer has reads its stations elsewhere and publishes
 * nothing. The file's own goal goes out, never one run's. An unchanged graph
 * saves no version (workflows.recordGraphVersion).
 */
export async function publishDaemonGraph(file: string, wf: DaemonRow, deviceId: string, post: (route: string, body: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const graph = parseWorkflowFile(file);
  const { graphOrigin } = await import("../lineGraphEdit.js");
  const origin = graphOrigin(file, graph, deviceId);
  if (!origin) return;
  const { graphToPushPayload } = await import("./runner.js");
  const { nodes, edges, stack, serves } = graphToPushPayload(graph);
  await post("/cli/workflows/upsert", {
    name: wf?.name ?? graph.name,
    label: graph.label ?? "",
    slug: wf?.slug ?? graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    goal: graph.goal,
    source: fs.readFileSync(file, "utf-8"),
    nodes, edges, stack,
    ...(serves ? { serves } : {}),
    model_stylesheet: graph.model_stylesheet,
    origin,
  });
}

/** The graph from a row's DOT source: the file it was pushed from when it is on this machine, else the source itself when it names no file. */
function sourceGraph(wf: DaemonRow, cwd: string, deviceId?: string): WorkflowGraph | null {
  if (!wf?.source) return null;
  try {
    const file = deviceId && wf.origin?.device_id === deviceId ? path.join(wf.origin.root, wf.origin.file) : null;
    if (file && fs.existsSync(file)) return parseWorkflowFile(file);
    if (/"@[\w./-]|\bextends\s*=/.test(wf.source)) return null;
    return parseWorkflowSource(wf.source, cwd);
  } catch {
    return null;
  }
}

/** Whether the row's graph was pushed from a checkout on this machine of another repo than the run's. Unknown (either side not a git checkout here) is not foreign. */
function foreignOrigin(wf: DaemonRow, cwd: string, deviceId?: string): boolean {
  if (!deviceId || !wf?.origin || wf.origin.device_id !== deviceId) return false;
  const theirs = repoOf(wf.origin.root);
  const ours = repoOf(cwd);
  return !!theirs && !!ours && theirs !== ours;
}

/** A checkout's repo, as its shared git directory: every worktree of one repo names the same one. A repo flow's
 *  default-branch copy (flowCopy.ts) is of the repo it was read from. */
function repoOf(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const copied = flowCopyRepo(dir);
  if (copied) return copied;
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const common = r.status === 0 ? r.stdout.trim() : "";
  return common ? fs.realpathSync(common) : null;
}

/** A flow by name as a checkout resolves it: its `.codecast/flows/<name>.cast`, else the shipped template. */
function ownFlowByName(name: string | null | undefined, cwd: string): WorkflowGraph | null {
  if (!name) return null;
  const dir = repoFlowsDir(cwd);
  const file = dir ? path.join(dir, `${name}.cast`) : null;
  if (file && fs.existsSync(file)) return parseWorkflowFile(file);
  const shipped = resolveWorkflowSource(name, cwd);
  return shipped ? parseWorkflowSource(shipped.source, shipped.dir) : null;
}

function stackFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  try {
    return parseWorkflowSource(source).stack;
  } catch {
    return undefined;
  }
}
