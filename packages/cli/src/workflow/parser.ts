import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeShape, NodeType } from "./types";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { conditionError } from "./condition";

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
      while (i < src.length && /[a-zA-Z0-9_.$@/\-]/.test(src[i])) id += src[i++];
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
    if (attrs.refresh !== undefined) node.refresh = attrs.refresh === true || attrs.refresh === "true";
    if (attrs.reviewer !== undefined) node.reviewer = attrs.reviewer === true || attrs.reviewer === "true";
    if (attrs.temperature !== undefined) node.temperature = attrs.temperature as number;
    if (attrs.timeout !== undefined) node.timeout = Number(attrs.timeout);
    if (attrs.max_visits !== undefined) node.max_visits = attrs.max_visits as number;
    if (attrs.max_retries !== undefined) node.max_retries = attrs.max_retries as number;
    if (attrs.retry_target) node.retry_target = attrs.retry_target as string;
    if (attrs.goal_gate) node.goal_gate = attrs.goal_gate as boolean;
    if (attrs.thread_id) node.thread_id = attrs.thread_id as string;
    if (attrs.fidelity) node.fidelity = attrs.fidelity as string;
    if (attrs.doc) node.doc = String(attrs.doc);
    if (attrs.category) node.category = String(attrs.category);
    if (attrs.card) node.card = String(attrs.card);
    if (attrs.asker) node.asker = String(attrs.asker);
    if (attrs.stop) node.stop = String(attrs.stop);
    if (attrs.max_tokens !== undefined) node.max_tokens = Number(attrs.max_tokens);
    if (attrs.system) node.system = String(attrs.system);
    if (attrs.output) node.output = String(attrs.output) === "text" ? "text" : "json";

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
}

/** Reads a file for the parser: absolute path in, its text or null when there is none. */
export type ReadFile = (abs: string) => string | null;
const readDisk: ReadFile = (abs) => (fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null);

export interface ParseOptions {
  read?: ReadFile;
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
 *     never the base's.
 *
 * A prompt or script read from a file takes in a shared part at a line that is
 * only `@include <file>` (relative to the including file).
 */
export function parseWorkflowSource(src: string, dir?: string, opts: ParseOptions = {}, file?: string): WorkflowGraph {
  const read = opts.read ?? readDisk;
  const raw = loadRaw(src, dir, read, file ? [file] : []);
  const graph = buildGraph(raw);
  const sources = new Set<string>(raw.files);
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

function loadRaw(src: string, dir: string | undefined, read: ReadFile, chain: string[]): RawGraph {
  const raw = new Parser(tokenize(src)).parseRaw();
  if (dir) {
    // `@file` against the file that wrote it, so a base's stations keep reading the base's files.
    for (const attrs of raw.nodes.values()) {
      for (const field of ["prompt", "script"]) {
        const v = attrs[field];
        if (typeof v !== "string" || !v.startsWith("@")) continue;
        const abs = path.resolve(dir, v.slice(1));
        if (read(abs) !== null) attrs[field] = `@${abs}`;
      }
    }
  }
  const ext = raw.attrs.extends;
  if (ext === undefined) return raw;
  const here = chain[chain.length - 1] ?? "the graph";
  if (!dir) throw new Error(`${here}: extends="${ext}" resolves only from a graph file`);
  const baseFile = path.resolve(dir, String(ext));
  if (chain.includes(baseFile)) throw new Error(`${here}: extends="${ext}" comes back to itself`);
  const baseSrc = read(baseFile);
  if (baseSrc === null) throw new Error(`${here}: extends="${ext}": no graph at ${baseFile}`);
  const base = loadRaw(baseSrc, path.dirname(baseFile), read, [...chain, baseFile]);
  return inherit(base, raw, baseFile, here);
}

/** `child` written on top of `base` (parseWorkflowSource names the rules). */
function inherit(base: RawGraph, child: RawGraph, baseFile: string, here: string): RawGraph {
  const removed = new Set([...child.nodes].filter(([, a]) => a.removed === true || a.removed === "true").map(([id]) => id));
  for (const id of removed) if (!base.nodes.has(id)) throw new Error(`${here}: removes ${id}, which ${path.basename(baseFile)} does not have`);
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
  const nodes = new Map<string, Record<string, Attr>>();
  for (const [id, a] of base.nodes) if (!removed.has(id)) nodes.set(id, a);
  for (const [id, a] of child.nodes) if (!removed.has(id)) nodes.set(id, { ...nodes.get(id), ...a });
  // `serves` names the sources this file's own version runs, so a version never claims its base's.
  const { extends: _extends, serves: _baseServes, ...baseAttrs } = base.attrs;
  const { extends: _childExtends, ...childAttrs } = child.attrs;
  const attrs = { ...baseAttrs, ...childAttrs };
  return {
    name: child.name,
    attrs,
    nodes,
    edges: [...base.edges.filter((e) => !routed.has(e.from) && !removed.has(e.from) && !removed.has(e.to)), ...child.edges],
    files: [baseFile, ...base.files],
  };
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
  for (const [id, attrs] of raw.nodes) graph.nodes.set(id, Parser.buildNode(id, attrs));
  // Ensure nodes referenced in edges exist (as placeholder agent nodes)
  for (const e of raw.edges) for (const id of [e.from, e.to]) if (!graph.nodes.has(id)) graph.nodes.set(id, Parser.buildNode(id, {}));
  return graph;
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
  const { nodes, edges, sources: _sources, ...attrs } = graph;
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
