import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeShape, NodeType } from "./types";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { conditionError } from "./condition";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";
import { SEGMENT_SEP } from "@codecast/shared/contracts/flowPool";
import { whenPaths, type FlowEditChange } from "@codecast/shared/contracts/flowEdit";
import { teamFlowFile } from "./teamFlowIndex";

// --- Tokenizer ---

type Token =
  | { type: "IDENT"; value: string }
  | { type: "STRING"; value: string }
  | { type: "NUMBER"; value: number }
  | { type: "ARROW" }
  | { type: "LBRACE" }
  | { type: "RBRACE" }
  | { type: "LBRACKET" }
  | { type: "RBRACKET" }
  | { type: "EQ" }
  | { type: "COMMA" }
  | { type: "SEMI" }
  | { type: "EOF" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i])) { i++; continue; }

    // Line comment
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Quoted string
    if (src[i] === '"') {
      i++;
      let val = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1];
          if (esc === 'n') val += '\n';
          else if (esc === 't') val += '\t';
          else if (esc === '"') val += '"';
          else val += esc;
          i += 2;
        } else {
          val += src[i++];
        }
      }
      i++; // closing "
      tokens.push({ type: "STRING", value: val });
      continue;
    }

    // Arrow
    if (src[i] === '-' && src[i + 1] === '>') {
      tokens.push({ type: "ARROW" });
      i += 2;
      continue;
    }

    // Single chars
    if (src[i] === '{') { tokens.push({ type: "LBRACE" }); i++; continue; }
    if (src[i] === '}') { tokens.push({ type: "RBRACE" }); i++; continue; }
    if (src[i] === '[') { tokens.push({ type: "LBRACKET" }); i++; continue; }
    if (src[i] === ']') { tokens.push({ type: "RBRACKET" }); i++; continue; }
    if (src[i] === '=') { tokens.push({ type: "EQ" }); i++; continue; }
    if (src[i] === ',') { tokens.push({ type: "COMMA" }); i++; continue; }
    if (src[i] === ';') { tokens.push({ type: "SEMI" }); i++; continue; }

    // Number
    if (/[0-9]/.test(src[i]) || (src[i] === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      let num = '';
      if (src[i] === '-') num += src[i++];
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      tokens.push({ type: "NUMBER", value: parseFloat(num) });
      continue;
    }

    // Identifier (alphanum + _ + .)
    if (/[a-zA-Z_@$]/.test(src[i])) {
      let id = '';
      // A `-` belongs to the name (`fix-check`) unless it opens an arrow: `a->b` is an edge.
      while (i < src.length && /[a-zA-Z0-9_.$@/\-]/.test(src[i]) && !(src[i] === '-' && src[i + 1] === '>')) id += src[i++];
      tokens.push({ type: "IDENT", value: id });
      continue;
    }

    // Skip unknown
    i++;
  }

  tokens.push({ type: "EOF" });
  return tokens;
}

// --- Parser ---

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }

  private expect(type: Token["type"]): Token {
    const t = this.consume();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    return t;
  }

  private peekIs(type: Token["type"]): boolean {
    return this.peek().type === type;
  }

  private skipSemis() {
    while (this.peekIs("SEMI")) this.consume();
  }

  /** The file as written: graph attributes, each declared node's attributes, the edges. */
  parseRaw(): RawGraph {
    // optional: digraph or graph keyword
    const first = this.peek();
    if (first.type === "IDENT" && (first.value === "digraph" || first.value === "graph")) {
      this.consume();
    }

    // graph name (optional)
    let name = "Workflow";
    if (this.peekIs("IDENT") || this.peekIs("STRING")) {
      name = (this.consume() as any).value;
    }

    this.expect("LBRACE");
    const raw: RawGraph = { name, attrs: {}, nodes: new Map(), edges: [], files: [] };
    while (!this.peekIs("RBRACE") && !this.peekIs("EOF")) {
      this.parseStatement(raw);
      this.skipSemis();
    }
    this.expect("RBRACE");
    return raw;
  }

  private parseStatement(raw: RawGraph) {
    const t = this.peek();

    // rankdir=LR (graph attribute shorthand)
    if (t.type === "IDENT" && t.value === "rankdir") {
      this.consume();
      this.expect("EQ");
      raw.attrs.rankdir = (this.consume() as any).value;
      return;
    }

    // subgraph <node> { ... }: the steps that fill that node (a slot of the base, or a node of this file) in place
    if (t.type === "IDENT" && t.value === "subgraph") {
      this.consume();
      const name = this.peekIs("IDENT") || this.peekIs("STRING") ? this.parseId() : null;
      if (!name) throw new Error("A subgraph needs the name of the node it fills: subgraph <node> { ... }");
      this.expect("LBRACE");
      const fill: RawGraph = { name, attrs: {}, nodes: new Map(), edges: [], files: [] };
      while (!this.peekIs("RBRACE") && !this.peekIs("EOF")) {
        this.parseStatement(fill);
        this.skipSemis();
      }
      this.expect("RBRACE");
      if (fill.fills?.size) throw new Error(`subgraph ${name}: a fill holds steps, not another subgraph`);
      (raw.fills ??= new Map()).set(name, fill);
      return;
    }

    // graph [ attrs ] - graph attributes
    if (t.type === "IDENT" && t.value === "graph") {
      this.consume();
      if (this.peekIs("LBRACKET")) Object.assign(raw.attrs, this.parseAttrList());
      return;
    }

    // node_id or edge statement
    // node_id can be: IDENT or STRING
    if (t.type !== "IDENT" && t.type !== "STRING") {
      this.consume(); // skip unknown
      return;
    }

    const ids = [this.parseId()];

    // Collect chained nodes: a -> b -> c
    while (this.peekIs("ARROW")) {
      this.consume(); // ->
      ids.push(this.parseId());
    }

    // Attr list (applies to edge if multiple ids, node if single)
    const attrs = this.peekIs("LBRACKET") ? this.parseAttrList() : {};

    if (ids.length === 1) {
      // Node statement; a second one for the same id adds to the first (DOT's rule)
      const id = ids[0];
      if (!["graph", "node", "edge", "digraph"].includes(id)) raw.nodes.set(id, { ...raw.nodes.get(id), ...attrs });
    } else {
      // Edge statement(s)
      for (let i = 0; i < ids.length - 1; i++) {
        raw.edges.push({
          from: ids[i],
          to: ids[i + 1],
          label: attrs.label as string | undefined,
          condition: attrs.condition as string | undefined,
          weight: attrs.weight as number | undefined,
          fidelity: attrs.fidelity as string | undefined,
          ...(attrs.free_visit ? { free_visit: String(attrs.free_visit) } : {}),
        });
      }
    }
  }

  private parseId(): string {
    const t = this.consume();
    if (t.type === "IDENT" || t.type === "STRING") return (t as any).value;
    throw new Error(`Expected identifier, got ${t.type}`);
  }

  private parseAttrList(): Record<string, string | number | boolean> {
    this.expect("LBRACKET");
    const attrs: Record<string, string | number | boolean> = {};

    while (!this.peekIs("RBRACKET") && !this.peekIs("EOF")) {
      if (this.peekIs("COMMA")) { this.consume(); continue; }

      // key=value
      const key = this.parseId();
      if (this.peekIs("EQ")) {
        this.consume(); // =
        const val = this.parseValue();
        attrs[key] = val;
      } else {
        attrs[key] = true;
      }
    }

    this.expect("RBRACKET");
    return attrs;
  }

  private parseValue(): string | number | boolean {
    const t = this.peek();
    if (t.type === "STRING") { this.consume(); return (t as any).value; }
    if (t.type === "NUMBER") { this.consume(); return (t as any).value; }
    if (t.type === "IDENT") {
      this.consume();
      const v = (t as any).value;
      if (v === "true") return true;
      if (v === "false") return false;
      return v;
    }
    throw new Error(`Expected value, got ${t.type}`);
  }

  static buildNode(id: string, attrs: Record<string, any>): WorkflowNode {
    const shape = (attrs.shape as NodeShape) || "box";
    const type = shapeToType(shape);

    const node: WorkflowNode = {
      id,
      label: (attrs.label as string) || id,
      shape,
      type,
    };

    if (attrs.prompt) node.prompt = attrs.prompt as string;
    if (attrs.script) node.script = attrs.script as string;
    if (attrs.reasoning_effort) node.reasoning_effort = attrs.reasoning_effort as string;
    if (attrs.model) node.model = attrs.model as string;
    if (attrs.backend) node.backend = attrs.backend as any;
    if (attrs.agent) node.agent = String(attrs.agent);
    if (attrs.definition) node.definition = String(attrs.definition);
    if (attrs.isolated !== undefined) node.isolated = attrs.isolated === true || attrs.isolated === "true";
    for (const k of ["parks", "machine"] as const) if (attrs[k] === true || attrs[k] === "true") node[k] = true;
    if (attrs.refresh !== undefined) node.refresh = attrs.refresh === true || attrs.refresh === "true";
    if (attrs.reviewer !== undefined) node.reviewer = attrs.reviewer === true || attrs.reviewer === "true";
    if (attrs.temperature !== undefined) node.temperature = attrs.temperature as number;
    if (attrs.timeout !== undefined) node.timeout = Number(attrs.timeout);
    if (attrs.max_visits !== undefined) node.max_visits = attrs.max_visits as number;
    if (attrs.max_free_visits !== undefined) node.max_free_visits = Number(attrs.max_free_visits);
    if (attrs.max_retries !== undefined) node.max_retries = attrs.max_retries as number;
    if (attrs.retry_target) node.retry_target = attrs.retry_target as string;
    if (attrs.goal_gate) node.goal_gate = attrs.goal_gate as boolean;
    if (attrs.thread_id) node.thread_id = attrs.thread_id as string;
    if (attrs.fidelity) node.fidelity = attrs.fidelity as string;
    if (attrs.doc) node.doc = String(attrs.doc);
    if (attrs.category) node.category = String(attrs.category);
    if (attrs.card) node.card = String(attrs.card);
    if (attrs.asker) node.asker = String(attrs.asker);
    if (attrs.answerer) node.answerer = String(attrs.answerer);
    if (attrs.stop) node.stop = String(attrs.stop);
    if (attrs.max_tokens !== undefined) node.max_tokens = Number(attrs.max_tokens);
    if (attrs.system) node.system = String(attrs.system);
    if (attrs.output) node.output = String(attrs.output) === "text" ? "text" : "json";
    if (attrs.segment) node.segment = String(attrs.segment);
    if (attrs.segment_label) node.segment_label = String(attrs.segment_label);
    if (attrs.segment_flow) node.segment_flow = String(attrs.segment_flow);
    if (attrs.segment_entry === true || attrs.segment_entry === "true") node.segment_entry = true;
    if (attrs.segment_exit === "done" || attrs.segment_exit === "stop") node.segment_exit = attrs.segment_exit;
    if (typeof attrs.slot === "string" && attrs.slot) node.slot = attrs.slot;
    else if (attrs.slot === true) node.slot = node.label;
    if (attrs.segment_generated === true || attrs.segment_generated === "true") node.segment_generated = true;

    return node;
  }
}

function shapeToType(shape: NodeShape): NodeType {
  switch (shape) {
    case "Mdiamond": return "start";
    case "Msquare": return "exit";
    case "hexagon": return "human";
    case "parallelogram": return "command";
    case "diamond": return "conditional";
    case "component": return "parallel_fanout";
    case "tripleoctagon": return "parallel_fanin";
    case "tab": return "prompt";
    case "note": return "call";
    default: return "agent";
  }
}

// --- Public API ---

type Attr = string | number | boolean;

/** One .cast file as written (or a variant merged onto its base): nothing built or read yet. */
interface RawGraph {
  name: string;
  attrs: Record<string, Attr>;
  /** Declared nodes only; an id an edge names without declaring it becomes an agent node when built. */
  nodes: Map<string, Record<string, Attr>>;
  edges: WorkflowEdge[];
  /** The base files a variant was read on top of. */
  files: string[];
  /** `subgraph <node> { ... }` blocks: the steps that fill that node, by node id. */
  fills?: Map<string, RawGraph>;
  /** A variant's attributes for stations inside a segment (`review__review [...]`, or `review [guide=...]` on the segment), applied once the segment is expanded. */
  overrides?: Map<string, Record<string, Attr>>;
  /** The edits the variant made (after=, before=, skip, when=, guide=), for the words `cast flow show` prints. */
  edits?: FlowEditChange[];
  /** Base stations the variant's skips took off the path. */
  pruned?: string[];
}

/** Reads a file for the parser: absolute path in, its text or null when there is none. */
export type ReadFile = (abs: string) => string | null;
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
  return graph;
}

/** The base a graph's source names with `extends`, as written. */
export function graphExtends(src: string): string | undefined {
  const ext = new Parser(tokenize(src)).parseRaw().attrs.extends;
  return ext === undefined ? undefined : String(ext);
}

function loadRaw(src: string, dir: string | undefined, read: ReadFile, chain: string[], resolve: ResolveFlow = resolveFlowSource): RawGraph {
  const raw = new Parser(tokenize(src)).parseRaw();
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
  if (!found) throw new Error(`${here}: extends="${ext}": no graph at ${asFile ?? ext}, and no flow of that name in the pool`);
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
    fills: new Map([...(base.fills ?? [])].filter(([id]) => !removed.has(id)).concat([...(child.fills ?? [])])),
    overrides,
  };
  return variantEdits(merged, own, child.nodes, new Set(base.nodes.keys()), path.basename(baseFile).replace(/\.cast$/, "").replace(/^flow:/, ""), here);
}

/** The attributes that edit the flow a variant extends rather than describe a station. */
const VARIANT_KEYS = ["after", "before", "skip", "when", "guide", "fix"] as const;
const truthy = (v: Attr | undefined) => v === true || v === "true";
const isExit = (a: Record<string, Attr> | undefined) => !!a && shapeOf(a) === "Msquare";
const isSegmentNode = (raw: RawGraph, id: string) => typeof raw.nodes.get(id)?.flow === "string" || !!raw.fills?.has(id);
const SAYS_SUCCESS = /\boutcome\s*=\s*success\b/;
const andCondition = (c: string | undefined, more: string) => (c ? `(${c}) and ${more}` : more);

/**
 * A variant's edits written as the edges they mean, so a flow written with
 * after=, skip or when= builds (and hashes) exactly as the same flow written
 * out by hand:
 *
 *   - `n [after="a"]` takes a's passing route: a -> n, n -> (where a went)
 *     on success, and on failure the way back a uses (the edge out of a whose
 *     condition says failure and leads to a station, not an end), or `fix=`.
 *     A second station after the same one follows the first. `before="a"`
 *     takes every edge into a instead.
 *   - `s [skip=true]` sends every edge into s to where s goes when it passes,
 *     and drops whatever the skip left unreachable.
 *   - `n [when="glob, glob"]` runs n only when $change_files touches a glob:
 *     each edge into n gains `change_files touches "..."`, and a twin edge
 *     with `not change_files touches "..."` goes past it.
 *   - `guide=` on a segment's node, and `prompt=` too, go to the one station
 *     of the segment that has a prompt (applied once it is expanded).
 */
function variantEdits(raw: RawGraph, own: Map<string, Record<string, Attr>>, written: Map<string, Record<string, Attr>>, baseIds: Set<string>, baseName: string, here: string): RawGraph {
  const nodes = new Map([...raw.nodes].map(([id, a]) => [id, { ...a }]));
  let edges = [...raw.edges];
  const overrides = new Map(raw.overrides ?? []);
  const fills = new Map(raw.fills ?? []);
  const edits: FlowEditChange[] = [];
  const stations = () => [...nodes].filter(([id, a]) => !id.includes(SEGMENT_SEP) && shapeOf(a) !== "Mdiamond" && !isExit(a)).map(([id]) => id).join(", ");
  const say = (id: string, key: string, v: Attr) => `${here}: ${id} [${key}="${v}"]`;
  // A station's way on when it passes, and its ways back: an edge whose condition says failure, or a plain edge beside
  // one that says `outcome = success` (the "otherwise" of that station).
  const routesOf = (id: string) => {
    const out = edges.filter((e) => e.from === id);
    const rest = out.filter((e) => !mentionsFailure(e));
    const success = rest.filter((e) => SAYS_SUCCESS.test(e.condition ?? ""));
    const pass = success.length && success.length < rest.length ? success : rest;
    return { pass, back: out.filter((e) => !pass.includes(e)) };
  };
  const passingOut = (id: string) => routesOf(id).pass;
  const onePassTarget = (id: string, what: string): string => {
    const to = [...new Set(passingOut(id).map((e) => e.to))];
    if (to.length === 1) return to[0];
    if (!to.length) throw new Error(`${what}: ${id} has no way on when it passes, so there is nowhere to join; name a station that leads on`);
    throw new Error(`${what}: ${id} goes on to ${to.join(" and ")} when it passes, so there is no one way on; name one of them instead (before="${to[0]}")`);
  };
  const reachable = () => {
    const seen = new Set<string>();
    const queue = [...nodes].filter(([, a]) => shapeOf(a) === "Mdiamond").map(([id]) => id);
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of edges) if (e.from === id) queue.push(e.to);
    }
    return seen;
  };

  const ownOverrides = new Set([...written.keys()].filter((k) => overrides.has(k) && k.includes(SEGMENT_SEP)));
  // Guidance and prompts on a segment's node belong to the station inside it that reads a prompt.
  for (const [id, a] of own) {
    if (!isSegmentNode(raw, id) || id.includes(SEGMENT_SEP)) continue;
    const moved = Object.fromEntries((["guide", "prompt"] as const).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    if (!Object.keys(moved).length) continue;
    overrides.set(id, { ...overrides.get(id), ...moved });
    ownOverrides.add(id);
    const n = nodes.get(id)!;
    delete n.guide;
    delete n.prompt;
  }
  for (const [id, a] of written) if (a.guide !== undefined) edits.push({ op: "guide", station: id });

  // Skips first: a station placed after a skipped one has nowhere to stand.
  const before = reachable();
  const skipped: string[] = [];
  for (const [id, a] of own) {
    if (!truthy(a.skip)) continue;
    if (!baseIds.has(id)) throw new Error(`${say(id, "skip", "true")}: ${baseName} has no station ${id} to skip; its stations: ${stations()}`);
    if (a.after !== undefined || a.before !== undefined) throw new Error(`${say(id, "skip", "true")}: a station is either skipped or placed, not both`);
    const changed = [...overrides.keys()].filter((k) => k === id || k.startsWith(`${id}${SEGMENT_SEP}`));
    // A base's changes to a station this file skips go with it; this file's own are a contradiction to name.
    for (const k of changed.filter((k) => !ownOverrides.has(k))) overrides.delete(k);
    if (changed.some((k) => ownOverrides.has(k))) throw new Error(`${say(id, "skip", "true")}: this file also changes ${changed.filter((k) => ownOverrides.has(k)).join(", ")}; a skipped station runs nothing, so drop those lines or the skip`);
    const to = onePassTarget(id, say(id, "skip", "true"));
    edges = edges.filter((e) => e.from !== id).map((e) => (e.to === id ? { ...e, to } : e));
    nodes.delete(id);
    fills.delete(id);
    skipped.push(id);
    edits.push({ op: "skip", station: id });
  }
  const pruned = [...skipped];
  if (skipped.length) {
    const after = reachable();
    for (const id of before) {
      if (after.has(id) || skipped.includes(id) || !baseIds.has(id)) continue;
      nodes.delete(id);
      fills.delete(id);
      pruned.push(id);
    }
    edges = edges.filter((e) => !pruned.includes(e.from) && !pruned.includes(e.to));
  }

  // Inserts, in the order written.
  const lastAfter = new Map<string, string>();
  for (const [id, a] of own) {
    const anchorKey = a.after !== undefined ? "after" : a.before !== undefined ? "before" : null;
    if (!anchorKey) {
      if (a.fix !== undefined) throw new Error(`${say(id, "fix", a.fix)}: fix= says where a placed station's failure goes; place ${id} with after= or before=`);
      continue;
    }
    if (a.after !== undefined && a.before !== undefined) throw new Error(`${say(id, "after", a.after)}: a station goes after one station or before one, not both`);
    const anchor = String(a[anchorKey]);
    const what = say(id, anchorKey, anchor);
    if (baseIds.has(id)) throw new Error(`${what}: ${baseName} already has a station ${id}; ${anchorKey}= adds a new one, so give it a new id`);
    if (edges.some((e) => e.from === id)) throw new Error(`${what}: ${id} is placed with ${anchorKey}= and also routed here; keep one: drop its edges, or drop ${anchorKey}=`);
    if (anchor.includes(SEGMENT_SEP)) throw new Error(`${what}: ${anchor} is a step inside the ${anchor.split(SEGMENT_SEP)[0]} segment; place ${id} ${anchorKey} the segment itself (${anchorKey}="${anchor.split(SEGMENT_SEP)[0]}")`);
    if (pruned.includes(anchor)) throw new Error(`${what}: this file skips ${anchor}; place ${id} next to a station that stays`);
    if (!nodes.has(anchor) && !edges.some((e) => e.from === anchor || e.to === anchor)) throw new Error(`${what}: ${baseName} has no station ${anchor}; its stations: ${stations()}`);
    if (shapeOf(nodes.get(anchor) ?? {}) === "Mdiamond" && anchorKey === "before") throw new Error(`${what}: nothing comes before the start; place ${id} after="${anchor}"`);
    if (isExit(nodes.get(anchor)) && anchorKey === "after") throw new Error(`${what}: ${anchor} ends the flow; place ${id} before="${anchor}"`);
    // The way back a failure takes: fix=, else the anchor's own (to a station, not an end).
    let fix: string | null = null;
    if (a.fix !== undefined) {
      fix = String(a.fix);
      if (!nodes.has(fix) && !edges.some((e) => e.from === fix || e.to === fix)) throw new Error(`${say(id, "fix", fix)}: there is no station ${fix} to send a failure to; its stations: ${stations()}`);
    } else {
      const back = [...new Set(routesOf(anchor).back.filter((e) => !isExit(nodes.get(e.to))).map((e) => e.to))];
      if (back.length > 1) throw new Error(`${what}: ${anchor} fails back to ${back.join(" or ")}, so it is not clear where ${id}'s failure goes; add fix="${back[0]}"`);
      fix = back[0] ?? null;
    }
    if (anchorKey === "after") {
      const from = lastAfter.get(anchor) ?? anchor;
      const to = onePassTarget(from, what);
      const pass = new Set(passingOut(from));
      edges = edges.map((e) => (pass.has(e) ? { ...e, to: id } : e));
      edges.push({ from: id, to, condition: "outcome = success" });
      lastAfter.set(anchor, id);
    } else {
      edges = edges.map((e) => (e.to === anchor ? { ...e, to: id } : e));
      edges.push({ from: id, to: anchor, condition: "outcome = success" });
    }
    if (fix) edges.push({ from: id, to: fix, condition: "outcome = failure", label: `${String(a.label ?? id).toLowerCase()} failed` });
    edits.push({ op: "add", station: id, label: String(a.label ?? id), [anchorKey]: anchor, ...(a.fix !== undefined ? { fix: String(a.fix) } : {}) });
  }

  // Path conditions last, around the station where it now stands.
  for (const [id, a] of own) {
    if (a.when === undefined) continue;
    const paths = whenPaths(String(a.when));
    const what = say(id, "when", a.when);
    if (!paths.length) throw new Error(`${what}: name the paths the change must touch (when="src/**, docs/*.md")`);
    if (!nodes.has(id)) throw new Error(`${what}: ${baseName} has no station ${id}; its stations: ${stations()}`);
    const to = onePassTarget(id, what);
    const touches = `change_files touches ${JSON.stringify(paths.join(", "))}`;
    const into = edges.filter((e) => e.to === id && e.from !== id);
    if (!into.length) throw new Error(`${what}: nothing leads into ${id}, so there is no way past it`);
    edges = edges.flatMap((e) => (e.to === id && e.from !== id ? [{ ...e, condition: andCondition(e.condition, touches) }, { from: e.from, to, condition: andCondition(e.condition, `not ${touches}`) }] : [e]));
    edits.push({ op: "when", station: id, paths });
  }

  for (const a of nodes.values()) for (const k of VARIANT_KEYS) if (k !== "guide") delete a[k];
  return { ...raw, nodes, edges, fills, overrides, edits, pruned: [...(raw.pruned ?? []), ...pruned] };
}

/** A variant's attributes for stations inside its segments, applied once they are expanded (an override of a station that is not there is refused). */
function applyOverrides(raw: RawGraph): RawGraph {
  if (!raw.overrides?.size) return raw;
  const nodes = new Map(raw.nodes);
  const stepsOf = (top: string) => [...nodes.keys()].filter((id) => id.startsWith(`${top}${SEGMENT_SEP}`) && !nodes.get(id)!.segment_exit);
  for (const [key, attrs] of raw.overrides) {
    let id = key;
    if (!key.includes(SEGMENT_SEP)) {
      const prompted = stepsOf(key).filter((s) => typeof nodes.get(s)!.prompt === "string" && shapeOf(nodes.get(s)!) !== "parallelogram");
      const k = attrs.guide !== undefined ? "guide" : "prompt";
      if (prompted.length !== 1) {
        throw new Error(prompted.length
          ? `${raw.name}: ${key} [${k}=...]: ${key} has ${prompted.length} stations that read a prompt (${prompted.join(", ")}); name one: ${prompted[0]} [${k}=...]`
          : `${raw.name}: ${key} [${k}=...]: no station of ${key} reads a prompt (its steps: ${stepsOf(key).join(", ") || "none"}); ${k}= changes an agent's prompt`);
      }
      id = prompted[0];
    }
    const at = nodes.get(id);
    if (!at) {
      const top = key.split(SEGMENT_SEP)[0];
      const steps = stepsOf(top);
      throw new Error(steps.length
        ? `${raw.name}: ${key} [...] changes a station of the ${top} segment, which has no ${key.slice(top.length + SEGMENT_SEP.length)}; its stations: ${steps.join(", ")}`
        : `${raw.name}: ${key} [...] changes a station inside a segment, but ${top} is not a segment of this flow`);
    }
    nodes.set(id, { ...at, ...attrs });
  }
  return { ...raw, nodes, overrides: undefined };
}

/** `guide=` appended to the prompt it inherits; without inlining (where each station's file lives) the prompt stays its base's file. */
function withGuides(raw: RawGraph, read: ReadFile | null, sources: Set<string>): Array<{ node: string; text: string | null }> {
  const out: Array<{ node: string; text: string | null }> = [];
  for (const [id, a] of raw.nodes) {
    if (a.guide === undefined) continue;
    const guide = String(a.guide);
    delete a.guide;
    if (typeof a.prompt !== "string" || !a.prompt) throw new Error(`${raw.name}: ${id} [guide=...] adds to a prompt, and ${id} has none; write prompt= instead`);
    if (!read) { out.push({ node: id, text: null }); continue; }
    const text = inlineRef(guide, read, sources).replace(/\s+$/, "");
    a.prompt = `${inlineRef(a.prompt, read, sources).replace(/\s+$/, "")}\n\n${text}`;
    out.push({ node: id, text });
  }
  return out;
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
  // Last, a flow the team published, as this machine last read it from the pool.
  const team = teamFlowFile(name);
  const text = team ? read(team) : null;
  return team && text !== null ? { src: text, dir: path.dirname(team), file: team } : null;
}

const shapeOf = (a: Record<string, Attr>) => String(a.shape ?? "box");
const isStopExit = (a: Record<string, Attr>) => shapeOf(a) === "Msquare" && !!a.stop;
const mentionsFailure = (e: WorkflowEdge) => /\boutcome\s*=\s*failure\b/.test(e.condition ?? "");
const STRING_FIELDS = ["prompt", "script", "doc", "card", "stop", "goal", "guide"];
const ID_FIELDS = ["asker", "answerer", "retry_target"];

/**
 * A segment's params (`params="except above=50"`): `$except` in its stations
 * and in its edges' conditions reads the composing node's attribute, else the
 * default written after `=`, else nothing. A value lands in a script as
 * written, so it is held to words and names.
 */
function paramSubstitution(spec: Attr | undefined, given: Record<string, Attr>, who: string): (text: string) => string {
  const values = String(spec ?? "").split(/[\s,]+/).filter(Boolean).map((param) => {
    const [name, ...rest] = param.split("=");
    const value = given[name] === undefined ? rest.join("=") : String(given[name]);
    if (!/^[\w .,:@/+-]*$/.test(value)) throw new Error(`${who} ${name}="${value}" may hold only words, names and paths`);
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
  return applyOverrides({ ...raw, nodes, edges, files, fills: undefined });
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

/** An absolute `@/path` value as that file's text, its `@include` lines taken in; any other value as written. */
function inlineRef(value: string, read: ReadFile, sources: Set<string>): string {
  if (!value.startsWith("@") || !path.isAbsolute(value.slice(1))) return value;
  const file = value.slice(1);
  sources.add(file);
  return withIncludes(read(file) ?? "", file, read, sources, [file]);
}

const INCLUDE = /^@include[ \t]+(\S+)[ \t]*$/gm;

function withIncludes(text: string, file: string, read: ReadFile, sources: Set<string>, stack: string[]): string {
  return text.replace(INCLUDE, (_line, rel: string) => {
    const abs = path.resolve(path.dirname(file), rel);
    if (stack.includes(abs)) throw new Error(`${file}: @include ${rel} comes back to itself`);
    const part = read(abs);
    if (part === null) throw new Error(`${file}: @include ${rel}: no file at ${abs}`);
    sources.add(abs);
    return withIncludes(part.replace(/\n$/, ""), abs, read, sources, [...stack, abs]);
  });
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
  const gone = new Set(graph.pruned ?? []);
  const goneRef = (text: string) => [...gone].find((id) => new RegExp(`(^|[^\\w.])\\$?${id}(\\.|${SEGMENT_SEP})`).test(text));
  for (const node of graph.nodes.values()) {
    for (const f of ID_FIELDS) {
      const v = (node as unknown as Record<string, unknown>)[f];
      if (typeof v !== "string" || graph.nodes.has(v)) continue;
      const top = v.split(SEGMENT_SEP)[0];
      errors.push(gone.has(top)
        ? `${node.id} [${f}="${v}"] names ${v}, and this flow skips ${top}: point ${f} at a station that stays, or stop skipping ${top}`
        : `${node.id} [${f}="${v}"] names no station of this flow`);
    }
    for (const f of ["prompt", "script", "doc", "card", "stop"] as const) {
      const text = node[f];
      const ref = typeof text === "string" && gone.size ? goneRef(text) : undefined;
      if (ref) errors.push(`${node.id}'s ${f} reads ${ref}, and this flow skips ${ref}: change ${node.id}'s ${f}, or stop skipping ${ref}`);
    }
  }
  for (const edge of graph.edges) {
    const ref = edge.condition && gone.size ? goneRef(edge.condition.replace(/"[^"]*"/g, "")) : undefined;
    if (ref) errors.push(`Edge ${edge.from} -> ${edge.to} condition "${edge.condition}" reads ${ref}, and this flow skips ${ref}`);
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
  const { nodes, edges, sources: _sources, edits: _edits, pruned: _pruned, ...attrs } = graph;
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
