import { useMemo } from "react";
import { topoLayers, waitLabel, type TaskWait, type WaitState } from "@codecast/shared/tasks";

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

export type WaitNode = { key: string; wait: TaskWait; task: string; x: number; y: number };

/**
 * Where everything sits. Columns are the graph's topological layers
 * (graph.ts), with tasks on or behind a cycle in a last column so they still
 * draw. A task's waits stack in a lane to its left, each feeding it; a column
 * gains that lane only when one of its tasks has waits.
 */
export function planGraphLayout(tasks: Task[]) {
  const { layers, cyclic } = topoLayers(tasks);
  const cols = cyclic.length ? [...layers, cyclic] : layers;
  const waitsOf = (t: Task) => t.waits ?? [];
  const stackH = (n: number) => n * (WAIT_H + WAIT_GAP) - WAIT_GAP;
  const slotH = (t: Task) => Math.max(NODE_H, stackH(waitsOf(t).length));
  const colH = (col: Task[]) => col.reduce((h, t) => h + slotH(t), 0) + (col.length - 1) * GAP_Y;
  const maxH = Math.max(0, ...cols.map(colH));

  const positions = new Map<string, { x: number; y: number }>();
  const waitNodes: WaitNode[] = [];
  let x = PAD;
  for (const col of cols) {
    const taskX = x + (col.some((t) => waitsOf(t).length) ? WAIT_LANE : 0);
    let y = PAD + (maxH - colH(col)) / 2;
    for (const t of col) {
      const h = slotH(t);
      positions.set(t.short_id, { x: taskX, y: y + (h - NODE_H) / 2 });
      const ws = waitsOf(t);
      let wy = y + (h - stackH(ws.length)) / 2;
      for (const w of ws) {
        waitNodes.push({ key: `${t.short_id}:${w.id}`, wait: w, task: t.short_id, x, y: wy });
        wy += WAIT_H + WAIT_GAP;
      }
      y += h + GAP_Y;
    }
    x = taskX + NODE_W + GAP_X;
  }

  // Task edges, blocker -> blocked. A plan's older rows name blockers by _id.
  const shortOf = new Map(tasks.flatMap((t) => [[t.short_id, t.short_id], [t._id, t.short_id]] as const));
  const edges: { from: string; to: string }[] = [];
  for (const t of tasks) {
    for (const dep of new Set(t.blocked_by ?? [])) {
      const from = shortOf.get(dep);
      if (from && positions.has(from)) edges.push({ from, to: t.short_id });
    }
  }

  return { positions, edges, waitNodes, width: x - GAP_X + PAD, height: PAD * 2 + maxH };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 2) + "..." : s);

export function PlanGraphView({ tasks }: { tasks: Task[] }) {
  const { positions, edges, waitNodes, width, height } = useMemo(() => planGraphLayout(tasks), [tasks]);
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

        {edges.map((edge, i) => {
          const from = positions.get(edge.from)!;
          const to = positions.get(edge.to)!;
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const cx1 = x1 + GAP_X * 0.4;
          const cx2 = x2 - GAP_X * 0.4;

          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
              fill="none"
              style={{ stroke: "var(--sol-text-dim)" }}
              strokeWidth={1.5}
              strokeOpacity={0.5}
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {waitNodes.map((n) => {
          const to = positions.get(n.task)!;
          const tone = WAIT_TONE[n.wait.state] ?? WAIT_TONE.waiting;
          const label = waitLabel(n.wait, { now });
          const x1 = n.x + WAIT_W;
          const y1 = n.y + WAIT_H / 2;
          const y2 = to.y + NODE_H / 2;
          return (
            <g key={n.key}>
              <title>{n.wait.state === "waiting" ? `Waiting: ${label}` : `${label}: ${n.wait.state}${n.wait.note ? ` (${n.wait.note})` : ""}`}</title>
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
              <text x={n.x + 8} y={n.y + 12.5} fontSize={10} style={{ fill: `var(${tone})` }}>
                {clip(label, 22)}
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

          return (
            <g key={task.short_id}>
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
              />
              <text
                x={p.x + 8}
                y={p.y + 16}
                style={{ fill: text }}
                fontSize={11}
                fontFamily="monospace"
                opacity={0.6}
              >
                {task.short_id}
              </text>
              <text
                x={p.x + 8}
                y={p.y + 32}
                style={{ fill: text }}
                fontSize={11}
                fontWeight={500}
              >
                {clip(task.title, 22)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
