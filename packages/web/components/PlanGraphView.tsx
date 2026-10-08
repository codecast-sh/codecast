import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { isTerminalTaskStatus, topoLayers, waitLabel, waitLine, waitMetLabel, type TaskWait, type WaitState } from "@codecast/shared/tasks";

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

// A wait is waiting (the row's hourglass orange), met, or failed and needing a re-plan.
const WAIT_TONE: Record<WaitState, string> = {
  waiting: "--sol-orange",
  met: "--sol-green",
  failed: "--sol-red",
};

const tint = (tone: string, pct: number) => `color-mix(in srgb, var(${tone}) ${pct}%, var(--sol-card))`;

const NODE_W = 180;
const NODE_H = 44;
const GAP_X = 60;
const GAP_Y = 24;
const PAD = 32;
const WAIT_W = 128;
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

/** `inY`: where its connector enters the task, down from the task's top. */
export type WaitNode = { key: string; wait: TaskWait; task: string; x: number; y: number; inY: number };
/** A task edge, blocker -> blocked, as the points it passes through: out of
 *  the blocker's right side, along the gap between rows in any column it
 *  skips, into its own port on the blocked task's left side. `settled`: the
 *  blocker is closed and holds nothing. */
export type PlanEdge = { from: string; to: string; settled: boolean; points: { x: number; y: number }[] };

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
  const cols = cyclic.length ? [...layers, cyclic] : layers;
  const waitsOf = (t: Task) => t.waits ?? [];
  const stackH = (n: number) => n * (WAIT_H + WAIT_GAP) - WAIT_GAP;
  const slotH = (t: Task) => Math.max(NODE_H, NODE_H / 2 + stackH(waitsOf(t).length));
  const colH = (col: Task[]) => col.reduce((h, t) => h + slotH(t), 0) + (col.length - 1) * GAP_Y;
  const maxH = Math.max(0, ...cols.map(colH));

  const positions = new Map<string, { x: number; y: number }>();
  const waitNodes: WaitNode[] = [];
  // Each column's horizontal span and its free bands between rows, for the
  // edges that cross it without stopping.
  const colOf = new Map<string, number>();
  const spans: { left: number; right: number; gaps: [number, number][] }[] = [];
  let x = PAD;
  for (const [ci, col] of cols.entries()) {
    const taskX = x + (col.some((t) => waitsOf(t).length) ? WAIT_LANE : 0);
    let y = PAD + (maxH - colH(col)) / 2;
    const gaps: [number, number][] = [[y - GAP_Y, y]];
    for (const t of col) {
      const h = slotH(t);
      colOf.set(t.short_id, ci);
      positions.set(t.short_id, { x: taskX, y });
      const ws = waitsOf(t);
      let wy = y + NODE_H / 2;
      for (const [i, w] of ws.entries()) {
        const inY = NODE_H / 2 + ((i + 1) * NODE_H) / 2 / (ws.length + 1);
        waitNodes.push({ key: `${t.short_id}:${w.id}`, wait: w, task: t.short_id, x, y: wy, inY });
        wy += WAIT_H + WAIT_GAP;
      }
      gaps.push([y + h, y + h + GAP_Y]);
      y += h + GAP_Y;
    }
    spans.push({ left: x, right: taskX + NODE_W, gaps });
    x = taskX + NODE_W + GAP_X;
  }

  // Task edges, blocker -> blocked. A plan's older rows name blockers by _id.
  const byShort = new Map(tasks.map((t) => [t.short_id, t]));
  const shortOf = new Map(tasks.flatMap((t) => [[t.short_id, t.short_id], [t._id, t.short_id]] as const));
  const edges: PlanEdge[] = [];
  for (const t of tasks) {
    const to = positions.get(t.short_id);
    if (!to) continue;
    const froms = [...new Set((t.blocked_by ?? []).map((dep) => shortOf.get(dep)))]
      .filter((f): f is string => !!f && positions.has(f))
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
      edges.push({ from, to: t.short_id, settled: isTerminalTaskStatus(byShort.get(from)?.status), points: [start, ...via, end] });
    }
  }

  return { positions, edges, waitNodes, width: x - GAP_X + PAD, height: PAD * 2 + maxH };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

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
  const now = Date.now();

  if (tasks.length === 0) {
    return <div className="text-xs text-sol-text-dim text-center py-8">No tasks to visualize</div>;
  }

  return (
    <div className="overflow-auto rounded-lg border border-sol-border/15 bg-sol-bg-alt/30">
      <svg
        width={Math.max(width, 400)}
        height={Math.max(height, 200)}
        className="block"
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="8"
            markerHeight="6"
            refX="8"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 8 3, 0 6" style={{ fill: "var(--sol-text-dim)" }} />
          </marker>
        </defs>

        {/* A settled blocker's edge fades, so what holds the plan now stands out. */}
        {edges.map((edge) => (
          <path
            key={`${edge.from}>${edge.to}`}
            d={edgePath(edge.points)}
            fill="none"
            style={{ stroke: "var(--sol-text-dim)" }}
            strokeWidth={1.5}
            strokeOpacity={0.5}
            opacity={edge.settled ? 0.4 : 1}
            markerEnd="url(#arrowhead)"
          />
        ))}

        {waitNodes.map((n) => {
          const to = positions.get(n.task)!;
          const tone = WAIT_TONE[n.wait.state] ?? WAIT_TONE.waiting;
          // The node says what happened once it settled; a failed one is struck through.
          const label = n.wait.state === "met" ? waitMetLabel(n.wait, { now }) : waitLabel(n.wait, { now });
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
                strokeDasharray={n.wait.state === "waiting" ? "3 2" : undefined}
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
                {clip(label, fits(WAIT_W, WAIT_SIZE))}
              </text>
            </g>
          );
        })}

        {tasks.map(task => {
          const p = positions.get(task.short_id);
          if (!p) return null;
          const tone = STATUS_TONE[task.status] ?? STATUS_TONE.open;
          const text = task.status === "dropped" ? "var(--sol-text-dim)" : "var(--sol-text)";
          const isBlocked = task.execution_status === "blocked" || task.execution_status === "needs_context";
          const open = () => router.push(`/tasks/${task.short_id}`);

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
              className="group cursor-pointer focus:outline-none"
            >
              <title>{`${task.short_id} ${task.title}`}</title>
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
              <text
                x={p.x + 8}
                y={p.y + 16}
                style={{ fill: text }}
                fontSize={TITLE_SIZE}
                opacity={0.6}
              >
                {task.short_id}
              </text>
              <text
                x={p.x + 8}
                y={p.y + 32}
                style={{ fill: text }}
                fontSize={TITLE_SIZE}
                fontWeight={500}
              >
                {clip(task.title, fits(NODE_W, TITLE_SIZE))}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
