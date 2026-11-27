// A .cast file as written (parser.ts reads it into a graph): the DOT tokenizer, the statement parser, the raw graph
// it yields, and the small readers parser.ts and variantEdits.ts share. Nothing here resolves a base or a segment.
import * as path from "path";
import type { WorkflowNode, WorkflowEdge, NodeShape, NodeType } from "./types";
import type { FlowEditChange } from "@codecast/shared/contracts/flowEdit";

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

export function tokenize(src: string): Token[] {
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

export class Parser {
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
    for (const k of ["parks", "machine", "fold"] as const) if (attrs[k] === true || attrs[k] === "true") node[k] = true;
    if (attrs.asks_if) node.asks_if = String(attrs.asks_if);
    if (attrs.refresh !== undefined) node.refresh = attrs.refresh === true || attrs.refresh === "true";
    if (attrs.reviewer !== undefined) node.reviewer = attrs.reviewer === true || attrs.reviewer === "true";
    if (attrs.temperature !== undefined) node.temperature = attrs.temperature as number;
    if (attrs.timeout !== undefined) node.timeout = Number(attrs.timeout);
    if (attrs.silent !== undefined) node.silent = Number(attrs.silent);
    if (attrs.room !== undefined && Number.isInteger(Number(attrs.room)) && Number(attrs.room) > 0) node.room = Number(attrs.room);
    if (attrs.machine_slot !== undefined) node.machine_slot = String(attrs.machine_slot);
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
    if (attrs.keep_subject === true || attrs.keep_subject === "true") node.keep_subject = true;
    if (attrs.whole_stop === true || attrs.whole_stop === "true") node.whole_stop = true;
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

export type Attr = string | number | boolean;

/** One .cast file as written (or a variant merged onto its base): nothing built or read yet. */
export interface RawGraph {
  name: string;
  attrs: Record<string, Attr>;
  /** Declared nodes only; an id an edge names without declaring it becomes an agent node when built. */
  nodes: Map<string, Record<string, Attr>>;
  edges: WorkflowEdge[];
  /** The base files a variant was read on top of. */
  files: string[];
  /** The shipped flows (by slug) this graph is built from: itself, a base it extends, a segment it runs. */
  shipped?: string[];
  /** `subgraph <node> { ... }` blocks: the steps that fill that node, by node id. */
  fills?: Map<string, RawGraph>;
  /** A variant's attributes for stations inside a segment (`review__review [...]`, or `review [guide=...]` on the segment), applied once the segment is expanded. */
  overrides?: Map<string, Record<string, Attr>>;
  /** The edits the variant made (after=, before=, skip, when=, guide=), for the words `cast flow show` prints. */
  edits?: FlowEditChange[];
  /** Base stations the variant's skips took off the path. */
  pruned?: string[];
  /** Stations that run only when the change touches their paths (when=), with those paths. */
  gated?: Record<string, string[]>;
}

/** Reads a file for the parser: absolute path in, its text or null when there is none. */
export type ReadFile = (abs: string) => string | null;

export const shapeOf = (a: Record<string, Attr>) => String(a.shape ?? "box");
export const isStopExit = (a: Record<string, Attr>) => shapeOf(a) === "Msquare" && !!a.stop;
export const mentionsFailure = (e: WorkflowEdge) => /\boutcome\s*=\s*failure\b/.test(e.condition ?? "");

/** An absolute `@/path` value as that file's text, its `@include` lines taken in; any other value as written. */
export function inlineRef(value: string, read: ReadFile, sources: Set<string>): string {
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
