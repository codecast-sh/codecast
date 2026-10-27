// The team's flow library and its live flows, as `cast flow ls` and `cast flow
// show` print them (doc "Flows: library, live flows and sessions"). The
// library is a tree: the spine (the flow a live flow runs), the whole flows,
// each with the variants that extend it underneath, and the segments. A live
// flow is a flow switched on with sources feeding one queue. Pure formatters
// over the pool and the server's live flow rows; flowCommand.ts reads and prints.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { PoolFlow } from "./workflow/flowPool.js";
import type { WorkflowGraph, WorkflowNode } from "./workflow/types.js";

/** A live flow as /cli/flow/live/show returns it (convex liveFlows.ts). */
export type LiveFlow = {
  _id: string;
  flow: { id: string; slug: string; label: string | null };
  /** null: every source. */
  sources: string[] | null;
  on: boolean;
  caps?: { hands_per_day: number | null };
  hands_today?: number;
  load?: { working: number; cap: number | null };
  /** Why nothing starts right now, when that is so. */
  waiting?: string | null;
  /** The optional watcher: a role that answers the flow's asks. */
  watcher?: { role_id: string; handle: string } | null;
  running?: string[];
  /** A hold parks every new run until it ends; only a person clears one, in the browser. */
  hold?: { why: string; until: number; by?: string | null; at?: number } | null;
  /** Only problems that clear the bar start; the rest wait for another finding and close after quiet_days with none. */
  bar?: { score: number; findings: number; quiet_days: number; by?: string | null; at?: number } | null;
  queue?: Array<{ task_id: string; short_id: string; title: string; score: number | null; scored: boolean; findings: number; family: string | null; waiting: string | null }>;
};

export type LibraryNode = { flow: PoolFlow; variants: LibraryNode[] };
export type LibraryTree = { spine: LibraryNode[]; flows: LibraryNode[]; segments: LibraryNode[] };

/**
 * The pool as a tree: each variant under the flow it extends (when the pool holds it), the flows live flows run as
 * the spine, then the other whole flows, then the segments.
 */
export function libraryTree(pool: ReadonlyArray<PoolFlow>, live: ReadonlyArray<LiveFlow> = []): LibraryTree {
  const slugs = new Set(pool.map((f) => f.slug));
  const nodes = new Map(pool.map((f) => [f.slug, { flow: f, variants: [] as LibraryNode[] }]));
  const roots: LibraryNode[] = [];
  for (const f of pool) {
    const node = nodes.get(f.slug)!;
    const base = f.extends && f.extends !== f.slug && slugs.has(f.extends) ? nodes.get(f.extends)! : null;
    if (base) base.variants.push(node);
    else roots.push(node);
  }
  const spines = new Set(live.map((l) => l.flow.slug));
  return {
    spine: roots.filter((n) => spines.has(n.flow.slug)),
    flows: roots.filter((n) => !spines.has(n.flow.slug) && n.flow.kind !== "segment"),
    segments: roots.filter((n) => !spines.has(n.flow.slug) && n.flow.kind === "segment"),
  };
}

export type VariantChanges = {
  added: string[];
  removed: string[];
  /** Stations both have, with the attributes that differ. */
  changed: Array<{ station: string; fields: string[] }>;
  /** Stations whose routes out differ. */
  rerouted: string[];
  /** Graph attributes that differ, as base → variant. */
  graph: Array<{ key: string; from: string | null; to: string | null }>;
};

const STATION_FIELDS = ["label", "type", "prompt", "script", "model", "backend", "agent", "reasoning_effort", "timeout", "definition", "reviewer", "doc", "card", "max_visits", "max_retries", "goal_gate"] as const satisfies ReadonlyArray<keyof WorkflowNode>;

/** What a variant changes from the flow it extends, station by station (a segment's stations count as the segment). */
export function variantChanges(base: WorkflowGraph, variant: WorkflowGraph): VariantChanges {
  const tops = (g: WorkflowGraph) => new Set([...g.nodes.keys()].map(segmentTopOf));
  const name = (g: WorkflowGraph, id: string) => g.nodes.get(id)?.label || id;
  const b = tops(base);
  const v = tops(variant);
  const routes = (g: WorkflowGraph, id: string) => g.edges.filter((e) => segmentTopOf(e.from) === id && segmentTopOf(e.to) !== id).map((e) => `${segmentTopOf(e.to)}|${e.condition ?? ""}|${e.label ?? ""}`).sort().join("\n");
  const changed: VariantChanges["changed"] = [];
  const rerouted: string[] = [];
  for (const id of v) {
    if (!b.has(id)) continue;
    const fields = new Set<string>();
    for (const [nid, n] of variant.nodes) {
      if (segmentTopOf(nid) !== id) continue;
      const was = base.nodes.get(nid);
      if (!was) { fields.add("stations"); continue; }
      for (const k of STATION_FIELDS) if (String(n[k] ?? "") !== String(was[k] ?? "")) fields.add(k);
    }
    for (const nid of base.nodes.keys()) if (segmentTopOf(nid) === id && !variant.nodes.has(nid)) fields.add("stations");
    if (fields.size) changed.push({ station: name(variant, id), fields: [...fields] });
    if (routes(base, id) !== routes(variant, id)) rerouted.push(name(variant, id));
  }
  const graph: VariantChanges["graph"] = [];
  for (const key of ["label", "goal", "serves", "takes", "stack", "on_failure"] as const satisfies ReadonlyArray<keyof WorkflowGraph>) {
    const val = (g: WorkflowGraph) => { const x = g[key]; return x == null ? null : Array.isArray(x) ? x.join(" ") : String(x); };
    if (val(base) !== val(variant)) graph.push({ key, from: val(base), to: val(variant) });
  }
  return {
    added: [...v].filter((id) => !b.has(id)).map((id) => name(variant, id)),
    removed: [...b].filter((id) => !v.has(id)).map((id) => name(base, id)),
    changed,
    rerouted,
    graph,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line for a variant's row in the tree: "2 stations added, 3 changed, own sources". */
export function variantSummary(c: VariantChanges): string {
  const parts = [
    c.added.length ? `${plural(c.added.length, "station")} added` : "",
    c.removed.length ? `${c.removed.length} removed` : "",
    c.changed.length ? `${c.changed.length} changed` : "",
    c.rerouted.length ? `${c.rerouted.length} rerouted` : "",
    c.graph.some((g) => g.key === "serves") ? "own sources" : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

/** A variant's changes, one line each, for `cast flow show`. */
export function variantChangeLines(c: VariantChanges): string[] {
  return [
    ...c.added.map((s) => `+ ${s}`),
    ...c.removed.map((s) => `- ${s}`),
    ...c.changed.map((s) => `~ ${s.station}: ${s.fields.join(", ")}`),
    ...c.rerouted.map((s) => `→ ${s}: routes`),
    ...c.graph.map((g) => `${g.key}: ${g.from ?? "(none)"} → ${g.to ?? "(none)"}`),
  ];
}

/** Whether `name` names this live flow: its flow's slug, label or workflow id, or its own id. */
export const namesLiveFlow = (l: LiveFlow, name: string) => [l._id, l.flow.id, l.flow.slug, l.flow.label].some((x) => !!x && x === name);

/** A live flow's block: its switch, flow, sources, queue, running and watcher; `top` queue rows by name. */
export function liveFlowLines(l: LiveFlow, opts: { top: number; bold: (s: string) => string; dim: (s: string) => string }): string[] {
  const { bold, dim } = opts;
  const queue = l.queue ?? [];
  const cap = l.load?.cap;
  const hands = l.caps?.hands_per_day;
  const lines = [
    `${l.on ? "● on " : "○ off"}  ${bold(l.flow.label || l.flow.slug)}  ${dim(l.flow.slug)}`,
    `       sources  ${l.sources === null ? "every source" : l.sources.length ? l.sources.join(", ") : dim("none")}`,
    `       queue    ${queue.length ? `${queue.length}${queue.length >= 50 ? "+" : ""} waiting` : dim("empty")}`,
    `       running  ${l.load?.working ?? l.running?.length ?? 0}${cap != null ? ` of ${cap}` : ""}${hands != null ? dim(`  · ${l.hands_today ?? 0} of ${hands} sessions today`) : ""}`,
    ...(l.hold ? [`       held     until ${clock(l.hold.until)}: ${l.hold.why}${l.hold.by ? dim(`  · ${l.hold.by}`) : ""}`] : []),
    ...(l.bar ? [`       bar      score ${l.bar.score}+ or ${l.bar.findings}+ findings${dim(`  · the rest wait for another finding, ${l.bar.quiet_days} days`)}`] : []),
    ...(l.waiting ? [`       ${dim(`waiting: ${l.waiting}`)}`] : []),
    ...(l.watcher ? [`       watcher  @${l.watcher.handle}`] : []),
  ];
  for (const q of queue.slice(0, opts.top)) {
    const score = q.scored && q.score != null ? `score ${q.score}` : "unscored";
    const title = !q.title?.trim() ? dim("(no title)") : q.title.length > 90 ? `${q.title.slice(0, 89)}…` : q.title;
    lines.push(`         ${q.short_id}  ${title}  ${dim(`${score} · ${plural(q.findings, "finding")}${q.family ? ` · ${q.family}` : ""}`)}`);
  }
  // The server sends the queue's first 50 in start order, so a full page means more wait behind it.
  if (queue.length > opts.top) lines.push(dim(`         and ${queue.length - opts.top}${queue.length >= 50 ? "+" : ""} more`));
  return lines;
}

/** A time as a person reads it here: "Fri 14:30". */
const clock = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** The longest a hold may run (convex liveFlows.ts). */
export const HOLD_MAX_MS = 48 * 3_600_000;

/**
 * When a hold ends, from what a person or agent writes: a duration from now ("90m", "6h", "2d") or a date and time
 * ("2026-10-24T09:00", "2026-10-24 09:00"). An error names what it takes; the server holds the 48h limit too.
 */
export function holdUntil(raw: string, now = Date.now()): number | { error: string } {
  const d = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
  const at = d ? now + Number(d[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2].toLowerCase() as "m" | "h" | "d"] : Date.parse(raw.trim().replace(" ", "T"));
  if (!Number.isFinite(at)) return { error: `"${raw}" is not a time: give a duration (90m, 6h, 2d) or a date and time (2026-10-24T09:00)` };
  if (at <= now) return { error: `${clock(at)} has already passed` };
  if (at - now > HOLD_MAX_MS) return { error: `A hold lasts at most 48 hours; ${clock(at)} is further out` };
  return at;
}
