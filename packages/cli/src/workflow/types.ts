export type NodeShape =
  | "Mdiamond"       // start
  | "Msquare"        // exit
  | "hexagon"        // human gate
  | "parallelogram"  // command/script
  | "diamond"        // conditional
  | "component"      // parallel fan-out
  | "tripleoctagon"  // parallel fan-in
  | "tab"            // prompt (single LLM call, no tools)
  | "box";           // agent (default)

export type NodeType =
  | "start"
  | "exit"
  | "agent"
  | "prompt"
  | "command"
  | "human"
  | "conditional"
  | "parallel_fanout"
  | "parallel_fanin";

// "session": a codecast session started through /cli/spawn (inbox visible,
// unattended, waited on until it settles); the client comes from `agent`.
export type AgentBackend = "builtin" | "claude" | "codex" | "tmux" | "session";

export interface WorkflowNode {
  id: string;
  label: string;
  shape: NodeShape;
  type: NodeType;
  // Agent/prompt nodes
  prompt?: string;
  reasoning_effort?: string;
  model?: string;
  backend?: AgentBackend;
  // Session nodes: the agent client (claude, codex, ...) and whether the
  // session gets its own worktree (named after the graph and the bound task).
  agent?: string;
  isolated?: boolean;
  // Session nodes: the hand reviews the bound task (the-line.md L3). It is
  // spawned as the task's reviewer, never as the running role's hand.
  reviewer?: boolean;
  // A named agent definition (cast agent ls): client, model, effort, tools
  // and prompt. Node-level agent/model/reasoning_effort override its parts.
  definition?: string;
  temperature?: number;
  // Command nodes
  script?: string;
  // Command nodes: seconds the script may run (default 120).
  timeout?: number;
  // Control flow
  max_visits?: number;
  max_retries?: number;
  retry_target?: string;
  goal_gate?: boolean;
  // Context
  thread_id?: string;
  fidelity?: string;
  // Gate nodes (the-line.md L4): the decision document body ($vars expand)
  // and the proposed decision category.
  doc?: string;
  category?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
  weight?: number;
  fidelity?: string;
}

export interface WorkflowGraph {
  name: string;
  goal?: string;
  model_stylesheet?: string;
  rankdir?: string;
  fidelity?: string;
  join_policy?: string;
  // the-line.md L4: one decision stack per run; the first gate creates it
  // and every later gate appends to it.
  stack?: string;
  nodes: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
}

export interface WorkflowRunState {
  currentNodeId: string;
  visitCounts: Record<string, number>;
  context: Record<string, string>;
  completed: string[];
  failed: boolean;
  failReason?: string;
}

export type NodeOutcome = "success" | "failure" | string;
