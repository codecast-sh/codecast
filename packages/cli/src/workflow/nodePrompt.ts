// What a node reads: its prompt with $vars expanded, the presenter brief for a
// station that presents a decision, and the model its stylesheet picks.
import type { WorkflowGraph, WorkflowNode } from "./types";
import { contextVar } from "./commandStation";
import { applyUnattended } from "../unattended.js";
import presenterBase from "./presenter.md" with { type: "text" };

// Expand $goal and context variables. Unfilled vars are removed (not left as $var).
// `$scout.output` names a prior node's result (the runner stores every
// node's output under `<id>.output`), so a chain of nodes can hand work on.
// Shared by node prompts and gate prompts and documents (the-line.md L4).
export function expandPromptVars(template: string, graph: WorkflowGraph, context: Record<string, string>): string {
  const goal = graph.goal || "";
  return template.replace(/\$(\w+(?:\.\w+)*)/g, (_, key) => {
    if (key === "goal") return goal;
    return contextVar(context, key) ?? "";
  });
}

// One $name as both expanders read it. `$human_message` is the gate note,
// empty when there is none, so a script can test it without tripping on an
// unset `$human.message` (which the shell would read as `$human`). A node's
// `$<id>.output` reads empty for the same reason when the node left none (a
// hand that never spawned).
/** The base presenting brief codecast ships (presenter.md): what a decision put to a person is, on any line. */
export const PRESENTER_BASE = presenterBase.trim();

/**
 * Whether `node` presents a decision: some human gate of its graph names it as
 * its asker (`asker=<node>`), so the decision that gate puts to a person is the
 * one this station posts. Such a station reads the base presenter first and
 * its own prompt as the line's addendum, so no graph rewrites what a decision is.
 */
export function presentsDecision(node: Pick<WorkflowNode, "id">, graph: WorkflowGraph): boolean {
  for (const n of graph.nodes.values()) if (n.type === "human" && n.asker === node.id) return true;
  return false;
}

/** Whether `node` answers questions typed at some gate of its graph (`answerer=<node>`) without presenting its decision. */
export function answersGate(node: Pick<WorkflowNode, "id">, graph: WorkflowGraph): boolean {
  for (const n of graph.nodes.values()) if (n.type === "human" && n.answerer === node.id) return true;
  return false;
}

export function buildNodePrompt(
  node: WorkflowNode,
  graph: WorkflowGraph,
  context: Record<string, string>
): string {
  const goal = graph.goal || "";
  const parts: string[] = [];

  if (goal) {
    parts.push(`# Goal\n${goal}\n`);
  }

  if (node.prompt && presentsDecision(node, graph)) {
    parts.push(`# Task: ${node.label}\n${PRESENTER_BASE}\n\n# This line\n\n${expandPromptVars(node.prompt, graph, context)}`);
  } else if (node.prompt) {
    parts.push(`# Task: ${node.label}\n${expandPromptVars(node.prompt, graph, context)}`);
  } else {
    parts.push(`# Task: ${node.label}\n${goal ? `Complete this step of the goal: ${goal}` : node.label}`);
  }

  // A question typed at the gate this station presents comes back here: the
  // decision it posts again is the answer.
  if (context["human.gate.no_card"] && presentsDecision(node, graph)) {
    parts.push(`\n# No decision of yours stands at ${context["human.gate.no_card"]}\nThe gate found no open decision of yours: an answer given to a card from an earlier visit does not carry over. Post the decision for the change as it stands. A decision of yours that is still open stands as it is, and changes through \`cast decide edit\` when its facts moved.`);
  }
  if (context["human.gate.question"] && presentsDecision(node, graph)) {
    parts.push(`\n# The person's question about your decision\n${context["human.gate.question"]}\n\nThey asked instead of choosing. Answer it in the decision you post again.`);
  } else if (context["human.gate.question"] && answersGate(node, graph)) {
    parts.push(`\n# The person's question at the card\n${context["human.gate.question"]}`);
  } else if (context["human.message"]) {
    // Surface human message prominently if present
    parts.push(`\n# Human Instructions\n${context["human.message"]}`);
  }

  // A hand receives only what its prompt names (the-line.md L3: the reviewer
  // sees the branch, the title and the criteria, nothing else). Builtin and
  // cli agents keep the context and last error appendix.
  if (node.backend === "session") return parts.join("\n");

  // Add relevant context
  const contextEntries = Object.entries(context)
    .filter(([k, _v]) => !k.endsWith(".output") && !k.endsWith(".json") && !["outcome", "last_error", "human.message", "blocked_note"].includes(k))
    .slice(0, 10);
  if (contextEntries.length > 0) {
    parts.push(`\n# Context\n${contextEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  }

  // Add last error if present
  if (context["last_error"]) {
    parts.push(`\n# Last Error\n\`\`\`\n${context["last_error"]}\n\`\`\``);
  }

  return parts.join("\n");
}

/**
 * What a session station's hand reads on its first turn: the unattended
 * opening, naming the step that started it, then the node's prompt. The runner, `cast
 * line try` and the evals all render a station through here.
 */
export function stationBrief(node: WorkflowNode, graph: WorkflowGraph, context: Record<string, string>): string {
  const run = context["run_id"] ? ` (run ${context["run_id"]})` : "";
  return applyUnattended(buildNodePrompt(node, graph, context), `the "${node.label}" step of workflow ${graph.name}${run}`);
}

export function resolveModel(node: WorkflowNode, graph: WorkflowGraph): string | undefined {
  // Node-level model takes priority
  if (node.model) return node.model;

  // Parse model_stylesheet
  if (graph.model_stylesheet) {
    const rules = parseStylesheet(graph.model_stylesheet);
    // ID selector
    const byId = rules.find(r => r.selector === `#${node.id}`);
    if (byId?.model) return byId.model;
    // Universal
    const universal = rules.find(r => r.selector === "*");
    if (universal?.model) return universal.model;
  }

  return undefined;
}

function parseStylesheet(css: string): Array<{ selector: string; model?: string; reasoning_effort?: string }> {
  const rules: Array<{ selector: string; model?: string; reasoning_effort?: string }> = [];
  const ruleRe = /([^{]+)\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    const props: Record<string, string> = {};
    for (const prop of body.split(";")) {
      const [k, v] = prop.split(":").map(s => s.trim());
      if (k && v) props[k] = v;
    }
    rules.push({ selector, model: props.model, reasoning_effort: props.reasoning_effort });
  }
  return rules;
}
