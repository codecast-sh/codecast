// One station of a flow as the inspector reads it (docs/architecture/flows.md
// FL6): who does it, its settings in a few words each, the words it runs, and
// every route out of it. Pure: FlowStationPanel draws it.
import { segmentTopOf, type FlowEdgeIn, type FlowNodeIn, type FlowStationKind } from "@codecast/shared/contracts/flowPool";
import { edgeWords } from "./lineModel";
import type { FlowStations } from "./flowStations";

export type StationRoute = { words: string; to: string; toId: string; ends: boolean };

export type StationView = {
  id: string;
  label: string;
  /** The segment it belongs to, by its frame's label, when it is one of a segment's steps. */
  segment: string | null;
  /** The flow of the pool a segment frame runs, by slug. */
  runsFlow: string | null;
  /** Who does it, as the diagram drew the step. */
  who: FlowStationKind;
  /** Settings in a few words each: the agent, the model, effort, limits. */
  facts: string[];
  texts: { kind: "prompt" | "system" | "script" | "doc"; text: string }[];
  routes: StationRoute[];
};

/** One station as the inspector reads it: its node, its details, and every route out of it. `who` is the kind the diagram drew. */
export function stationView(flow: { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> }, id: string, who: FlowStationKind, stations: FlowStations | undefined): StationView | null {
  const node = flow.nodes.find((n) => n.id === id);
  if (!node) return null;
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const d = stations?.[id] ?? {};
  const top = segmentTopOf(id);
  const segNode = top !== id ? byId.get(top) : null;
  const isFrame = top === id && flow.nodes.some((n) => n.id.startsWith(`${id}__`));
  const facts: string[] = [];
  const agent = d.agent ?? node.agent;
  if (who === "agent") facts.push(d.reviewer ? "Independent reviewer session" : (d.backend ?? node.backend) === "subject" ? "The session the change came from" : "Agent session");
  if (agent) facts.push(agent);
  if (d.definition) facts.push(`agent ${d.definition}`);
  if (d.model) facts.push(d.model);
  if (d.reasoning_effort) facts.push(`${d.reasoning_effort} effort`);
  if (d.isolated) facts.push("own worktree");
  if (d.timeout) facts.push(`${d.timeout}s limit`);
  const visits = d.max_visits ?? node.max_visits;
  if (visits) facts.push(`at most ${visits} ${visits === 1 ? "visit" : "visits"}`);
  if (d.max_retries) facts.push(`${d.max_retries} retries`);
  if (d.parks) facts.push("waits without a slot");
  if (d.output) facts.push(`answers ${d.output}`);
  const texts: StationView["texts"] = [];
  if (d.system) texts.push({ kind: "system", text: d.system });
  if (d.prompt) texts.push({ kind: "prompt", text: d.prompt });
  if (d.script) texts.push({ kind: "script", text: d.script });
  if (d.doc) texts.push({ kind: "doc", text: d.doc });
  // A segment frame's routes leave from its steps; a step's from itself.
  const leaves = (from: string) => (isFrame ? segmentTopOf(from) === id : from === id);
  const routes: StationRoute[] = flow.edges
    .filter((e) => leaves(e.from) && !leaves(e.to))
    .map((e) => {
      const target = byId.get(e.to);
      const toTop = byId.get(segmentTopOf(e.to));
      const ends = target?.type === "exit" || !!target?.segment_exit;
      const to = ends && target?.stop ? target.label : toTop && toTop.id !== e.to && toTop.label !== target?.label ? `${toTop.label}: ${target?.label ?? e.to}` : target?.label ?? e.to;
      return { words: edgeWords(e) ?? "next", to, toId: e.to, ends };
    });
  const seen = new Set<string>();
  return {
    id,
    label: node.label,
    segment: segNode ? segNode.label : null,
    runsFlow: isFrame ? node.segment_flow ?? null : null,
    who,
    facts,
    texts,
    routes: routes.filter((r) => (seen.has(`${r.words}|${r.to}`) ? false : (seen.add(`${r.words}|${r.to}`), true))),
  };
}
