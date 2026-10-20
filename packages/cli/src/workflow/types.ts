export type NodeShape =
  | "Mdiamond"       // start
  | "Msquare"        // exit
  | "hexagon"        // human gate
  | "parallelogram"  // command/script
  | "diamond"        // conditional
  | "component"      // parallel fan-out
  | "tripleoctagon"  // parallel fan-in
  | "tab"            // prompt: a Claude Code session given one prompt
  | "note"           // call: one model call, one answer, no tools (learning-loop.md LL1)
  | "box";           // agent (default)

export type NodeType =
  | "start"
  | "exit"
  | "agent"
  | "prompt"
  | "call"
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
  // Command nodes that render the line's own text (Union's shared text from
  // _shared.md): re-made whenever the run resumes, so a resumed run reads the
  // text as it is now, never the copy in its checkpoint (line-versions.md LV4).
  refresh?: boolean;
  // Session nodes: the hand reviews the bound task (the-line.md L3). It is
  // spawned as the task's reviewer, never as the running role's hand.
  reviewer?: boolean;
  // A named agent definition (cast agent ls): client, model, effort, tools
  // and prompt. Node-level agent/model/reasoning_effort override its parts.
  definition?: string;
  temperature?: number;
  // Call nodes (learning-loop.md LL1): the answer's cap and shape, and an
  // optional system prompt. `prompt` and `model` are shared with agent nodes.
  max_tokens?: number;
  system?: string;
  output?: "json" | "text";
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
  // LE11: a built change card (card.json, $vars expand) the gate decides on.
  card?: string;
  // The station whose session asks the gate: the decision lives in that
  // session's thread (its own, when it posted one; else asked from it).
  asker?: string;
  // An exit that ends the run on purpose: the run fails with these words
  // ($vars expand) as "Stopped: ...", its task goes back to open, and nobody
  // is asked anything.
  stop?: string;
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
  // "stop": every failure of a run on this graph ends like a stop exit (task
  // open, a blocker comment saying why) instead of queueing a decision, so
  // the graph's own gates are the only questions it puts to a person.
  on_failure?: "stop";
  // The finding sources whose problems this line version runs (`serves`, one
  // graph per scenario): a line run started for a problem takes the version
  // that serves the source of its oldest finding (workflows.lineVersionFor).
  serves?: string[];
  nodes: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
  /** The files the graph was read from: its own file and every @file it inlined (parser.ts). */
  sources?: string[];
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
