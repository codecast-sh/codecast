import type { WorkflowGraph } from "./types";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { conditionError } from "./condition";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { SEGMENT_SEP, retiredFlowLine, segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { Parser, tokenize, inlineRef, isStopExit, mentionsFailure, shapeOf, type Attr, type RawGraph, type ReadFile } from "./rawGraph";
import { VARIANT_KEYS, applyOverrides, variantEdits, withGuides } from "./variantEdits";
import { teamFlowFile } from "./teamFlowIndex";

export type { ReadFile };
const readDisk: ReadFile = (abs) => (fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8") : null);

export interface ParseOptions {
  read?: ReadFile;
  /** Where a `flow="<slug>"` node's segment is read from (flows.md FL3); default resolveFlowSource. */
  resolveFlow?: ResolveFlow;
  /** False keeps each `@file` as an absolute `@/path` instead of its text (where a station's file lives). */
  inline?: boolean;
}

export function parseWorkflowFile(filePath: string, opts: ParseOptions = {}): WorkflowGraph {
  const read = opts.read ?? readDisk;
  const abs = path.resolve(filePath);
  const src = read(abs);
  if (src === null) throw new Error(`No workflow file at ${abs}`);
  const graph = parseWorkflowSource(src, path.dirname(abs), { ...opts, read }, abs);
  graph.sources = [abs, ...(graph.sources ?? [])];
  return graph;
}

/**
 * A graph from its source. With `dir` (the file's own directory), `@file`
 * values resolve against the file that wrote them, and a graph that names
 * `extends` is that base with this file's differences:
 *
 *   - graph attributes and a node's attributes override the base's, one by one;
 *   - a node marked `removed` leaves, and an edge into it must be re-routed here;
 *   - a node this file routes (any edge out of it) has exactly the edges
 *     written here, so a node's routing is always read in one file;
 *   - `serves` (the finding sources a line version runs) is this file's own,
 *     never the base's;
 *   - a base node marked `slot="<what it must do>"` is a segment left for the
 *     variant to fill: `subgraph <slot> { ... }` writes its steps, and they
 *     run in its place as a segment would (a slot's own `flow=` is the steps
 *     it runs when nothing fills it). A subgraph may fill only a slot of the
 *     base or a node this file adds, so a backbone keeps every other station.
 *
 * `extends` names a file beside this one, or a flow by name, read where a
 * `flow="<slug>"` segment is read from (resolveFlowSource).
 *
 * A prompt or script read from a file takes in a shared part at a line that is
 * only `@include <file>` (relative to the including file).
 */
export function parseWorkflowSource(src: string, dir?: string, opts: ParseOptions = {}, file?: string): WorkflowGraph {
  const read = opts.read ?? readDisk;
  const resolve = opts.resolveFlow ?? resolveFlowSource;
  const loaded = loadRaw(src, dir, read, file ? [file] : [], resolve);
  const raw = expandFlows(ownParams(loaded), dir, read, resolve, opts.inline !== false, []);
  const sources = new Set<string>(raw.files);
  const guides = withGuides(raw, opts.inline !== false ? read : null, sources);
  const graph = buildGraph(raw);
  // Each guide edit carries the text its station reads and which station that is.
  for (const e of graph.edits ?? []) {
    const g = e.op === "guide" ? guides.find((x) => x.node === e.station || x.node.startsWith(`${e.station}${SEGMENT_SEP}`)) : undefined;
    if (g) Object.assign(e, { node: g.node, ...(g.text !== null ? { text: g.text } : {}) });
  }
  if (dir && opts.inline !== false) {
    // Every file the graph inlined: a runner compares them at a gate's answer (runResume.ts runnerStamp).
    for (const node of graph.nodes.values()) {
      if (node.prompt) node.prompt = inlineRef(node.prompt, read, sources);
      if (node.script) node.script = inlineRef(node.script, read, sources);
    }
  }
  if (sources.size) graph.sources = [...sources];
  if (raw.shipped?.length) graph.shipped = raw.shipped;
  return graph;
}

/** The base a graph's source names with `extends`, as written. */
export function graphExtends(src: string): string | undefined {
  const ext = new Parser(tokenize(src)).parseRaw().attrs.extends;
  return ext === undefined ? undefined : String(ext);
}

function loadRaw(src: string, dir: string | undefined, read: ReadFile, chain: string[], resolve: ResolveFlow = resolveFlowSource): RawGraph {
  const raw = new Parser(tokenize(src)).parseRaw();
  const shipped = shippedSlugOf(src, raw);
  if (shipped) raw.shipped = [shipped];
  if (dir) {
    // `@file` against the file that wrote it, so a base's stations keep reading the base's files.
    for (const attrs of raw.nodes.values()) {
      for (const field of ["prompt", "script", "guide"]) {
        const v = attrs[field];
        if (typeof v !== "string" || !v.startsWith("@")) continue;
        const abs = path.resolve(dir, v.slice(1));
        if (read(abs) !== null) attrs[field] = `@${abs}`;
      }
    }
  }
  const ext = raw.attrs.extends;
  const here = chain[chain.length - 1] ?? raw.name;
  if (ext === undefined) {
    for (const id of raw.fills?.keys() ?? []) if (!raw.nodes.has(id)) throw new Error(`${here}: subgraph ${id} fills no node: declare ${id} in the graph, or name a slot of the flow this one extends`);
    for (const [id, a] of raw.nodes) {
      const key = VARIANT_KEYS.find((k) => a[k] !== undefined && a[k] !== false);
      if (key) throw new Error(`${here}: ${id} [${key}=...] edits the flow this one extends, and this file extends none: add graph [extends="<flow>"], or write ${id}'s ${key === "guide" ? "prompt" : "edges"} out in full`);
    }
    return raw;
  }
  // A file beside this one, else a flow by name (the repo's, then a shipped one).
  const asFile = dir ? path.resolve(dir, String(ext)) : null;
  const fileSrc = asFile ? read(asFile) : null;
  // A repo's `change.cast` that extends "change" means the flow it shadows, never itself.
  const self = chain[chain.length - 1];
  const bySlug = /^[\w-]+$/.test(String(ext));
  // Callers that parse a source with only its directory name no file: the file whose text this is, is this file.
  const notSelf: ReadFile = (abs) => {
    const text = read(abs);
    return bySlug && (abs === self || text === src) ? null : text;
  };
  const found: FlowSource | null = fileSrc !== null ? { src: fileSrc, dir: path.dirname(asFile!), file: asFile! } : resolve(String(ext), dir, notSelf);
  if (!found) throw new Error(`${here}: extends="${ext}": ${(bySlug && retiredFlowLine(String(ext))) || `no graph at ${asFile ?? ext}, and no flow of that name in the pool`}`);
  const key = found.file ?? `flow:${ext}`;
  if (chain.includes(key)) throw new Error(`${here}: extends="${ext}" comes back to itself`);
  const base = loadRaw(found.src, found.dir, read, [...chain, key], resolve);
  return inherit(base, raw, key, here);
}

/** `child` written on top of `base` (parseWorkflowSource names the rules). */
function inherit(base: RawGraph, child: RawGraph, baseFile: string, here: string): RawGraph {
  const removed = new Set([...child.nodes].filter(([, a]) => a.removed === true || a.removed === "true").map(([id]) => id));
  for (const id of removed) if (!base.nodes.has(id)) throw new Error(`${here}: removes ${id}, which ${path.basename(baseFile)} does not have`);
  for (const id of child.fills?.keys() ?? []) {
    const b = base.nodes.get(id);
    if (b && !b.slot) throw new Error(`${here}: subgraph ${id} fills a station of ${path.basename(baseFile)} that is not a slot; its slots: ${[...base.nodes].filter(([, a]) => a.slot).map(([sid]) => sid).join(", ") || "none"}`);
    if (!b && !child.nodes.has(id)) throw new Error(`${here}: subgraph ${id} fills no node: ${path.basename(baseFile)} has no slot ${id}${[...base.nodes].some(([, a]) => a.slot) ? ` (its slots: ${[...base.nodes].filter(([, a]) => a.slot).map(([sid]) => sid).join(", ")})` : ""}`);
  }
  const routed = new Set(child.edges.map((e) => e.from));
  for (const e of child.edges) {
    const gone = [e.from, e.to].find((id) => removed.has(id));
    if (gone) throw new Error(`${here}: the edge ${e.from} -> ${e.to} uses ${gone}, which this file removes`);
  }
  for (const e of base.edges) {
    if (removed.has(e.to) && !removed.has(e.from) && !routed.has(e.from)) {
      throw new Error(`${here}: ${e.from} goes to ${e.to}, which this file removes: write ${e.from}'s edges here`);
    }
  }
  // `review__review [...]` names a station inside a segment, which exists only once the segment is expanded.
  const inEdges = new Set(child.edges.flatMap((e) => [e.from, e.to]));
  const overrides = new Map(base.overrides ?? []);
  const own = new Map<string, Record<string, Attr>>();
  for (const [id, a] of child.nodes) {
    if (id.includes(SEGMENT_SEP) && !base.nodes.has(id) && !inEdges.has(id)) overrides.set(id, { ...overrides.get(id), ...a });
    else own.set(id, a);
  }
  const nodes = new Map<string, Record<string, Attr>>();
  for (const [id, a] of base.nodes) if (!removed.has(id)) nodes.set(id, a);
  for (const [id, a] of own) if (!removed.has(id)) nodes.set(id, { ...nodes.get(id), ...a });
  // `serves` names the sources this file's own version runs, so a version never claims its base's.
  const { extends: _extends, serves: _baseServes, ...baseAttrs } = base.attrs;
  const { extends: _childExtends, ...childAttrs } = child.attrs;
  const attrs = { ...baseAttrs, ...childAttrs };
  const merged: RawGraph = {
    name: child.name,
    attrs,
    nodes,
    edges: [...base.edges.filter((e) => !routed.has(e.from) && !removed.has(e.from) && !removed.has(e.to)), ...child.edges],
    files: [...(path.isAbsolute(baseFile) ? [baseFile] : []), ...base.files],
    shipped: [...new Set([...(base.shipped ?? []), ...(child.shipped ?? [])])],
    fills: new Map([...(base.fills ?? [])].filter(([id]) => !removed.has(id)).concat([...(child.fills ?? [])])),
    overrides,
    // What the base gated or took off stays so down a chain; edits are this file's own (cast flow show reads them against its base).
    pruned: base.pruned,
    gated: base.gated,
  };
  return variantEdits(merged, own, child.nodes, new Set(base.nodes.keys()), path.basename(baseFile).replace(/\.cast$/, "").replace(/^flow:/, ""), here, new Set(child.edges));
}

function buildGraph(raw: RawGraph): WorkflowGraph {
  const graph: WorkflowGraph = { name: raw.name, nodes: new Map(), edges: raw.edges };
  const a = raw.attrs;
  if (a.rankdir !== undefined) graph.rankdir = String(a.rankdir);
  if (a.goal) graph.goal = a.goal as string;
  if (a.model_stylesheet) graph.model_stylesheet = a.model_stylesheet as string;
  if (a.fidelity) graph.fidelity = a.fidelity as string;
  if (a.join_policy) graph.join_policy = a.join_policy as string;
  if (a.stack) graph.stack = String(a.stack);
  if (a.on_failure === "stop") graph.on_failure = "stop";
  if (a.serves) graph.serves = [...new Set(String(a.serves).split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (a.kind === "segment" || a.kind === "line") graph.kind = a.kind;
  if (a.label) graph.label = String(a.label);
  if (a.description) graph.description = String(a.description);
  if (a.draft) graph.draft = String(a.draft);
  if (a.takes) graph.takes = String(a.takes).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (raw.edits?.length) graph.edits = raw.edits;
  if (raw.pruned?.length) graph.pruned = raw.pruned;
  if (raw.gated && Object.keys(raw.gated).length) graph.gated = raw.gated;
  for (const [id, attrs] of raw.nodes) graph.nodes.set(id, Parser.buildNode(id, attrs));
  // Ensure nodes referenced in edges exist (as placeholder agent nodes)
  for (const e of raw.edges) for (const id of [e.from, e.to]) if (!graph.nodes.has(id)) graph.nodes.set(id, Parser.buildNode(id, {}));
  return graph;
}

// --- Segments (docs/architecture/flows.md FL3) ---

/** A segment's source: its text, the directory its `@file` values resolve from, and its file. */
export type FlowSource = { src: string; dir?: string; file?: string };
export type ResolveFlow = (slug: string, dir: string | undefined, read: ReadFile) => FlowSource | null;

export { SEGMENT_SEP };

/**
 * Where a flow's slug is read from: a `<slug>.cast` beside the graph, the
 * repo's `.codecast/flows/<slug>.cast` (the nearest one above the graph), a
 * flow the CLI ships, then a flow the team published (teamFlowIndex.ts).
 */
export function resolveFlowSource(slug: string, dir: string | undefined, read: ReadFile = readDisk): FlowSource | null {
  const name = slug.replace(/\.cast$/, "");
  if (dir) {
    const beside = path.resolve(dir, `${name}.cast`);
    const own = read(beside);
    if (own !== null) return { src: own, dir: path.dirname(beside), file: beside };
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      const f = path.join(d, ".codecast", "flows", `${name}.cast`);
      const text = read(f);
      if (text !== null) return { src: text, dir: path.dirname(f), file: f };
      if (path.dirname(d) === d) break;
    }
  }
  const shipped = Object.prototype.hasOwnProperty.call(BUILTIN_WORKFLOW_TEMPLATES, name) ? BUILTIN_WORKFLOW_TEMPLATES[name] : undefined;
  if (shipped !== undefined) return { src: shipped };
  // Last, a flow the team published, as this machine last read it from the pool: never a name the library retired,
  // whose stale entry an older pool read may have left in this machine's index.
  if (retiredFlowLine(name)) return null;
  const team = teamFlowFile(name);
  const text = team ? read(team) : null;
  return team && text !== null ? { src: text, dir: path.dirname(team), file: team } : null;
}

/**
 * Whether a graph is built from the shipped flow `slug`, as the parser expands it: the graph itself, a base it
 * extends, or a segment any of them runs (WorkflowGraph.shipped). A graph that does not parse does not run, so it
 * reaches nothing.
 */
export function reachesShippedFlow(src: string, dir: string | undefined, slug: string, read: ReadFile = readDisk): boolean {
  try {
    return !!parseWorkflowSource(src, dir, { read }).shipped?.includes(slug);
  } catch {
    return false;
  }
}

/**
 * The shipped flow a source is, by slug: how a parse knows where a graph came from. Its exact text, or, for the
 * personal Ship, what any copy of it keeps however it was copied (line endings, a stale sync of the repo's own
 * template): its `own_results=true` graph attribute, or a station reading the template's own `@personal/` files.
 */
function shippedSlugOf(src: string, raw: RawGraph): string | null {
  for (const [slug, text] of Object.entries(BUILTIN_WORKFLOW_TEMPLATES)) if (text === src) return slug;
  const ownResults = raw.attrs.own_results === true || raw.attrs.own_results === "true";
  const readsPersonalFiles = [...raw.nodes.values()].some((a) => ["prompt", "script", "guide"].some((f) => typeof a[f] === "string" && (a[f] as string).startsWith("@personal/")));
  return ownResults || readsPersonalFiles ? "personal" : null;
}

const STRING_FIELDS = ["prompt", "script", "doc", "card", "stop", "goal", "guide"];
const ID_FIELDS = ["asker", "answerer", "retry_target"];

/**
 * A segment's params (`params="except above=50"`): `$except` in its stations
 * and in its edges' conditions reads the composing node's attribute, else the
 * default written after `=`, else nothing. A value lands in a script as
 * written, so it is held to words and names, or one run variable
 * (`$review_question`), which the run expands as it expands any other.
 */
function paramSubstitution(spec: Attr | undefined, given: Record<string, Attr>, who: string): (text: string) => string {
  const values = String(spec ?? "").split(/[\s,]+/).filter(Boolean).map((param) => {
    const [name, ...rest] = param.split("=");
    const value = given[name] === undefined ? rest.join("=") : String(given[name]);
    if (!/^[\w .,:@/+-]*$/.test(value) && !/^\$[A-Za-z_][\w.]*$/.test(value)) throw new Error(`${who} ${name}="${value}" may hold only words, names and paths, or one $variable`);
    return { ref: new RegExp(`\\$${name}(?![\\w.])`, "g"), value };
  });
  return (text) => values.reduce((t, { ref, value }) => t.replace(ref, value), text);
}

/** A segment run on its own is its own composer with no attribute set: its params read their defaults. */
function ownParams(raw: RawGraph): RawGraph {
  if (raw.attrs.params === undefined) return raw;
  const sub = paramSubstitution(raw.attrs.params, {}, `${raw.name}:`);
  const nodes = new Map([...raw.nodes].map(([id, a]) => [id, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, STRING_FIELDS.includes(k) && typeof v === "string" ? sub(v) : v]))]));
  return { ...raw, nodes, edges: raw.edges.map((e) => (e.condition ? { ...e, condition: sub(e.condition) } : e)) };
}

/**
 * Every `flow="<slug>"` node replaced by that segment's stations, named
 * `<node>__<station>`. Edges into the node enter the segment where its start
 * leads; each plain exit leaves by the node's own edges with outcome success,
 * and `<node>.exit` in their conditions names the exit it took.
 * A stop exit ends the run in the segment's words, unless the node routes
 * `outcome = failure`: then it leaves by those edges with outcome failure.
 */
function expandFlows(raw: RawGraph, dir: string | undefined, read: ReadFile, resolve: ResolveFlow, inline: boolean, chain: string[]): RawGraph {
  const fills = raw.fills ?? new Map<string, RawGraph>();
  const flowNodes = [...raw.nodes].filter(([id, a]) => fills.has(id) || (typeof a.flow === "string" && a.flow));
  if (!flowNodes.length) return applyOverrides(raw);
  const nodes = new Map(raw.nodes);
  let edges = [...raw.edges];
  const files = [...raw.files];
  const shipped = new Set(raw.shipped ?? []);
  for (const [id, attrs] of flowNodes) {
    const fill = fills.get(id);
    // A fill is this graph's own steps: no slug to name it by, read where this graph is read.
    const slug = fill ? "" : String(attrs.flow);
    let seg: RawGraph;
    if (fill) {
      seg = expandFlows(fillAsSegment(fill, raw.name), dir, read, resolve, inline, chain);
    } else {
      if (chain.includes(slug)) throw new Error(`${raw.name}: flow="${slug}" at ${id} comes back to itself (${[...chain, slug].join(" -> ")})`);
      const found = resolve(slug, dir, read);
      if (!found) throw new Error(`${raw.name}: ${id} names flow="${slug}", which is not in the pool (.codecast/flows/${slug}.cast or a shipped flow)`);
      seg = loadRaw(found.src, found.dir, read, found.file ? [found.file] : [], resolve);
      seg = expandFlows(seg, found.dir, read, resolve, inline, [...chain, slug]);
      if (found.file) files.push(found.file);
    }
    files.push(...seg.files);
    for (const s of seg.shipped ?? []) shipped.add(s);
    const slot = typeof attrs.slot === "string" ? attrs.slot : attrs.slot === true ? String(attrs.label ?? id) : null;
    const marks: Record<string, Attr> = { ...(slug ? { segment_flow: slug } : {}), ...(fill ? { segment_generated: true } : {}) };
    const starts = [...seg.nodes].filter(([, a]) => shapeOf(a) === "Mdiamond").map(([sid]) => sid);
    if (starts.length !== 1) throw new Error(`flow "${slug}" needs exactly one start node to be used as a segment`);
    const start = starts[0];
    const inner = [...seg.nodes.keys()];
    const p = `${id}${SEGMENT_SEP}`;
    const rename = (s: string) => (s === start ? id : `${p}${s}`);
    // `$station.output` in a prompt or script, `station.json.x` in a condition: the station's new name.
    const alt = inner.filter((s) => s !== start).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const varRefs = new RegExp(`\\$(${alt})(?=\\.)`, "g");
    const condRefs = new RegExp(`(^|[^\\w.$])(${alt})(?=\\.)`, "g");
    const withParams = paramSubstitution(seg.attrs.params, attrs, `${raw.name}: ${id}'s`);
    const rewrite = (text: string) => withParams(alt ? text.replace(varRefs, (_m, sid: string) => `$${p}${sid}`) : text);
    const rewriteCondition = (c: string) => withParams(alt ? c.replace(condRefs, (_m, pre: string, sid: string) => `${pre}${p}${sid}`) : c);
    const out = edges.filter((e) => e.from === id);
    const routesFailure = out.some(mentionsFailure);
    edges = edges.filter((e) => e.from !== id);
    nodes.delete(id);
    // A fill has no name of its own: it reads as the node it fills.
    const segLabel = String(attrs.label ?? seg.attrs.label ?? (slug || id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())));
    for (const [sid, a] of seg.nodes) {
      if (sid === start) continue;
      const copy: Record<string, Attr> = { ...a, segment: id, segment_label: segLabel, ...marks };
      for (const f of STRING_FIELDS) {
        const v = copy[f];
        if (typeof v !== "string") continue;
        const text = inline && v.startsWith("@") && path.isAbsolute(v.slice(1)) ? inlineRef(v, read, new Set()) : v;
        copy[f] = rewrite(text);
      }
      for (const f of ID_FIELDS) if (typeof copy[f] === "string" && inner.includes(String(copy[f]))) copy[f] = rename(String(copy[f]));
      // The graph that composes the segment knows which of its stations answers the segment's gates.
      if (attrs.answerer && shapeOf(a) === "hexagon" && !copy.asker && !copy.answerer) copy.answerer = attrs.answerer;
      // What makes a run ask, said where the graph names the segment, is its gates'.
      if (attrs.asks_if && shapeOf(a) === "hexagon" && !copy.asks_if) copy.asks_if = attrs.asks_if;
      if (shapeOf(a) === "Msquare" && !(isStopExit(a) && !routesFailure)) {
        // An exit the node's own edges leave from: a step that says which exit it took.
        const failing = isStopExit(a);
        const said = String(a.label ?? sid).replace(/[^\w .,:()-]/g, "");
        const exitId = `${p}${sid}`;
        // A routed stop keeps the segment's words for why, read as $stop_reason by whatever the node routes to.
        nodes.set(exitId, { shape: "parallelogram", label: said, script: `echo '{"exit": "${sid}"}'${failing ? "; exit 1" : ""}`, segment: id, segment_label: segLabel, ...marks, segment_exit: failing ? "stop" : "done", ...(failing ? { stop: rewrite(String(a.stop)) } : {}) });
        // `<node>.exit` in the node's own conditions reads which exit the segment took.
        const which = (c: string) => c.replace(new RegExp(`(^|[^\\w.])${id}\\.exit\\b`, "g"), `$1${exitId}.json.exit`);
        for (const e of out.filter((e) => (failing ? mentionsFailure(e) : !mentionsFailure(e)))) edges.push({ ...e, from: exitId, ...(e.condition ? { condition: which(e.condition) } : {}) });
        continue;
      }
      nodes.set(`${p}${sid}`, copy);
    }
    // The node itself is the segment's entry: a step that passes straight on, named for the segment.
    nodes.set(id, { shape: "diamond", label: segLabel, segment: id, segment_label: segLabel, ...marks, segment_entry: true, ...(slot ? { slot } : {}) });
    for (const e of seg.edges) edges.push({ ...e, from: rename(e.from), to: rename(e.to), ...(e.condition ? { condition: rewriteCondition(e.condition) } : {}) });
  }
  return applyOverrides({ ...raw, nodes, edges, files, shipped: [...shipped], fills: undefined });
}

/**
 * A subgraph's steps as a segment. One that writes its own start and exit is
 * read as written; one that writes only its steps (`a -> b -> c`) starts at the
 * one step nothing inside leads to and ends after the one that leads nowhere.
 */
function fillAsSegment(fill: RawGraph, graphName: string): RawGraph {
  const ids = new Set([...fill.nodes.keys(), ...fill.edges.flatMap((e) => [e.from, e.to])]);
  if (!ids.size) throw new Error(`${graphName}: subgraph ${fill.name} is empty: write the steps that fill it`);
  if ([...fill.nodes.values()].some((a) => shapeOf(a) === "Mdiamond")) return fill;
  const fresh = (base: string) => { let n = base; while (ids.has(n)) n = `_${n}`; return n; };
  const firsts = [...ids].filter((id) => !fill.edges.some((e) => e.to === id));
  const lasts = [...ids].filter((id) => !fill.edges.some((e) => e.from === id) && shapeOf(fill.nodes.get(id) ?? {}) !== "Msquare");
  if (firsts.length !== 1) throw new Error(`${graphName}: subgraph ${fill.name} starts at ${firsts.length ? firsts.join(" and ") : "no step"}: route its steps from one first step, or write its own start [shape=Mdiamond]`);
  const start = fresh("start");
  const nodes = new Map(fill.nodes);
  nodes.set(start, { shape: "Mdiamond" });
  const edges = [{ from: start, to: firsts[0] }, ...fill.edges];
  if (![...nodes.values()].some((a) => shapeOf(a) === "Msquare")) {
    if (lasts.length !== 1) throw new Error(`${graphName}: subgraph ${fill.name} ends at ${lasts.join(" and ") || "no step"}: lead its steps to one last step, or write its own exit [shape=Msquare]`);
    const exit = fresh("exit");
    nodes.set(exit, { shape: "Msquare" });
    edges.push({ from: lasts[0], to: exit });
  }
  return { ...fill, nodes, edges };
}

/** The slots a graph leaves empty, with what each must do: a graph with any is a backbone to extend, and does not run. */
export function emptySlots(graph: WorkflowGraph): Array<{ id: string; label: string; does: string }> {
  return [...graph.nodes.values()].filter((n) => n.slot && !n.segment_entry).map((n) => ({ id: n.id, label: n.label, does: n.slot! }));
}

/** The slots a graph has, filled or not: each one's id, what it must do, and how it is filled now. */
export function graphSlots(graph: WorkflowGraph): Array<{ id: string; label: string; does: string; filled: "empty" | "default" | "generated" }> {
  return [...graph.nodes.values()].filter((n) => n.slot).map((n) => ({ id: n.id, label: n.label, does: n.slot!, filled: !n.segment_entry ? "empty" : n.segment_generated ? "generated" : "default" }));
}

export function validateWorkflow(graph: WorkflowGraph): string[] {
  const errors: string[] = [];

  const starts = [...graph.nodes.values()].filter(n => n.type === "start");
  const exits = [...graph.nodes.values()].filter(n => n.type === "exit");

  if (starts.length === 0) errors.push("No start node (Mdiamond shape) found");
  if (starts.length > 1) errors.push("Multiple start nodes found");
  if (exits.length === 0) errors.push("No exit node (Msquare shape) found");

  // Check all edge references exist
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from)) errors.push(`Edge references unknown node: ${edge.from}`);
    if (!graph.nodes.has(edge.to)) errors.push(`Edge references unknown node: ${edge.to}`);
    const conditionErr = edge.condition ? conditionError(edge.condition) : null;
    if (conditionErr) errors.push(`Edge ${edge.from} -> ${edge.to} condition "${edge.condition}": ${conditionErr}`);
  }

  // A station named by another (who answers a gate, where a retry goes) must still be there, and so must one a $ref reads.
  // Only a real reference counts: `$review.output` or `$review__review.x` in text, `review.exit` in a condition.
  const gone = new Set(graph.pruned ?? []);
  const gated = graph.gated ?? {};
  const esc = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const textRef = (text: string, ids: Iterable<string>) => [...ids].find((id) => new RegExp(`\\$${esc(id)}(\\.|${SEGMENT_SEP})`).test(text));
  const condRef = (cond: string, ids: Iterable<string>) => [...ids].find((id) => new RegExp(`(^|[^\\w.$])${esc(id)}(\\.|${SEGMENT_SEP})`).test(cond.replace(/"[^"]*"/g, "")));
  const runsWhen = (id: string) => `runs only when the change touches ${gated[id].join(", ")}`;
  for (const node of graph.nodes.values()) {
    const others = (ids: Iterable<string>) => [...ids].filter((id) => id !== segmentTopOf(node.id));
    for (const f of ID_FIELDS) {
      const v = (node as unknown as Record<string, unknown>)[f];
      if (typeof v !== "string") continue;
      const top = segmentTopOf(v);
      if (!graph.nodes.has(v)) {
        errors.push(gone.has(top)
          ? `${node.id} [${f}="${v}"] names ${v}, and this flow skips ${top}: point ${f} at a station that stays, or stop skipping ${top}`
          : `${node.id} [${f}="${v}"] names no station of this flow`);
      } else if (gated[top] && top !== segmentTopOf(node.id)) {
        errors.push(`${node.id} [${f}="${v}"] names ${v}, and ${top} ${runsWhen(top)}: point ${f} at a station that always runs, or drop ${top}'s when=`);
      }
    }
    for (const f of ["prompt", "script", "doc", "card", "stop"] as const) {
      const text = node[f];
      if (typeof text !== "string") continue;
      const skippedRef = textRef(text, gone);
      if (skippedRef) errors.push(`${node.id}'s ${f} reads $${skippedRef}, and this flow skips ${skippedRef}: change ${node.id}'s ${f}, or stop skipping ${skippedRef}`);
      const gatedRef = textRef(text, others(Object.keys(gated)));
      if (gatedRef) errors.push(`${node.id}'s ${f} reads $${gatedRef}, and ${gatedRef} ${runsWhen(gatedRef)}: change ${node.id}'s ${f}, or drop ${gatedRef}'s when=`);
    }
  }
  for (const edge of graph.edges) {
    if (!edge.condition) continue;
    const ref = condRef(edge.condition, gone);
    if (ref) errors.push(`Edge ${edge.from} -> ${edge.to} condition "${edge.condition}" reads ${ref}, and this flow skips ${ref}`);
    const g = condRef(edge.condition, Object.keys(gated).filter((id) => id !== segmentTopOf(edge.from)));
    if (g) errors.push(`Edge ${edge.from} -> ${edge.to} condition "${edge.condition}" reads ${g}, and ${g} ${runsWhen(g)}`);
  }

  // A fan-out runs only its branches and goes on from the first join after them (runner.ts executeFanout). A branch
  // also entered from outside the fan-out (the fan-out's retry_target, or the target of another node's edge) runs on
  // its own there, and its other edges route that run, so it may have them.
  for (const fan of [...graph.nodes.values()].filter((n) => n.type === "parallel_fanout")) {
    const branches = graph.edges.filter((e) => e.from === fan.id).map((e) => e.to);
    const join = branches.flatMap((b) => graph.edges.filter((e) => e.from === b).map((e) => e.to)).find((t) => graph.nodes.get(t)?.type === "parallel_fanin");
    if (!join) continue;
    const alone = (b: string) => fan.retry_target === b || graph.edges.some((e) => e.to === b && e.from !== fan.id);
    for (const b of branches) {
      if (alone(b)) continue;
      const off = graph.edges.filter((e) => e.from === b && e.to !== join).map((e) => e.to);
      if (off.length) errors.push(`${fan.id}'s branch ${b} goes on to ${off.join(", ")}, but a fan-out runs only its branches and goes on from ${join}: lead ${b} straight to ${join}`);
    }
  }

  // Check command nodes have scripts
  for (const node of graph.nodes.values()) {
    if (node.type === "command" && !node.script) {
      errors.push(`Command node '${node.id}' has no script attribute`);
    }
    if (node.type === "call" && !node.prompt) {
      errors.push(`Call node '${node.id}' has no prompt attribute`);
    }
    if (node.type === "call" && node.max_tokens !== undefined && !(Number.isInteger(node.max_tokens) && node.max_tokens > 0)) {
      errors.push(`Call node '${node.id}' has max_tokens ${node.max_tokens}: a whole number above 0`);
    }
    if (node.type === "agent" && !node.prompt) {
      // Warning, not error - agent might be guided by goal
    }
  }

  return errors;
}

// A content hash of the graph as parsed (the-line-end-to-end.md LE14), so a
// run records exactly which graph it executed. Whitespace, comments and
// attribute order in the source do not change it; any node, edge or graph
// attribute does. Taken before the runner expands $vars into the goal.
const sortedAttrs = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));

export function graphHash(graph: WorkflowGraph): string {
  const sorted = sortedAttrs;
  // Where the graph was read from is not what it is.
  const { nodes, edges, sources: _sources, shipped: _shipped, edits: _edits, pruned: _pruned, gated: _gated, ...attrs } = graph;
  const canonical = JSON.stringify({
    graph: sorted(attrs),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(sorted),
    edges: edges.map(sorted),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** How a variant differs from its base, by node id: what it changes, adds, removes and routes anew. */
export function graphDiff(base: WorkflowGraph, variant: WorkflowGraph): { changes: string[]; adds: string[]; removes: string[]; routes: string[] } {
  const same = (a: object[], b: object[]) => JSON.stringify(a.map(sortedAttrs)) === JSON.stringify(b.map(sortedAttrs));
  const out = (g: WorkflowGraph, id: string) => g.edges.filter((e) => e.from === id);
  const ids = [...variant.nodes.keys()];
  return {
    changes: ids.filter((id) => base.nodes.has(id) && !same([base.nodes.get(id)!], [variant.nodes.get(id)!])),
    adds: ids.filter((id) => !base.nodes.has(id)),
    removes: [...base.nodes.keys()].filter((id) => !variant.nodes.has(id)),
    routes: ids.filter((id) => base.nodes.has(id) && !same(out(base, id), out(variant, id))),
  };
}

// Each station's own hash (LE14): the node as parsed with the edges leaving
// it, so two versions of a graph say which stations changed (a prompt edit,
// a new route) rather than only that something did.
export function graphNodeHashes(graph: WorkflowGraph): Array<{ id: string; h: string }> {
  return [...graph.nodes.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => ({ id: n.id, h: createHash("sha256").update(JSON.stringify({ node: sortedAttrs(n), out: graph.edges.filter((e) => e.from === n.id).map(sortedAttrs) })).digest("hex").slice(0, 8) }));
}
