/**
 * The plan graph's geometry, encodings and key (docs/architecture/task-graph.md
 * TG12). Everything here is pure: where each task, wait and edge sits, how each
 * one draws, and what the key has to explain. `components/PlanGraphView.tsx`
 * renders it, and the layout test drives it from here, so the component stays a
 * Fast Refresh boundary (lib/__tests__/fastRefreshBoundaries.guard.test.ts).
 */
import { blockerGatesPickup, blockerLabel, isTerminalTaskStatus, topoLayers, waitFailedCause, waitMetLabel, type TaskWait, type TeamTaskStatus, type WaitLabelOptions, type WaitTone } from "@codecast/shared/tasks";
import { WAIT_TONE_STYLE, waitStateStyle } from "./taskBlockers";
import { STATUS_COLOR_CLASSES } from "./taskStatuses";

/** A task as the graph reads it. */
export interface PlanGraphTask {
  _id: string;
  short_id: string;
  title: string;
  status: string;
  /** The team's own status inside the category, and its team: a node draws
   *  and is named by the status every other surface shows (`taskStatusOf`). */
  status_id?: string | null;
  team_id?: string | null;
  execution_status?: string;
  blocked_by?: string[];
  waits?: TaskWait[];
}

// Each status category draws in one sol accent: a tinted fill and the accent
// as stroke. A team's own status overrides it with its own colour (`nodeStyle`).
const STATUS_TONE: Record<string, string> = {
  open: "--sol-blue",
  draft: "--sol-blue",
  backlog: "--sol-text-dim",
  in_progress: "--sol-yellow",
  in_review: "--sol-violet",
  done: "--sol-green",
  dropped: "--sol-text-dim",
};

/** What still holds a task, a wait or an open blocker: its tone and dash. */
export const HOLDING = WAIT_TONE_STYLE.waiting.token;
export const HOLDING_DASH = "3 2";
/** A task whose agent is blocked (`execution_status`): a louder dash in
 *  another colour, so it never reads as a line that is still blocking. */
export const BLOCKED_BORDER = { tone: "--sol-red", dash: "4 2", width: 2 };

export const tint = (tone: string, pct: number) => `color-mix(in srgb, var(${tone}) ${pct}%, var(--sol-card))`;

/** How a task node draws and reads: the tone of its status (the team's own
 *  colour when it set one, else its category's) and that status's name, so a
 *  "Today" task is never drawn and named as Open. `dim` is the dropped
 *  category, whose title greys out. */
export type NodeStyle = { tone: string; label: string; dim: boolean };

export function nodeStyle(s: TeamTaskStatus): NodeStyle {
  const custom = s.color ? STATUS_COLOR_CLASSES[s.color] : undefined;
  return { tone: custom?.token ?? STATUS_TONE[s.category] ?? STATUS_TONE.open, label: s.name, dim: s.category === "dropped" };
}

export const NODE_W = 216;
export const NODE_H = 44;
const GAP_X = 60;
const GAP_Y = 24;
const PAD = 32;
// Wide enough for every wait label a node can carry short of a failed wait's
// cause, which is prose and cannot be bounded (the layout test holds both
// halves), so the clip never eats the PR number or a settled wait's verb.
export const WAIT_W = 208;
export const WAIT_H = 18;
const WAIT_GAP = 4;
/** The lane a column gains when any of its tasks has waits: the wait nodes and their connector. */
const WAIT_LANE = WAIT_W + 28;
/** JetBrains Mono's advance, in em: what a label of n characters spans. */
export const CHAR_EM = 0.6;
export const TITLE_SIZE = 11;
export const WAIT_SIZE = 10;
/** How many characters fit a box `w` wide at `size`, with an 8px inset each side. */
export const fits = (w: number, size: number) => Math.floor((w - 16) / (size * CHAR_EM));

/** `inY`: where its connector enters the task, down from the task's top.
 *  `status`: the task's own, which decides whether the wait still holds it. */
export type WaitNode = { key: string; wait: TaskWait; task: string; status: string; x: number; y: number; inY: number };
/** A task edge, blocker -> blocked, as the points it passes through: out of
 *  the blocker's right side, along the gap between rows in any column it
 *  skips, into its own port on the blocked task's left side. `settled`: the
 *  blocker is closed and holds nothing. `holding`: it is open and still gates
 *  the blocked task's pickup, so it draws as a waiting wait does. */
export type PlanEdge = { from: string; to: string; settled: boolean; holding: boolean; points: { x: number; y: number }[] };

/**
 * Where everything sits. Columns are the graph's topological layers
 * (graph.ts), with tasks on or behind a cycle in a last column so they still
 * draw. A task's waits stack in a lane to its left from its mid-line down,
 * their connectors spread over its lower half; a column gains that lane only
 * when one of its tasks has waits. Task edges spread over the rest of the
 * left side (the upper half of a task with waits), ordered by where they come
 * from, so no two lines meet at one point.
 */
export function planGraphLayout(tasks: PlanGraphTask[]) {
  const { layers, cyclic } = topoLayers(tasks);
  const cols = cyclic.length ? [...layers, cyclic] : [...layers];
  // A plan's older rows name blockers by _id.
  const shortOf = new Map(tasks.flatMap((t) => [[t.short_id, t.short_id], [t._id, t.short_id]] as const));
  const blockersOf = new Map(tasks.map((t) => [t.short_id, [...new Set((t.blocked_by ?? []).map((dep) => shortOf.get(dep)))].filter((f): f is string => !!f)]));
  const dependentsOf = new Map<string, string[]>();
  for (const [to, froms] of blockersOf) for (const f of froms) dependentsOf.set(f, [...(dependentsOf.get(f) ?? []), to]);
  // Order each column by where its neighbours sit (barycenter sweeps): left
  // to right by blockers, back by dependents, then left to right again, so
  // edges between columns cross only where the graph makes them. A rank is
  // the row index from the column's middle, since columns are centred.
  const rank = new Map<string, number>();
  const colOf = new Map<string, number>();
  const rankCol = (ci: number) => cols[ci].forEach((t, i) => rank.set(t.short_id, i - (cols[ci].length - 1) / 2));
  cols.forEach((col, ci) => {
    rankCol(ci);
    for (const t of col) colOf.set(t.short_id, ci);
  });
  for (const down of [true, false, true]) {
    for (const ci of down ? [...cols.keys()] : [...cols.keys()].reverse()) {
      const key = new Map(cols[ci].map((t) => {
        const near = ((down ? blockersOf : dependentsOf).get(t.short_id) ?? []).filter((n) => (down ? colOf.get(n)! < ci : colOf.get(n)! > ci));
        return [t.short_id, near.length ? near.reduce((s, n) => s + rank.get(n)!, 0) / near.length : rank.get(t.short_id)!];
      }));
      cols[ci] = [...cols[ci]].sort((a, b) => key.get(a.short_id)! - key.get(b.short_id)!);
      rankCol(ci);
    }
  }
  // A closed task's waits are history (the task page keeps it), not lanes.
  const waitsOf = (t: PlanGraphTask) => (isTerminalTaskStatus(t.status) ? [] : t.waits ?? []);
  const stackH = (n: number) => n * (WAIT_H + WAIT_GAP) - WAIT_GAP;
  const slotH = (t: PlanGraphTask) => Math.max(NODE_H, NODE_H / 2 + stackH(waitsOf(t).length));
  const colH = (col: PlanGraphTask[]) => col.reduce((h, t) => h + slotH(t), 0) + (col.length - 1) * GAP_Y;
  const maxH = Math.max(0, ...cols.map(colH));

  const positions = new Map<string, { x: number; y: number }>();
  const waitNodes: WaitNode[] = [];
  // Each column's horizontal span and its free bands between rows, for the
  // edges that cross it without stopping.
  const spans: { left: number; right: number; gaps: [number, number][] }[] = [];
  let x = PAD;
  for (const col of cols) {
    const taskX = x + (col.some((t) => waitsOf(t).length) ? WAIT_LANE : 0);
    let y = PAD + (maxH - colH(col)) / 2;
    const gaps: [number, number][] = [[y - GAP_Y, y]];
    for (const t of col) {
      const h = slotH(t);
      positions.set(t.short_id, { x: taskX, y });
      const ws = waitsOf(t);
      let wy = y + NODE_H / 2;
      for (const [i, w] of ws.entries()) {
        const inY = NODE_H / 2 + ((i + 1) * NODE_H) / 2 / (ws.length + 1);
        waitNodes.push({ key: `${t.short_id}:${w.id}`, wait: w, task: t.short_id, status: t.status, x, y: wy, inY });
        wy += WAIT_H + WAIT_GAP;
      }
      gaps.push([y + h, y + h + GAP_Y]);
      y += h + GAP_Y;
    }
    spans.push({ left: x, right: taskX + NODE_W, gaps });
    x = taskX + NODE_W + GAP_X;
  }

  // Task edges, blocker -> blocked.
  const byShort = new Map(tasks.map((t) => [t.short_id, t]));
  const edges: PlanEdge[] = [];
  for (const t of tasks) {
    const to = positions.get(t.short_id);
    if (!to) continue;
    const froms = blockersOf.get(t.short_id)!
      .filter((f) => positions.has(f))
      .sort((a, b) => positions.get(a)!.y - positions.get(b)!.y);
    const band = waitsOf(t).length ? NODE_H / 2 : NODE_H;
    for (const [i, from] of froms.entries()) {
      const p = positions.get(from)!;
      const start = { x: p.x + NODE_W, y: p.y + NODE_H / 2 };
      const end = { x: to.x, y: to.y + ((i + 1) * band) / (froms.length + 1) };
      // Through each column it skips, along the free band nearest its line.
      const via = spans.slice(colOf.get(from)! + 1, colOf.get(t.short_id)).flatMap((c) => {
        const mid = (c.left + c.right) / 2;
        const want = start.y + ((end.y - start.y) * (mid - start.x)) / (end.x - start.x);
        const gap = c.gaps.reduce((best, g) => (Math.abs((g[0] + g[1]) / 2 - want) < Math.abs((best[0] + best[1]) / 2 - want) ? g : best));
        const y = Math.min(Math.max(want, gap[0] + 4), gap[1] - 4);
        return [{ x: c.left, y }, { x: c.right, y }];
      });
      const settled = isTerminalTaskStatus(byShort.get(from)?.status);
      edges.push({ from, to: t.short_id, settled, holding: !settled && blockerGatesPickup(t.status), points: [start, ...via, end] });
    }
  }

  return { positions, edges, waitNodes, width: x - GAP_X + PAD, height: PAD * 2 + maxH };
}

/** How an edge draws: its tone, dash and the two opacities it carries (the
 *  stroke's own, and the group's, which fades its arrowhead with it). One
 *  description, so the key's swatch cannot drift from the line it names. */
export type EdgeDraw = { tone: string; dash?: string; strokeOpacity: number; opacity: number };

export function edgeDraw(e: Pick<PlanEdge, "holding" | "settled">): EdgeDraw {
  return {
    tone: e.holding ? HOLDING : "--sol-text-dim",
    ...(e.holding ? { dash: HOLDING_DASH } : {}),
    strokeOpacity: e.holding ? 0.7 : 0.5,
    opacity: e.settled ? 0.4 : 1,
  };
}

/** What the key explains: a swatch drawn like the mark, and its words. Only
 *  the marks a graph actually makes are listed. `status` is a task node in one
 *  status's tone (the graph's loudest encoding), `line` an edge, `pill` a wait
 *  node, `node` the dashed border of a task whose agent is blocked. */
export type KeyMark =
  | { word: string; mark: "status"; tone: string }
  | { word: string; mark: "line"; draw: EdgeDraw }
  | { word: string; mark: "pill"; tone: string }
  | { word: string; mark: "node" };

/** The key in two families, which the row draws either side of a divider:
 *  `statuses` names the statuses drawn (the team's own names, Title Case),
 *  `encodings` says what the colours and dashes mean (lowercase phrases).
 *  Mixing the two in one run was the key's worst read: a noun and a phrase
 *  separated only by a gap. */
export type PlanGraphKey = { statuses: KeyMark[]; encodings: KeyMark[] };

export function planGraphKey(g: {
  edges: Pick<PlanEdge, "holding" | "settled">[];
  waitNodes: Pick<WaitNode, "wait" | "status">[];
  blocked: boolean;
  /** One per task drawn: the key names each status once, since the fill and
   *  stroke are what the eye reads first. */
  nodes?: NodeStyle[];
  /** The team's status names in the team's own order (backlog → dropped). The
   *  key sorts by it, so the legend reads the same whatever the layout did
   *  with the nodes; a name it does not list keeps its place after them. */
  statusOrder?: readonly string[];
}): PlanGraphKey {
  const seen = new Set<string>();
  const statuses: KeyMark[] = [];
  for (const n of g.nodes ?? []) {
    if (seen.has(n.label)) continue;
    seen.add(n.label);
    statuses.push({ word: n.label, mark: "status", tone: n.tone });
  }
  if (g.statusOrder?.length) {
    const at = (word: string) => {
      const i = g.statusOrder!.indexOf(word);
      return i < 0 ? g.statusOrder!.length : i;
    };
    // Stable, so two statuses sharing a name (or neither listed) keep the
    // order the nodes gave them.
    statuses.sort((a, b) => at(a.word) - at(b.word));
  }
  const line = (word: string, e: { holding: boolean; settled: boolean }): KeyMark[] =>
    g.edges.some((x) => x.holding === e.holding && x.settled === e.settled) ? [{ word, mark: "line", draw: edgeDraw(e) }] : [];
  // A wait drawn "dim" holds nothing back and says nothing in colour, so it is
  // not named here; the three live tones are. The tone and the token it draws
  // in are the one decision `waitStateStyle` makes, read once per node.
  const tones = new Map(g.waitNodes.map((n) => {
    const s = waitStateStyle(n.wait.state, n.status);
    return [s.tone, s.token] as const;
  }));
  const pill = (word: string, t: WaitTone): KeyMark[] =>
    tones.has(t) ? [{ word, mark: "pill", tone: tones.get(t)! }] : [];
  return {
    statuses,
    // The three edge words sit on one axis — what this blocker does to the
    // task it points at — so they are worded in parallel.
    encodings: [
      ...line("still blocking", { holding: true, settled: false }),
      // An open blocker into a task already being worked gates nothing (TG1),
      // so it draws as plainly as a finished one but means something else.
      ...line("still open, not blocking", { holding: false, settled: false }),
      ...line("cleared", { holding: false, settled: true }),
      ...pill("still waiting", "waiting"),
      ...pill("wait met", "met"),
      ...pill("wait failed", "failed"),
      ...(g.blocked ? [{ word: "the agent is blocked", mark: "node" } as KeyMark] : []),
    ],
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** A wait node's words: what it waits FOR, or what happened once it settled —
 *  a met one names what it was met by (a met time wait names its day, since
 *  the graph outlives the hour it passed), a failed one names its CAUSE
 *  (`waitFailedCause`, the same words the task page, the row mark and the CLI
 *  show). A failed wait keeps blocking (TG2), so the node that most needs
 *  attention cannot be the only one that does not say why.
 *
 *  A holding wait takes `blockerLabel`'s words ("PR #4213 to merge", "sd-412
 *  to be answered"), not `waitLabel`'s present tense, which for a decision
 *  and for checks is the same string a MET wait reads as: a node encodes its
 *  state in hue and in the dash on its connector, and the only place that
 *  spells it out is the SVG title, which needs a mouse. So the words
 *  themselves have to say whether the thing has happened. Clipped to the
 *  node: a cause is prose, and the node's title carries it whole. */
export function waitNodeLabel(wait: TaskWait, opts: WaitLabelOptions = {}): string {
  const label =
    wait.state === "failed" ? waitFailedCause(wait, opts)
    : wait.state === "met" ? waitMetLabel(wait, { ...opts, withDay: true })
    : blockerLabel(wait, opts);
  return clip(label, fits(WAIT_W, WAIT_SIZE));
}

/** A title over two lines broken at a word: up to `first` characters on the
 *  id's line, the rest on the line below, clipped there. A first word too
 *  long for the id's line breaks inside it rather than leave that line empty. */
export function wrapTitle(title: string, first: number, rest: number): [string, string] {
  if (title.length <= first) return [title, ""];
  const space = title.lastIndexOf(" ", first);
  const cut = space > 0 ? space : Math.max(0, first);
  return [title.slice(0, cut).trimEnd(), clip(title.slice(cut).trim(), rest)];
}

/** An edge's path: level across a column it crosses, an S-curve between. */
export function edgePath(points: PlanEdge["points"]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (const [i, b] of points.slice(1).entries()) {
    const a = points[i];
    const dx = (b.x - a.x) * 0.4;
    d += a.y === b.y ? ` L ${b.x} ${b.y}` : ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  return d;
}
