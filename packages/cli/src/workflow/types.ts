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

export interface WorkflowNode {
  id: string;
  label: string;
  shape: NodeShape;
  type: NodeType;
  // Agent/prompt nodes
  prompt?: string;
  reasoning_effort?: string;
  model?: string;
  backend?: string;
  temperature?: number;
  // Command nodes
  script?: string;
  // Control flow
  max_visits?: number;
  max_retries?: number;
  retry_target?: string;
  goal_gate?: boolean;
  // Context
  thread_id?: string;
  fidelity?: string;
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
