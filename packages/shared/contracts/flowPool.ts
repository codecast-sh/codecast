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
  /** An exit that ends the run on purpose, in these words. */
  stop?: string;
};
export type FlowEdgeIn = { from: string; to: string; label?: string; condition?: string };

/** `parallel`: a fan-out whose branches run side by side until they join (`join`). */
export type FlowStationKind = "agent" | "script" | "person" | "segment" | "call" | "parallel" | "join";

export type FlowStation = {
  id: string;
  label: string;
  kind: FlowStationKind;
  /** For a segment, the flow it runs and how many stations that is. */
  flow?: string;
  steps?: number;
  /** Where it sends work: the station (or end) by label, and the words for when. */
  next: Array<{ to: string; toId: string; when: string | null }>;
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

/** One attribute of a DOT source's `graph [...]` line, quoted or bare, for the few a pool reads without parsing. */
export function flowGraphAttr(source: string | null | undefined, key: string): string | null {
  const m = source?.match(new RegExp(`graph\\s*\\[[^\\]]*\\b${key}\\s*=\\s*(?:"([^"]*)"|([\\w.-]+))`));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** A graph the team's pool may hold (FL2, FL5): it says what kind of flow it is, and it is no session's draft. */
export function publishableFlowSource(source: string | null | undefined): boolean {
  const kind = flowGraphAttr(source, "kind");
  return (kind === "line" || kind === "segment") && !flowGraphAttr(source, "draft");
}

function kindOf(n: FlowNodeIn): FlowStationKind {
  if (n.segment_entry) return "segment";
  if (n.type === "parallel_fanout") return "parallel";
  if (n.type === "parallel_fanin") return "join";
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
    // A fan-out runs every branch: all are on the path, and the path goes on where they join.
    if (top.get(at)?.type === "parallel_fanout") {
      const branches = (outOf.get(at) ?? []).map((x) => x.to);
      for (const b of branches) main.add(b);
      at = branches.flatMap((b) => (outOf.get(b) ?? []).map((x) => x.to)).find((t) => top.get(t)?.type === "parallel_fanin");
      continue;
    }
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
      next: (outOf.get(id) ?? []).map((x) => ({ to: label(x.to), toId: x.to, when: x.when })),
      main: main.has(id),
    });
  }
  // A stop inside a segment ends the run there: the flow's end too.
  for (const n of nodes) if (n.type === "exit" && n.segment && !ends.includes(n.label)) ends.push(n.label);
  return { stations, ends, uses: [...uses] };
}

/** A flow's main path in words: its passing stations joined by arrows, and how many sit on side routes. */
export function flowPathWords(f: Pick<FoldedFlow, "stations">): { path: string; side: number } {
  const main = f.stations.filter((s) => s.main && s.kind !== "join");
  // Branches of a fan-out read as one step, joined by "+".
  const branchOf = new Set(f.stations.filter((s) => s.kind === "parallel").flatMap((s) => s.next.map((n) => n.toId)));
  const words: string[] = [];
  for (const s of main) {
    if (branchOf.has(s.id)) continue;
    words.push(s.kind === "parallel" ? s.next.map((n) => n.to).join(" + ") : s.label);
  }
  const counted = f.stations.filter((s) => s.kind !== "join");
  return { path: words.join(" → "), side: counted.length - main.length };
}

/**
 * A flow as a person reads it: its label (the graph's `label`), else the name
 * it is keyed by. The name stays the key everywhere (run creation, line slugs,
 * each run's worktree), so only what is shown reads the label.
 */
export function flowName(f: { label?: string | null; name?: string | null; slug?: string | null }, fallback = "run"): string {
  return f.label?.trim() || f.name?.trim() || f.slug?.trim() || fallback;
}

/**
 * The library flow a flow is a variant of, by slug: the base a session save
 * named (`workflows.variant_of`), else the graph's `extends` file without its
 * `.cast`. Null for a flow that extends nothing.
 */
export function flowBase(f: { variant_of?: string | null; source?: string | null }): string | null {
  if (f.variant_of) return f.variant_of;
  const ext = flowGraphAttr(f.source, "extends");
  return ext ? ext.split("/").pop()!.replace(/\.cast$/, "") || null : null;
}

/** The span of a DOT source's first `graph [...]` list, quotes respected: [start of the list's contents, its closing bracket]. */
function graphAttrSpan(source: string): [number, number] | null {
  const m = /(^|[\s{;])graph\s*\[/m.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length;
  let quoted = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quoted) { if (ch === "\\") i++; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === "]") return [open, i];
  }
  return null;
}

/** One `key=value` pair of an attribute list, as written. */
const ATTR_RE = /([A-Za-z_][\w.-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,;\]]+)/g;

/**
 * The source with its graph attributes set (a string) or dropped (null),
 * every other byte as written. A source with no `graph [...]` gets one after
 * its opening brace. Used when a session's graph is saved to the library
 * (convex flowLibrary.save): its kind and label set, its draft mark dropped.
 */
export function withGraphAttrs(source: string, set: Record<string, string | null>): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  const span = graphAttrSpan(source);
  const pairs: Array<[string, string]> = [];
  if (span) for (const m of source.slice(span[0], span[1]).matchAll(ATTR_RE)) pairs.push([m[1], m[2]]);
  const out = pairs.filter(([k]) => !(k in set));
  for (const [k, v] of Object.entries(set)) if (v !== null) out.push([k, q(v)]);
  const list = out.map(([k, v]) => `${k}=${v}`).join(", ");
  if (span) return source.slice(0, span[0]) + list + source.slice(span[1]);
  if (!list) return source;
  const brace = source.indexOf("{");
  if (brace < 0) return source;
  return `${source.slice(0, brace + 1)}\n  graph [${list}]${source.slice(brace + 1)}`;
}
