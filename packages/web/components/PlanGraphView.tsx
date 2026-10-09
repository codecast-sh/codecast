import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Workflow } from "lucide-react";
import { blockerGatesPickup, isTerminalTaskStatus, topoLayers, waitLabel, waitLine, waitMetLabel, waitTone, type TaskWait, type WaitLabelOptions, type WaitTone } from "@codecast/shared/tasks";
import { WAIT_TONE_STYLE } from "../lib/taskBlockers";
import { taskVisual } from "./TaskStatusBadge";
import { useCoarseNow } from "../hooks/useCoarseNow";

interface Task {
  _id: string;
  short_id: string;
  title: string;
  status: string;
  execution_status?: string;
  blocked_by?: string[];
  waits?: TaskWait[];
}

// Each status draws in one sol accent: a tinted fill and the accent as stroke.
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
const HOLDING = WAIT_TONE_STYLE.waiting.token;
const HOLDING_DASH = "3 2";

const tint = (tone: string, pct: number) => `color-mix(in srgb, var(${tone}) ${pct}%, var(--sol-card))`;

export const NODE_W = 216;
export const NODE_H = 44;
const GAP_X = 60;
const GAP_Y = 24;
const PAD = 32;
// Wide enough for every wait label a node can carry (the layout test holds
// that), so the clip never eats the PR number or a settled wait's verb.
const WAIT_W = 168;
const WAIT_H = 18;
const WAIT_GAP = 4;
/** The lane a column gains when any of its tasks has waits: the wait nodes and their connector. */
const WAIT_LANE = WAIT_W + 28;
/** JetBrains Mono's advance, in em: what a label of n characters spans. */
const CHAR_EM = 0.6;
const TITLE_SIZE = 11;
const WAIT_SIZE = 10;
/** How many characters fit a box `w` wide at `size`, with an 8px inset each side. */
const fits = (w: number, size: number) => Math.floor((w - 16) / (size * CHAR_EM));

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
export function planGraphLayout(tasks: Task[]) {
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
  const waitsOf = (t: Task) => (isTerminalTaskStatus(t.status) ? [] : t.waits ?? []);
  const stackH = (n: number) => n * (WAIT_H + WAIT_GAP) - WAIT_GAP;
  const slotH = (t: Task) => Math.max(NODE_H, NODE_H / 2 + stackH(waitsOf(t).length));
  const colH = (col: Task[]) => col.reduce((h, t) => h + slotH(t), 0) + (col.length - 1) * GAP_Y;
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
 *  the marks a graph actually makes are listed. `line` is an edge, `pill` a
 *  wait node, `node` the dashed border of a task whose agent is blocked. */
export type KeyMark =
  | { word: string; mark: "line"; draw: EdgeDraw }
  | { word: string; mark: "pill"; tone: string }
  | { word: string; mark: "node" };

export function planGraphKey(g: {
  edges: Pick<PlanEdge, "holding" | "settled">[];
  waitNodes: Pick<WaitNode, "wait" | "status">[];
  blocked: boolean;
}): KeyMark[] {
  const line = (word: string, e: { holding: boolean; settled: boolean }): KeyMark[] =>
    g.edges.some((x) => x.holding === e.holding && x.settled === e.settled) ? [{ word, mark: "line", draw: edgeDraw(e) }] : [];
  // A wait drawn "dim" (waitTone) holds nothing back and says nothing in
  // colour, so it is not named here; the three live tones are.
  const tones = new Set(g.waitNodes.map((n) => waitTone(n.wait.state, n.status)));
  const pill = (word: string, t: WaitTone): KeyMark[] =>
    tones.has(t) ? [{ word, mark: "pill", tone: WAIT_TONE_STYLE[t].token }] : [];
  return [
    ...line("still blocking", { holding: true, settled: false }),
    // An open blocker into a task already being worked gates nothing (TG1),
    // so it draws as plainly as a finished one but means something else.
    ...line("not holding it back", { holding: false, settled: false }),
    ...line("cleared", { holding: false, settled: true }),
    ...pill("still waiting", "waiting"),
    ...pill("wait met", "met"),
    ...pill("wait failed", "failed"),
    ...(g.blocked ? [{ word: "the agent is blocked", mark: "node" } as KeyMark] : []),
  ];
}

/** One key swatch, drawn with the mark's own tone, dash and opacity. */
function Swatch({ item }: { item: KeyMark }) {
  if (item.mark === "line") {
    const { tone, dash, strokeOpacity, opacity } = item.draw;
    return (
      <svg width="16" height="4" aria-hidden>
        <line x1="0" y1="2" x2="16" y2="2" style={{ stroke: `var(${tone})` }} strokeWidth={1.5} strokeDasharray={dash} strokeOpacity={strokeOpacity} opacity={opacity} />
      </svg>
    );
  }
  if (item.mark === "pill") {
    return (
      <svg width="16" height="10" aria-hidden>
        <rect x="0.5" y="0.5" width="15" height="9" rx="4.5" style={{ fill: tint(item.tone, 14), stroke: `var(${item.tone})` }} strokeWidth={1} />
      </svg>
    );
  }
  return (
    <svg width="16" height="10" aria-hidden>
      <rect x="1" y="1" width="14" height="8" rx="3" fill="none" style={{ stroke: "var(--sol-red)" }} strokeWidth={2} strokeDasharray="4 2" />
    </svg>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** A wait node's words: what it waits for, or what happened once it settled
 *  (a met time wait names its day, since the graph outlives the hour it
 *  passed), clipped to the node. */
export function waitNodeLabel(wait: TaskWait, opts: WaitLabelOptions = {}): string {
  const label = wait.state === "met" ? waitMetLabel(wait, { ...opts, withDay: true }) : waitLabel(wait, opts);
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
function edgePath(points: PlanEdge["points"]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (const [i, b] of points.slice(1).entries()) {
    const a = points[i];
    const dx = (b.x - a.x) * 0.4;
    d += a.y === b.y ? ` L ${b.x} ${b.y}` : ` C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }
  return d;
}

export function PlanGraphView({ tasks }: { tasks: Task[] }) {
  const { positions, edges, waitNodes, width, height } = useMemo(() => planGraphLayout(tasks), [tasks]);
  const router = useRouter();
  const now = useCoarseNow(60_000);

  const blockedNode = (t: Task) => t.execution_status === "blocked" || t.execution_status === "needs_context";
  const key = useMemo(() => planGraphKey({ edges, waitNodes, blocked: tasks.some(blockedNode) }), [edges, waitNodes, tasks]);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-xs text-sol-text-dim">
        <Workflow className="w-8 h-8 opacity-30" />
        This plan has no tasks yet
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-sol-border/15 bg-sol-bg-alt/30">
      {/* A key for the marks the graph makes in colour and dash alone, each
          swatch drawn exactly as the thing it names, and listed only when the
          graph actually holds one — a key for a mark nobody can see explains
          nothing. The pills and nodes carry their own words. */}
      {key.length > 0 && (
      <div className="flex items-center gap-4 flex-wrap px-3 py-1.5 border-b border-sol-border/15 text-[10px] text-sol-text-dim" data-plan-graph-key>
        {key.map((item) => (
          <span key={item.word} className="flex items-center gap-1.5">
            <Swatch item={item} />
            {item.word}
          </span>
        ))}
      </div>
      )}
      <div className="overflow-auto">
        <svg
          width={Math.max(width, 400)}
          height={Math.max(height, 200)}
          className="block"
        >
          <defs>
            {[["arrowhead", "--sol-text-dim"], ["arrowhead-holding", HOLDING]].map(([id, tone]) => (
              <marker key={id} id={id} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" style={{ fill: `var(${tone})` }} />
              </marker>
            ))}
          </defs>

          {/* An edge that still gates pickup draws as a waiting wait does; one
              into a task being worked is grey, and a settled one fades. */}
          {edges.map((edge) => {
            const draw = edgeDraw(edge);
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edgePath(edge.points)}
                fill="none"
                style={{ stroke: `var(${draw.tone})` }}
                strokeWidth={1.5}
                strokeOpacity={draw.strokeOpacity}
                strokeDasharray={draw.dash}
                opacity={draw.opacity}
                markerEnd={`url(#${edge.holding ? "arrowhead-holding" : "arrowhead"})`}
              />
            );
          })}

          {waitNodes.map((n) => {
            const to = positions.get(n.task)!;
            // Drawn as the task page and the row mark draw it: dim once it holds nothing.
            const t = waitTone(n.wait.state, n.status);
            const tone = WAIT_TONE_STYLE[t].token;
            const holding = t === "waiting";
            // The node says what happened once it settled; a failed one is struck through.
            const label = waitNodeLabel(n.wait, { now });
            const x1 = n.x + WAIT_W;
            const y1 = n.y + WAIT_H / 2;
            const y2 = to.y + n.inY;
            const title = waitLine(n.wait, { now });
            return (
              <g key={n.key}>
                <title>{title}</title>
                <path
                  d={`M ${x1} ${y1} C ${x1 + 14} ${y1}, ${to.x - 14} ${y2}, ${to.x} ${y2}`}
                  fill="none"
                  style={{ stroke: `var(${tone})` }}
                  strokeWidth={1.25}
                  strokeOpacity={0.7}
                  strokeDasharray={holding ? HOLDING_DASH : undefined}
                />
                <rect
                  x={n.x}
                  y={n.y}
                  width={WAIT_W}
                  height={WAIT_H}
                  rx={WAIT_H / 2}
                  style={{ fill: tint(tone, 14), stroke: `var(${tone})` }}
                  strokeWidth={1}
                />
                <text x={n.x + 8} y={n.y + 12.5} fontSize={WAIT_SIZE} style={{ fill: `var(${tone})` }} textDecoration={n.wait.state === "failed" ? "line-through" : undefined}>
                  {label}
                </text>
              </g>
            );
          })}

          {tasks.map(task => {
            const p = positions.get(task.short_id);
            if (!p) return null;
            const tone = STATUS_TONE[task.status] ?? STATUS_TONE.open;
            const text = task.status === "dropped" ? "var(--sol-text-dim)" : "var(--sol-text)";
            const isBlocked = blockedNode(task);
            const open = () => router.push(`/tasks/${task.short_id}`);
            const width = fits(NODE_W, TITLE_SIZE);
            const [line1, line2] = wrapTitle(task.title, width - task.short_id.length - 1, width);

            return (
              <g
                key={task.short_id}
                role="link"
                tabIndex={0}
                aria-label={`Open task ${task.short_id}: ${task.title}`}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    open();
                  }
                }}
                className="group cursor-pointer focus-visible:outline-none"
              >
                <title>{`${task.short_id} ${task.title} — ${taskVisual(task.status).label}${isBlocked ? ", blocked" : ""}`}</title>
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  style={{ fill: tint(tone, 14), stroke: isBlocked ? "var(--sol-red)" : `var(${tone})` }}
                  strokeWidth={isBlocked ? 2 : 1.5}
                  strokeDasharray={isBlocked ? "4 2" : undefined}
                  className="transition-[stroke-width] group-hover:[stroke-width:2.5] group-focus-visible:[stroke-width:2.5]"
                />
                {/* Keyboard focus: a cyan halo outside the node, so hover reads
                    as "pointable" and focus as "here you are". */}
                <rect
                  x={p.x - 3}
                  y={p.y - 3}
                  width={NODE_W + 6}
                  height={NODE_H + 6}
                  rx={9}
                  fill="none"
                  style={{ stroke: "var(--sol-cyan)" }}
                  strokeWidth={1.5}
                  className="opacity-0 group-focus-visible:opacity-100 transition-opacity pointer-events-none"
                />
                {/* The id and the title share a line; a long title goes on below. */}
                <text x={p.x + 8} y={p.y + (line2 ? 18 : 26)} style={{ fill: text }} fontSize={TITLE_SIZE}>
                  <tspan opacity={0.6}>{task.short_id}</tspan>
                  <tspan dx={TITLE_SIZE * CHAR_EM} fontWeight={500}>{line1}</tspan>
                </text>
                {line2 && (
                  <text x={p.x + 8} y={p.y + 33} style={{ fill: text }} fontSize={TITLE_SIZE} fontWeight={500}>
                    {line2}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
