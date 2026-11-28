// A graph's stations and routes as a workflows row stores them: the one
// serializer every push site uses (the-line.md L8 node fidelity). Every node
// attribute the daemon needs to run the stored graph as a local run would
// (definition, reviewer, timeout, temperature, the gate's doc and category, a
// station that parks and its room) rides here, so no push site can drop one.
import type { WorkflowGraph } from "./types.js";

export function graphNodesPayload(graph: WorkflowGraph) {
  return [...graph.nodes.values()].map((n) => ({
    id: n.id, label: n.label, shape: n.shape, type: n.type,
    ...(n.prompt ? { prompt: n.prompt } : {}),
    ...(n.script ? { script: n.script } : {}),
    ...(n.model ? { model: n.model } : {}),
    ...(n.backend ? { backend: n.backend } : {}),
    ...(n.agent ? { agent: n.agent } : {}),
    ...(n.isolated !== undefined ? { isolated: n.isolated } : {}),
    ...(n.parks ? { parks: true } : {}),
    ...(n.room !== undefined ? { room: n.room } : {}),
    ...(n.reasoning_effort ? { reasoning_effort: n.reasoning_effort } : {}),
    ...(n.max_visits !== undefined ? { max_visits: n.max_visits } : {}),
    ...(n.max_retries !== undefined ? { max_retries: n.max_retries } : {}),
    ...(n.retry_target ? { retry_target: n.retry_target } : {}),
    ...(n.goal_gate !== undefined ? { goal_gate: n.goal_gate } : {}),
    ...(n.definition ? { definition: n.definition } : {}),
    ...(n.reviewer !== undefined ? { reviewer: n.reviewer } : {}),
    ...(n.timeout !== undefined ? { timeout: n.timeout } : {}),
    ...(n.temperature !== undefined ? { temperature: n.temperature } : {}),
    ...(n.doc ? { doc: n.doc } : {}),
    ...(n.category ? { category: n.category } : {}),
    ...(n.card ? { card: n.card } : {}),
    ...(n.asker ? { asker: n.asker } : {}),
    ...(n.answerer ? { answerer: n.answerer } : {}),
    // What the server reads of a stop (convex flowStops.ts): which exits say the shared pipeline broke, and which
    // stations are a segment's exit step or bookkeeping, never the station a run resumes at.
    ...(n.shared ? { shared: n.shared } : {}),
    ...(n.resume ? { resume: n.resume } : {}),
    ...(n.segment ? { segment: n.segment } : {}),
    ...(n.segment_exit ? { segment_exit: n.segment_exit } : {}),
    ...(n.fold ? { fold: true } : {}),
    // How a run ends at an exit: a stop fails it with its words, as a run of the source would (runner.ts). Without
    // these a runner reading this copy ended every stop exit completed (ct-102797's Deploy failed under a green dot).
    ...(n.stop ? { stop: n.stop } : {}),
    ...(n.machine ? { machine: true } : {}),
    ...(n.whole_stop ? { whole_stop: true } : {}),
    ...(n.keep_subject ? { keep_subject: true } : {}),
    // A station's machine slot and where no place goes, its silence clock, its refresh on resume, and the free entries
    // its free_visit edges give it: each changes how a run of this copy goes, so each is kept.
    ...(n.machine_slot ? { machine_slot: n.machine_slot } : {}),
    ...(n.no_slot ? { no_slot: n.no_slot } : {}),
    ...(n.silent !== undefined ? { silent: n.silent } : {}),
    ...(n.refresh ? { refresh: true } : {}),
    ...(n.max_free_visits !== undefined ? { max_free_visits: n.max_free_visits } : {}),
  }));
}

export function graphEdgesPayload(graph: WorkflowGraph) {
  return graph.edges.map((e) => ({
    from: e.from, to: e.to,
    ...(e.label ? { label: e.label } : {}),
    ...(e.condition ? { condition: e.condition } : {}),
    ...(e.free_visit ? { free_visit: e.free_visit } : {}),
  }));
}
