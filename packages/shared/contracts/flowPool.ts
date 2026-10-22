// A flow as its own stations (docs/architecture/flows.md FL2, FL6): the
// parsed graph, segments expanded, folded back so each segment reads as one
// station, in the order work first reaches each from the start, with the path
// a change takes when every station passes. The CLI's pool (`cast flow ls`,
// `cast flow show`) and the web's (the Flows view, the flow widgets) read
// flows through this one function. Pure.

/** The id prefix a segment's stations take inside the graph that uses it (parser.ts SEGMENT_SEP). */
export const SEGMENT_SEP = "__";

export type FlowNodeIn = {
  id: string;
  label: string;
  type: string;
  shape?: string;
  backend?: string;
  agent?: string;
  segment?: string;
  segment_label?: string;
  segment_flow?: string;
  segment_entry?: boolean;
  segment_exit?: "done" | "stop";
};
export type FlowEdgeIn = { from: string; to: string; label?: string; condition?: string };

export type FlowStationKind = "agent" | "script" | "person" | "segment" | "call";

export type FlowStation = {
  id: string;
  label: string;
  kind: FlowStationKind;
  /** For a segment, the flow it runs and how many stations that is. */
  flow?: string;
  steps?: number;
  /** Where it sends work: the station (or end) by label, and the words for when. */
  next: Array<{ to: string; when: string | null }>;
  /** On the path a change takes when every station passes. */
  main: boolean;
};

export type FoldedFlow = {
  stations: FlowStation[];
  /** How the flow can end, by label. */
  ends: string[];
  /** The segments it uses, by slug. */
  uses: string[];
};

/** A flow in the pool: what a picker lists and what a graph draws. */
export type PoolFlowSummary = FoldedFlow & {
  slug: string;
  kind: "line" | "segment";
  label: string;
  description: string | null;
  takes: string[];
};

export const segmentTopOf = (id: string) => id.split(SEGMENT_SEP)[0];

function kindOf(n: FlowNodeIn): FlowStationKind {
  if (n.segment_entry) return "segment";
  if (n.type === "human") return "person";
  if (n.type === "command") return "script";
  if (n.type === "call") return "call";
  return "agent";
}

/** Words for when an edge is taken: its option label, else its condition, else nothing (always). */
export function edgeWhen(e: Pick<FlowEdgeIn, "label" | "condition">): string | null {
  if (e.label) return e.label.replace(/^\[\w+\]\s*/, "").split("::")[0].trim();
  if (!e.condition) return null;
  return e.condition.replace(/\s+/g, " ").trim();
}

const PASS = /\boutcome\s*=\s*success\b|=\s*approve\b|=\s*true\b|=\s*done\b|=\s*ready\b/g;
const FAIL = /failure|!=\s*true\b|!=\s*ready\b|reject|changes|blocked|needs_context|\bnone\b|\bnot\s/g;

/** How much an edge reads as the way a passing station goes on: its condition's pass words less its fail words; a side route's own label counts against it, a gate's first option for it. */
export function passScore(e: Pick<FlowEdgeIn, "label" | "condition">): number {
  const c = e.condition ?? "";
  let score = (c.match(PASS)?.length ?? 0) - (c.match(FAIL)?.length ?? 0);
  if (e.label && /^\[\w+\]/.test(e.label)) score += /^\[(s|a|y)\]/i.test(e.label) ? 2 : -1;
  else if (e.label) score -= 2;
  return score;
}

/** The graph as its own stations: a segment's stations fold into the node that named it. */
export function foldFlow(nodes: ReadonlyArray<FlowNodeIn>, edges: ReadonlyArray<FlowEdgeIn>): FoldedFlow {
  const top = new Map<string, FlowNodeIn>();
  const steps = new Map<string, number>();
  for (const n of nodes) {
    const t = segmentTopOf(n.id);
    if (t === n.id) top.set(t, n);
    else if (!n.segment_exit && n.type !== "exit") steps.set(t, (steps.get(t) ?? 0) + 1);
  }
  const outOf = new Map<string, Array<{ to: string; when: string | null; score: number }>>();
  for (const e of edges) {
    const from = segmentTopOf(e.from);
    const to = segmentTopOf(e.to);
    if (from === to) continue;
    const list = outOf.get(from) ?? [];
    const when = edgeWhen(e);
    if (!list.some((x) => x.to === to && x.when === when)) list.push({ to, when, score: passScore(e) });
    outOf.set(from, list);
  }
  const start = [...top.values()].find((n) => n.type === "start");
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const { to } of outOf.get(id) ?? []) if (!seen.has(to)) queue.push(to);
  }
  for (const id of top.keys()) if (!seen.has(id)) order.push(id);
  // The main path: from the start, the edge a passing station takes; an end only when nothing else is left.
  const main = new Set<string>();
  const rank = (x: { to: string; score: number }) => x.score - (top.get(x.to)?.type === "exit" ? 10 : 0);
  for (let at = start?.id; at && !main.has(at); ) {
    main.add(at);
    at = [...(outOf.get(at) ?? [])].filter((x) => !main.has(x.to)).sort((a, b) => rank(b) - rank(a))[0]?.to;
  }
  const label = (id: string) => top.get(id)?.label ?? id;
  const stations: FlowStation[] = [];
  const ends: string[] = [];
  const uses = new Set<string>();
  for (const id of order) {
    const n = top.get(id);
    if (!n || n.type === "start") continue;
    if (n.type === "exit") { ends.push(n.label); continue; }
    if (n.segment_flow) uses.add(n.segment_flow);
    stations.push({
      id,
      label: n.label,
      kind: kindOf(n),
      ...(n.segment_entry ? { flow: n.segment_flow, steps: steps.get(id) ?? 0 } : {}),
      next: (outOf.get(id) ?? []).map((x) => ({ to: label(x.to), when: x.when })),
      main: main.has(id),
    });
  }
  // A stop inside a segment ends the run there: the flow's end too.
  for (const n of nodes) if (n.type === "exit" && n.segment && !ends.includes(n.label)) ends.push(n.label);
  return { stations, ends, uses: [...uses] };
}

/** A flow's main path in words: its passing stations joined by arrows, and how many sit on side routes. */
export function flowPathWords(f: Pick<FoldedFlow, "stations">): { path: string; side: number } {
  const main = f.stations.filter((s) => s.main);
  return { path: main.map((s) => s.label).join(" → "), side: f.stations.length - main.length };
}
