import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeShape, NodeType } from "./types";
import * as fs from "fs";
import * as path from "path";

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

  parseGraph(): WorkflowGraph {
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

    const graph: WorkflowGraph = {
      name,
      nodes: new Map(),
      edges: [],
    };

    // Parse statements
    while (!this.peekIs("RBRACE") && !this.peekIs("EOF")) {
      this.parseStatement(graph);
      this.skipSemis();
    }

    this.expect("RBRACE");
    return graph;
  }

  private parseStatement(graph: WorkflowGraph) {
    const t = this.peek();

    // rankdir=LR (graph attribute shorthand)
    if (t.type === "IDENT" && t.value === "rankdir") {
      this.consume();
      this.expect("EQ");
      const val = this.consume() as any;
      graph.rankdir = val.value;
      return;
    }

    // graph [ attrs ] - graph attributes
    if (t.type === "IDENT" && t.value === "graph") {
      this.consume();
      if (this.peekIs("LBRACKET")) {
        const attrs = this.parseAttrList();
        if (attrs.goal) graph.goal = attrs.goal as string;
        if (attrs.model_stylesheet) graph.model_stylesheet = attrs.model_stylesheet as string;
        if (attrs.fidelity) graph.fidelity = attrs.fidelity as string;
        if (attrs.join_policy) graph.join_policy = attrs.join_policy as string;
      }
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
      // Node statement
      const id = ids[0];
      if (!["graph", "node", "edge", "digraph"].includes(id)) {
        const node = this.buildNode(id, attrs);
        graph.nodes.set(id, node);
      }
    } else {
      // Edge statement(s)
      for (let i = 0; i < ids.length - 1; i++) {
        const edge: WorkflowEdge = {
          from: ids[i],
          to: ids[i + 1],
          label: attrs.label as string | undefined,
          condition: attrs.condition as string | undefined,
          weight: attrs.weight as number | undefined,
          fidelity: attrs.fidelity as string | undefined,
        };
        graph.edges.push(edge);

        // Ensure nodes referenced in edges exist (as placeholder agent nodes)
        for (const id of [ids[i], ids[i + 1]]) {
          if (!graph.nodes.has(id)) {
            graph.nodes.set(id, this.buildNode(id, {}));
          }
        }
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

  private buildNode(id: string, attrs: Record<string, any>): WorkflowNode {
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
    if (attrs.backend) node.backend = attrs.backend as string;
    if (attrs.temperature !== undefined) node.temperature = attrs.temperature as number;
    if (attrs.max_visits !== undefined) node.max_visits = attrs.max_visits as number;
    if (attrs.max_retries !== undefined) node.max_retries = attrs.max_retries as number;
    if (attrs.retry_target) node.retry_target = attrs.retry_target as string;
    if (attrs.goal_gate) node.goal_gate = attrs.goal_gate as boolean;
    if (attrs.thread_id) node.thread_id = attrs.thread_id as string;
    if (attrs.fidelity) node.fidelity = attrs.fidelity as string;

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
    default: return "agent";
  }
}

// --- Public API ---

export function parseWorkflowFile(filePath: string): WorkflowGraph {
  const src = fs.readFileSync(filePath, "utf-8");
  return parseWorkflowSource(src, path.dirname(filePath));
}

export function parseWorkflowSource(src: string, dir?: string): WorkflowGraph {
  const tokens = tokenize(src);
  const parser = new Parser(tokens);
  const graph = parser.parseGraph();

  // Resolve @file references in prompts
  if (dir) {
    for (const node of graph.nodes.values()) {
      if (node.prompt?.startsWith("@")) {
        const ref = node.prompt.slice(1);
        const refPath = path.join(dir, ref);
        if (fs.existsSync(refPath)) {
          node.prompt = fs.readFileSync(refPath, "utf-8");
        }
      }
    }
  }

  return graph;
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
  }

  // Check command nodes have scripts
  for (const node of graph.nodes.values()) {
    if (node.type === "command" && !node.script) {
      errors.push(`Command node '${node.id}' has no script attribute`);
    }
    if (node.type === "agent" && !node.prompt) {
      // Warning, not error - agent might be guided by goal
    }
  }

  return errors;
}
