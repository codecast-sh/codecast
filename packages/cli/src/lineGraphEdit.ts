// Editing a published graph's step in the repo that holds it
// (docs/architecture/line-workspace.md LW4, "Edit a prompt"). The line's own
// edit path (lineProfileEdit.ts set_station, repoLine.ts) writes a project's
// `.codecast/line/`; this is the same edit for any graph a machine published
// from a file: Union's AgentWatch line is `outreach/line/agentwatch.cast`, its
// stations' prompts `outreach/line/agentwatch/<node>.md` beside it.
//
// Three pieces:
//   - graphOrigin: what a push records about where the graph lives (the
//     machine, the checkout, the .cast file and each station's file, the hash),
//     so the app knows which machine to ask and which file a step reads;
//   - planGraphEdit: one step's prompt or script changed, checked by the
//     parser before anything is written (pure over a reader, so tests and the
//     daemon judge the same plan);
//   - runLineGraphEdit: the daemon's `line_graph_edit`: fence, plan, atomic
//     write, republish. Every save that changes the graph is a new graph_hash,
//     and the republish records it as a version of the graph.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { graphHash, graphNodeHashes, parseWorkflowSource, validateWorkflow } from "./workflow/parser.js";
import type { WorkflowGraph } from "./workflow/types.js";
import { findNodeStmt, nodeAttrRaw, setNodeAttr } from "./repoLine.js";

export class LineGraphError extends Error {}

export type GraphField = "prompt" | "script";

/** Where a pushed graph lives, as the workflows row records it. Paths are repo-relative, posix. */
export interface GraphOrigin {
  device_id: string;
  /** The checkout's root on that machine (absolute). */
  root: string;
  /** The .cast file, relative to root. */
  file: string;
  /** Each station that reads its prompt or script from a file: that file, relative to root. */
  files: Array<{ node: string; prompt?: string; script?: string }>;
  graph_hash: string;
  nodes: Array<{ id: string; h: string }>;
}

/** The `"@<file>"` a raw DOT value names, or null for an inline value. */
const refOf = (raw: string | null): string | null => {
  const m = raw ? /^"@([^"]+)"$/.exec(raw) : null;
  return m ? m[1] : null;
};

/** A DOT string the parser reads back as `text` exactly (parser.ts tokenize). */
export function dotQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** The checkout holding `file`, or null outside a git repository. */
export function gitRootOf(file: string): string | null {
  const r = spawnSync("git", ["-C", path.dirname(path.resolve(file)), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const root = r.status === 0 ? r.stdout.trim() : "";
  return root ? fs.realpathSync(root) : null;
}

const posixRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join("/");
const inside = (root: string, abs: string) => {
  const rel = path.relative(root, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * Parse a graph whose `@<file>` refs are read through `read` (absolute path
 * in, text or null out), the way parseWorkflowSource reads them from disk: a
 * ref that does not resolve stays as written.
 */
export function parseGraphWith(source: string, dir: string, read: (abs: string) => string | null): WorkflowGraph {
  let graph: WorkflowGraph;
  try {
    graph = parseWorkflowSource(source);
  } catch (err) {
    throw new LineGraphError(`the graph does not parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const node of graph.nodes.values()) {
    for (const field of ["prompt", "script"] as const) {
      const v = node[field];
      if (!v?.startsWith("@")) continue;
      const text = read(path.join(dir, v.slice(1)));
      if (text !== null) node[field] = text;
    }
  }
  return graph;
}

const readDisk = (abs: string) => (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null);

/**
 * What a push of the graph in `castFile` records about where it lives, or
 * null when the file is not in a git checkout (nothing could edit it later).
 * `graph` is the graph as the push parsed it, so the hash is the one its runs record.
 */
export function graphOrigin(castFile: string, graph: WorkflowGraph, deviceId: string): GraphOrigin | null {
  const abs = fs.realpathSync(path.resolve(castFile));
  const root = gitRootOf(abs);
  if (!root || !deviceId) return null;
  const dir = path.dirname(abs);
  const files: GraphOrigin["files"] = [];
  for (const n of parseWorkflowSource(fs.readFileSync(abs, "utf8")).nodes.values()) {
    const entry: GraphOrigin["files"][number] = { node: n.id };
    for (const field of ["prompt", "script"] as const) {
      const v = n[field];
      if (!v?.startsWith("@")) continue;
      const target = path.join(dir, v.slice(1));
      if (inside(root, target)) entry[field] = posixRel(root, target);
    }
    if (entry.prompt || entry.script) files.push(entry);
  }
  return { device_id: deviceId, root, file: posixRel(root, abs), files, graph_hash: graphHash(graph), nodes: graphNodeHashes(graph) };
}

export interface LineGraphEditArgs {
  /** The checkout's root, as the graph's origin names it. */
  root: string;
  /** The .cast file, relative to root. */
  file: string;
  node: string;
  field?: GraphField;
  text: string;
  /** The step's hash the editor read (graph_nodes h): a save over a step that moved since is refused. */
  base_hash?: string | null;
}

export interface GraphEditPlan {
  writes: Array<{ file: string; content: string }>;
  changed: boolean;
  /** The file the step's text lives in (absolute): its own file, or the .cast for an inline value. */
  target: string;
  graph_hash: string;
  node_hash: string;
  /** The step's hash before the edit. */
  was_hash: string;
}

/**
 * The writes that set one step's prompt or script in the graph at `castAbs`.
 * A step that reads its text from a file gets that file rewritten; one written
 * inline gets its attribute rewritten in the .cast. Both graphs (before and
 * after) are parsed and the after one validated before anything is planned,
 * and a `base_hash` that is not the step's hash now refuses the edit.
 */
export function planGraphEdit(castAbs: string, args: Pick<LineGraphEditArgs, "node" | "field" | "text" | "base_hash">, opts: { root: string; read?: (abs: string) => string | null }): GraphEditPlan {
  const read = opts.read ?? readDisk;
  const field: GraphField = args.field ?? "prompt";
  if (field !== "prompt" && field !== "script") throw new LineGraphError(`a step's ${String(field)} cannot be edited here`);
  if (typeof args.text !== "string") throw new LineGraphError("an edit needs the step's new text");
  if (!args.text.trim()) throw new LineGraphError(`a step's ${field} cannot be empty`);
  const node = typeof args.node === "string" ? args.node.trim() : "";
  if (!/^[A-Za-z_][\w]*$/.test(node)) throw new LineGraphError("an edit names one step by its id");
  const source = read(castAbs);
  if (source === null) throw new LineGraphError(`${castAbs} could not be read`);
  if (!findNodeStmt(source, node)) throw new LineGraphError(`the graph has no step "${node}"`);
  const dir = path.dirname(castAbs);

  const before = parseGraphWith(source, dir, read);
  const was = graphNodeHashes(before).find((n) => n.id === node)?.h ?? "";
  if (args.base_hash && args.base_hash !== was) {
    throw new LineGraphError(`${node} changed since it was read (now ${was}); reload it and edit again`);
  }
  const current = before.nodes.get(node)?.[field];
  if (field === "script" && before.nodes.get(node)?.type !== "command") throw new LineGraphError(`${node} runs no script`);

  const ref = refOf(nodeAttrRaw(source, node, field));
  const overrides = new Map<string, string>();
  let nextSource = source;
  let target = castAbs;
  if (ref) {
    target = path.resolve(dir, ref);
    if (!inside(opts.root, target)) throw new LineGraphError(`${node} reads its ${field} from ${ref}, outside the checkout`);
    overrides.set(target, args.text);
  } else {
    nextSource = setNodeAttr(source, node, field, dotQuote(args.text));
    overrides.set(castAbs, nextSource);
  }
  const after = parseGraphWith(nextSource, dir, (abs) => (overrides.has(abs) ? overrides.get(abs)! : read(abs)));
  const errors = validateWorkflow(after);
  if (errors.length) throw new LineGraphError(`the graph would not run: ${errors.join("; ")}`);
  const graph_hash = graphHash(after);
  const node_hash = graphNodeHashes(after).find((n) => n.id === node)?.h ?? "";
  const changed = current !== args.text;
  return {
    writes: changed ? [...overrides].map(([file, content]) => ({ file, content })) : [],
    changed, target, graph_hash, node_hash, was_hash: was,
  };
}

export interface LineGraphEditReply {
  file: string;
  target: string;
  node: string;
  changed: boolean;
  graph_hash: string;
  node_hash: string;
  was_hash: string;
  published: { ok: boolean | "pending"; detail?: string } | null;
}

/**
 * The daemon's `line_graph_edit`: the .cast and the file it is about to write
 * must both pass the fence (`admit`, async: a miss refreshes the tracked
 * roots), the plan is judged before any write, the write is atomic, and a
 * changed graph is republished so the app's copy and its versions follow.
 */
export async function runLineGraphEdit(
  args: LineGraphEditArgs,
  deps: {
    admit: (file: string) => Promise<string | null>;
    write: (file: string, content: string) => void;
    publish?: (root: string, castAbs: string) => LineGraphEditReply["published"] | Promise<LineGraphEditReply["published"]>;
  },
): Promise<LineGraphEditReply> {
  if (!args || typeof args.root !== "string" || !args.root.trim()) throw new LineGraphError("line_graph_edit needs the checkout's root");
  if (typeof args.file !== "string" || !args.file.endsWith(".cast")) throw new LineGraphError("line_graph_edit names a .cast file");
  const root = path.resolve(args.root);
  const castAbs = await deps.admit(path.join(root, args.file));
  if (!castAbs) throw new LineGraphError(`${path.join(root, args.file)} is not a graph in a project this machine tracks`);
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const plan = planGraphEdit(castAbs, args, { root: realRoot });
  const writes: Array<{ file: string; content: string }> = [];
  for (const w of plan.writes) {
    const admitted = await deps.admit(w.file);
    if (!admitted) throw new LineGraphError(`${w.file} is not a file of a graph this machine tracks`);
    writes.push({ file: admitted, content: w.content });
  }
  for (const w of writes) deps.write(w.file, w.content);
  const published = plan.changed && deps.publish ? await deps.publish(realRoot, castAbs) : null;
  return { file: castAbs, target: plan.target, node: args.node, changed: plan.changed, graph_hash: plan.graph_hash, node_hash: plan.node_hash, was_hash: plan.was_hash, published };
}
