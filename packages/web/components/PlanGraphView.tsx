import { useMemo } from "react";

interface Task {
  _id: string;
  short_id: string;
  title: string;
  status: string;
  execution_status?: string;
  blocked_by?: string[];
}

const STATUS_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  open: { fill: "#1a3a5c", stroke: "#268bd2", text: "#93a1a1" },
  draft: { fill: "#1a3a5c", stroke: "#268bd2", text: "#93a1a1" },
  in_progress: { fill: "#3a3520", stroke: "#b58900", text: "#fdf6e3" },
  in_review: { fill: "#2d2640", stroke: "#6c71c4", text: "#fdf6e3" },
  done: { fill: "#1a3a20", stroke: "#859900", text: "#fdf6e3" },
  dropped: { fill: "#2a2a2a", stroke: "#586e75", text: "#657b83" },
};

const NODE_W = 180;
const NODE_H = 44;
const GAP_X = 60;
const GAP_Y = 24;
const PAD = 32;

function topoLayers(tasks: Task[]): Task[][] {
  const idSet = new Set(tasks.map(t => t.short_id));
  const docIdMap = new Map(tasks.map(t => [t._id, t.short_id]));
  const inDeg = new Map<string, number>();
  const adjOut = new Map<string, string[]>();

  for (const t of tasks) {
    inDeg.set(t.short_id, 0);
    adjOut.set(t.short_id, []);
  }

  for (const t of tasks) {
    if (!t.blocked_by) continue;
    for (const dep of t.blocked_by) {
      const resolved = idSet.has(dep) ? dep : docIdMap.get(dep);
      if (resolved && idSet.has(resolved)) {
        adjOut.get(resolved)!.push(t.short_id);
        inDeg.set(t.short_id, (inDeg.get(t.short_id) || 0) + 1);
      }
    }
  }

  const layers: Task[][] = [];
  const remaining = new Set(tasks.map(t => t.short_id));

  while (remaining.size > 0) {
    const layer = tasks.filter(
      t => remaining.has(t.short_id) && (inDeg.get(t.short_id) || 0) === 0
    );
    if (layer.length === 0) {
      layers.push(tasks.filter(t => remaining.has(t.short_id)));
      break;
    }
    layers.push(layer);
    for (const t of layer) {
      remaining.delete(t.short_id);
      for (const next of adjOut.get(t.short_id) || []) {
        inDeg.set(next, (inDeg.get(next) || 0) - 1);
      }
    }
  }

  return layers;
}

export function PlanGraphView({ tasks }: { tasks: Task[] }) {
  const { layers, positions, edges, width, height } = useMemo(() => {
    const ls = topoLayers(tasks);
    const pos = new Map<string, { x: number; y: number }>();

    let maxLayerHeight = 0;
    for (const layer of ls) {
      maxLayerHeight = Math.max(maxLayerHeight, layer.length);
    }

    for (let col = 0; col < ls.length; col++) {
      const layer = ls[col];
      const colX = PAD + col * (NODE_W + GAP_X);
      const totalH = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
      const startY = PAD + (maxLayerHeight * (NODE_H + GAP_Y) - totalH) / 2;

      for (let row = 0; row < layer.length; row++) {
        pos.set(layer[row].short_id, {
          x: colX,
          y: startY + row * (NODE_H + GAP_Y),
        });
      }
    }

    const idSet = new Set(tasks.map(t => t.short_id));
    const docIdMap = new Map(tasks.map(t => [t._id, t.short_id]));

    const edgeList: { from: string; to: string }[] = [];
    for (const t of tasks) {
      if (!t.blocked_by) continue;
      for (const dep of t.blocked_by) {
        const resolved = idSet.has(dep) ? dep : docIdMap.get(dep);
        if (resolved && pos.has(resolved) && pos.has(t.short_id)) {
          edgeList.push({ from: resolved, to: t.short_id });
        }
      }
    }

    const w = PAD * 2 + ls.length * (NODE_W + GAP_X) - GAP_X;
    const h = PAD * 2 + maxLayerHeight * (NODE_H + GAP_Y) - GAP_Y;

    return { layers: ls, positions: pos, edges: edgeList, width: w, height: h };
  }, [tasks]);

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
            <polygon points="0 0, 8 3, 0 6" fill="#586e75" />
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
              stroke="#586e75"
              strokeWidth={1.5}
              strokeOpacity={0.5}
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {tasks.map(task => {
          const p = positions.get(task.short_id);
          if (!p) return null;
          const sc = STATUS_COLORS[task.status] || STATUS_COLORS.open;
          const isBlocked = task.execution_status === "blocked" || task.execution_status === "needs_context";

          return (
            <g key={task.short_id}>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                fill={sc.fill}
                stroke={isBlocked ? "#dc322f" : sc.stroke}
                strokeWidth={isBlocked ? 2 : 1.5}
                strokeDasharray={isBlocked ? "4 2" : undefined}
              />
              <text
                x={p.x + 8}
                y={p.y + 16}
                fill={sc.text}
                fontSize={11}
                fontFamily="monospace"
                opacity={0.6}
              >
                {task.short_id}
              </text>
              <text
                x={p.x + 8}
                y={p.y + 32}
                fill={sc.text}
                fontSize={11}
                fontWeight={500}
              >
                {task.title.length > 22 ? task.title.slice(0, 20) + "..." : task.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
