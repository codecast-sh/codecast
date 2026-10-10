// What the Replay view (line-workspace.md LW1) draws that no other view does,
// pure and tested: the line laid out as a vertical rail (the steps in reading
// order down one spine, each end beside the step that reaches it, the
// Diagnose and Fix halves as bands), how a run ended as one of the case
// list's filters, what a step could have decided, and where a run's visit is
// for a step. Everything else Replay shows is lineModel's.
import type { LineHalf, LineModel, LineRunModel, LineStep, LineVisit, StepKind } from "./lineModel";

// ── the rail ─────────────────────────────────────────────────────────────────

/** The spine's x, where a branch to an end leaves the spine, and the columns ends sit in. */
export const RAIL = { width: 372, spineX: 46, stubX: 206, endX: [226, 306], top: 22 } as const;

export type RailPoint = { x: number; y: number; h: number; end: boolean; col: number };
export type RailBand = { half: LineHalf; label: string; y1: number; y2: number };
export type RailLayout = {
  /** Steps down the spine, in reading order. */
  spine: string[];
  /** Ends drawn beside the step that reaches them. */
  ends: string[];
  at: Record<string, RailPoint>;
  /** Bookkeeping scripts: a tick on the spine, named on hover. */
  ticks: Set<string>;
  bands: RailBand[];
  height: number;
};

/** A step's row height: who decides gets room for its decision, a script less, bookkeeping a tick. */
const rowHeight = (kind: StepKind, tick: boolean) => (kind === "agent" || kind === "person" ? 54 : tick ? 16 : 30);

/** A script is bookkeeping when it only hands on: one way out, and that way is not an end. */
function isTick(step: LineStep, kindOf: (id: string) => StepKind | undefined): boolean {
  if (step.kind !== "script") return false;
  const outs = step.outcomes.filter((o) => o.kind !== "loop");
  return outs.length <= 1 && outs.every((o) => kindOf(o.to) !== "end");
}

const layoutCache = new WeakMap<object, RailLayout>();

/** The line as a rail, kept per graph value: a model rebuilt over the same graph reuses it. */
export function railLayout(model: Pick<LineModel, "graph" | "steps" | "order">): RailLayout {
  const hit = layoutCache.get(model.graph);
  if (hit) return hit;
  const kindOf = (id: string) => model.steps[id]?.kind;
  const spine = model.order.filter((id) => kindOf(id) !== "end");
  const ends = model.order.filter((id) => kindOf(id) === "end");
  const halfOf = new Map(model.graph.nodes.map((n) => [n.id, n.half]));
  const at: Record<string, RailPoint> = {};
  const ticks = new Set(spine.filter((id) => isTick(model.steps[id], kindOf)));
  const bands: RailBand[] = [];
  let y = RAIL.top;
  let half: LineHalf | null = null;
  for (const id of spine) {
    const h = halfOf.get(id) ?? model.steps[id].half;
    if (h !== half) {
      if (bands.length) bands[bands.length - 1].y2 = y + 2;
      y += half ? 22 : 12;
      bands.push({ half: h, label: h === "diagnose" ? "Diagnose" : "Fix", y1: y - 24, y2: y });
      half = h;
    }
    const rh = rowHeight(model.steps[id].kind, ticks.has(id));
    at[id] = { x: RAIL.spineX, y: y + rh / 2, h: rh, end: false, col: 0 };
    y += rh;
  }
  if (bands.length) bands[bands.length - 1].y2 = y + 8;
  // Each end sits level with the first spine step that sends work to it; a
  // second end off the same step takes the next column.
  const taken = new Map<string, number>();
  for (const id of ends) {
    const from = spine.find((s) => model.steps[s].outcomes.some((o) => o.to === id));
    const row = from ? at[from] : null;
    const col = from ? taken.get(from) ?? 0 : 0;
    if (from) taken.set(from, col + 1);
    at[id] = { x: RAIL.endX[Math.min(col, RAIL.endX.length - 1)], y: row ? row.y + (col >= RAIL.endX.length ? 12 : 0) : y + 20, h: 14, end: true, col };
  }
  const layout: RailLayout = { spine, ends, at, ticks, bands, height: y + 44 };
  layoutCache.set(model.graph, layout);
  return layout;
}

/** The path between two points of the rail: down the spine, a loop bowing left, a branch out to an end. */
export function railEdge(a: RailPoint | undefined, b: RailPoint | undefined): string | null {
  if (!a || !b) return null;
  if (!a.end && !b.end) {
    if (b.y >= a.y) return `M${a.x},${a.y} L${b.x},${b.y}`;
    const bow = Math.min(40, 18 + (a.y - b.y) / 14);
    return `M${a.x},${a.y} C${a.x - bow},${a.y} ${b.x - bow},${b.y} ${b.x},${b.y}`;
  }
  if (!a.end && b.end) {
    if (Math.abs(a.y - b.y) < 2) return `M${RAIL.stubX},${a.y} L${b.x},${b.y}`;
    return `M${RAIL.stubX},${a.y} C${RAIL.stubX + 24},${a.y} ${b.x - 10},${a.y + (b.y - a.y) / 2} ${b.x},${b.y}`;
  }
  if (a.end && !b.end) return `M${a.x},${a.y} C${a.x + 26},${a.y} ${a.x + 26},${b.y} ${RAIL.stubX},${b.y}`;
  return `M${a.x},${a.y} L${b.x},${b.y}`;
}

// ── how a run ended, as the case list filters it ─────────────────────────────

export type RunEndKind = "shipped" | "closed" | "stopped" | "running";
export const RUN_END_FILTERS: ReadonlyArray<{ key: RunEndKind; label: string }> = [
  { key: "shipped", label: "Shipped" },
  { key: "closed", label: "Closed" },
  { key: "stopped", label: "Stopped" },
  { key: "running", label: "Running" },
];

/** Which filter a run falls under: shipped, closed without a change, stopped, or still going. */
export function runEndKind(run: Pick<LineRunModel, "live" | "outcome">): RunEndKind {
  const { tone, end } = run.outcome;
  if (run.live || tone === "live" || tone === "waiting") return "running";
  if (tone === "shipped") return "shipped";
  if (tone === "failed" || tone === "stuck") return "stopped";
  if (end === "shipped") return "shipped";
  return "closed";
}

/** A run's end as its tag says it: "shipped", "dissolved", "stopped", "waiting". */
export function runEndWords(run: Pick<LineRunModel, "live" | "outcome">): string {
  const { tone, end } = run.outcome;
  if (tone === "waiting") return "waiting";
  if (run.live || tone === "live") return "running";
  if (tone === "failed" && end === "shipped") return "reopened";
  if (tone === "failed" || tone === "stuck") return "stopped";
  if (end) return end;
  return tone === "calm" ? "queued" : "closed";
}

// ── a step's decisions ───────────────────────────────────────────────────────

const GENERIC_OUTCOMES = new Set(["success", "failure"]);

/** What a step could have decided: the outcomes its branches test for, then
 *  any its decisions reported that no branch names, most used first. */
export function stepOutcomes(model: Pick<LineModel, "graph">, step: Pick<LineStep, "id" | "decisions">): string[] {
  const seen = new Map<string, number>();
  for (const e of model.graph.edges) {
    if (e.from !== step.id || !e.condition) continue;
    for (const m of e.condition.matchAll(/\boutcome\s*={1,2}\s*["']?([\w-]+)/g)) if (!GENERIC_OUTCOMES.has(m[1]) && !seen.has(m[1])) seen.set(m[1], 0);
  }
  for (const d of step.decisions) {
    const o = d.decided.outcome;
    if (o && !GENERIC_OUTCOMES.has(o)) seen.set(o, (seen.get(o) ?? 0) + 1);
  }
  const branchOrder = [...seen.keys()];
  return branchOrder.sort((a, b) => (seen.get(b)! - seen.get(a)!) || branchOrder.indexOf(a) - branchOrder.indexOf(b));
}

/** The note a "wrong" label carries: what it should have said, then why. */
export function wrongNote(should: string | null, why: string): string {
  const w = why.trim();
  if (!should) return w;
  return w ? `Should be ${should.replace(/_/g, " ")}. ${w}` : `Should be ${should.replace(/_/g, " ")}.`;
}

// ── a run's visits ───────────────────────────────────────────────────────────

/** Where a click on a step lands in a run: its next visit after the playhead,
 *  else its last before; -1 when the run never reached it. */
export function visitOf(visits: ReadonlyArray<Pick<LineVisit, "node">>, stepId: string, from: number): number {
  for (let i = from + 1; i < visits.length; i++) if (visits[i].node === stepId) return i;
  for (let i = Math.min(from, visits.length - 1); i >= 0; i--) if (visits[i].node === stepId) return i;
  return -1;
}

/** Where a run opens: the step the workspace selected, else its first agent's visit. */
export function openingVisit(visits: ReadonlyArray<Pick<LineVisit, "node" | "kind">>, stepId: string | null): number {
  if (stepId) {
    const i = visits.findIndex((v) => v.node === stepId);
    if (i >= 0) return i;
  }
  return Math.max(0, visits.findIndex((v) => v.kind === "agent"));
}

/** Each step's newest visit at or before the playhead, for the decision the rail writes under it. */
export function latestVisits(visits: ReadonlyArray<LineVisit>, upTo: number): Map<string, LineVisit> {
  const m = new Map<string, LineVisit>();
  for (let i = 0; i <= upTo && i < visits.length; i++) m.set(visits[i].node, visits[i]);
  return m;
}

/** A playback step's weight on the scrubber: who decides is wider than a script. */
export const scrubWeight = (kind: StepKind) => (kind === "agent" || kind === "person" ? 3 : 1);
