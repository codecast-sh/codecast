"use client";
// The line's graph as a widget (line-workspace.md LW3): its steps in columns
// by depth, agents warm and filled, people blue, scripts ink on paper, edges
// weighted by how often runs took them, a run's path lit with its step
// numbers. This is the thin drawing the chat and a `line` fence use; the
// Graph view draws the full one (pan, zoom, essence and all steps) over the
// same model. The layout is computed once per graph.
import { memo, useMemo } from "react";
import type { LineGraphModel, LineModel, LineRunModel, ModelNode, StepKind } from "../../../lib/line/lineModel";
import { KindTag, useLineNav } from "./parts";
import { GraphMini } from "../workspace/views/graph/GraphMini";

type Box = { x: number; y: number; w: number; h: number };
type Laid = { boxes: Map<string, Box>; width: number; height: number; stageX: Array<{ label: string; x: number }> };

const SIZE: Record<StepKind, [number, number]> = { agent: [148, 46], person: [136, 40], script: [118, 30], end: [92, 26] };
const PAD = 18;
const GAP_X = 64;
const ROW_H = 66;

const laidCache = new WeakMap<LineGraphModel, Map<string, Laid>>();

/** Columns by depth, each column's steps stacked in reading order and centered. */
function layout(graph: LineGraphModel, compact: boolean): Laid {
  const key = compact ? "c" : "f";
  const hit = laidCache.get(graph)?.get(key);
  if (hit) return hit;
  const k = compact ? 0.82 : 1;
  const cols = [...new Set(graph.nodes.map((n) => n.col))].sort((a, b) => a - b);
  const byCol = new Map<number, ModelNode[]>(cols.map((c) => [c, graph.nodes.filter((n) => n.col === c)]));
  const colW = Math.max(...graph.nodes.map((n) => SIZE[n.kind][0]), 100) * k + GAP_X * k;
  const rows = Math.max(1, ...[...byCol.values()].map((l) => l.length));
  const rowH = ROW_H * k;
  const boxes = new Map<string, Box>();
  cols.forEach((c, ci) => {
    const list = byCol.get(c)!;
    list.forEach((n, ri) => {
      const [w, h] = SIZE[n.kind];
      boxes.set(n.id, { x: PAD + ci * colW + colW / 2, y: PAD + 16 + (ri + (rows - list.length) / 2) * rowH + rowH / 2, w: w * k, h: h * k });
    });
  });
  const stageX = graph.stages.map((s) => {
    const xs = s.nodes.map((id) => boxes.get(id)?.x ?? 0);
    return { label: s.label, x: xs.length ? Math.min(...xs) : 0 };
  });
  const laid = { boxes, width: PAD * 2 + cols.length * colW, height: PAD * 2 + 16 + rows * rowH + 24, stageX };
  const per = laidCache.get(graph) ?? new Map<string, Laid>();
  per.set(key, laid);
  laidCache.set(graph, per);
  return laid;
}

/** An edge's path: forward from the right side to the left side, a loop as an arc under both. */
function edgePath(a: Box, b: Box): string {
  if (b.x > a.x + 1) {
    const x1 = a.x + a.w / 2;
    const x2 = b.x - b.w / 2;
    const mx = (x1 + x2) / 2;
    return `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
  }
  const y = Math.max(a.y + a.h / 2, b.y + b.h / 2) + 26;
  return `M${a.x},${a.y + a.h / 2} C${a.x},${y} ${b.x},${y} ${b.x},${b.y + b.h / 2}`;
}

const fit = (s: string, px: number, size: number) => {
  const max = Math.max(4, Math.floor(px / (size * 0.58)));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export type LineGraphWidgetProps = {
  model: LineModel;
  /** A run whose path is lit, numbered in the order it visited. */
  run?: LineRunModel | null;
  selectedStep?: string | null;
  /** Smaller, no edge words or sublabels: for the chat and inline blocks. */
  compact?: boolean;
  /** Draw without the widget's frame (inside a view that has its own). */
  bare?: boolean;
};

export const LineGraphWidget = memo(function LineGraphWidget({ model, run, selectedStep, compact = false, bare = false }: LineGraphWidgetProps) {
  const nav = useLineNav();
  const g = model.graph;
  const laid = useMemo(() => layout(g, compact), [g, compact]);
  const maxCount = useMemo(() => Math.max(1, ...g.edges.map((e) => e.count)), [g]);
  const { hot, order } = useMemo(() => {
    const hot = new Set<string>();
    const order = new Map<string, number>();
    run?.visits.forEach((v, i) => {
      if (!order.has(v.node)) order.set(v.node, i + 1);
      const next = run.visits[i + 1];
      if (next) hot.add(`${v.node}->${next.node}`);
    });
    return { hot, order };
  }, [run]);
  const counts = useMemo(() => {
    const c: Record<StepKind, number> = { agent: 0, person: 0, script: 0, end: 0 };
    for (const n of g.nodes) c[n.kind]++;
    return c;
  }, [g]);

  const svg = (
    <svg className="lw-graph" viewBox={`0 0 ${laid.width} ${laid.height}`} role="group" aria-label={`${model.title}: ${g.nodes.length} steps`} style={compact ? { maxHeight: 260 } : { width: laid.width, maxWidth: "none" }}>
      <defs>
        <pattern id="lw-dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--lw-grid)" /></pattern>
        <marker id="lw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="var(--lw-edge)" /></marker>
        <marker id="lw-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="var(--lw-agent)" /></marker>
      </defs>
      <rect width="100%" height="100%" fill="url(#lw-dots)" />
      {!compact && laid.stageX.map((s) => <text key={s.label} className="lw-g-stage" x={s.x - 40} y={PAD + 4}>{s.label}</text>)}
      {g.edges.map((e, i) => {
        const a = laid.boxes.get(e.from);
        const b = laid.boxes.get(e.to);
        if (!a || !b) return null;
        const isHot = hot.has(e.id);
        const w = 1.1 + 2.6 * Math.sqrt(e.count / maxCount);
        return (
          <path
            key={`${e.id}#${i}`}
            className={`lw-g-edge${run && !isHot ? " lw-g-dim" : ""}`}
            data-kind={e.kind}
            data-hot={isHot ? "" : undefined}
            d={edgePath(a, b)}
            strokeWidth={isHot ? 2.4 : w}
            markerEnd={`url(#${isHot ? "lw-arrow-hot" : "lw-arrow"})`}
          >
            <title>{[e.words ?? "next", e.count ? `${e.count} ${e.count === 1 ? "time" : "times"}` : "never taken"].join(", ")}</title>
          </path>
        );
      })}
      {!compact && g.edges.filter((e) => e.words && e.kind !== "flow" && (!run || hot.has(e.id))).map((e, i) => {
        const a = laid.boxes.get(e.from);
        const b = laid.boxes.get(e.to);
        if (!a || !b) return null;
        const back = b.x <= a.x + 1;
        const x = back ? (a.x + b.x) / 2 : (a.x + a.w / 2 + b.x - b.w / 2) / 2;
        const y = back ? Math.max(a.y + a.h / 2, b.y + b.h / 2) + 22 : (a.y + b.y) / 2 - 4;
        return <text key={`l${e.id}#${i}`} className="lw-g-elabel" data-gate={e.gate ? "" : undefined} x={x} y={y} textAnchor="middle">{fit(e.words!, 150, 10.5)}</text>;
      })}
      {g.nodes.map((n) => {
        const b = laid.boxes.get(n.id)!;
        const r = n.kind === "person" ? b.h / 2 : n.kind === "script" ? 5 : n.kind === "end" ? b.h / 2 : 9;
        const sub = compact ? null : n.kind === "person" ? "you decide" : n.kind === "end" ? null : n.runs ? `${n.runs} ${n.runs === 1 ? "run" : "runs"}${n.failed ? `, ${n.failed} failed` : ""}` : "not reached";
        const onRun = order.get(n.id);
        const dim = !!run && onRun == null;
        const size = compact ? 11.5 : n.kind === "script" ? 12 : 13;
        return (
          <g
            key={n.id}
            className={`lw-g-node${dim ? " lw-g-dim" : ""}`}
            data-kind={n.kind}
            data-selected={selectedStep === n.id ? "" : undefined}
            transform={`translate(${b.x},${b.y})`}
            tabIndex={0}
            role="button"
            aria-label={`${n.label}, ${n.kind}`}
            onClick={() => nav.openStep(n.id)}
            onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); nav.openStep(n.id); } }}
            data-line-graph-node={n.id}
          >
            <rect className="lw-g-ring" x={-b.w / 2 - 4} y={-b.h / 2 - 4} width={b.w + 8} height={b.h + 8} rx={r + 4} />
            <g className="lw-g-box">
              <rect className="lw-g-shape" x={-b.w / 2} y={-b.h / 2} width={b.w} height={b.h} rx={r} />
              <text className="lw-g-t" textAnchor="middle" y={sub ? -2 : 4.5} style={{ fontSize: size }}>{fit(n.label, b.w - 14, size)}</text>
              {sub && <text className="lw-g-s" textAnchor="middle" y={12}>{sub}</text>}
            </g>
            {onRun != null && (
              <g className="lw-g-order" transform={`translate(${b.w / 2 - 4},${-b.h / 2 - 4})`}>
                <rect x={-9} y={-8} width={18} height={16} rx={5} />
                <text textAnchor="middle" y={3.5}>{onRun}</text>
              </g>
            )}
            <title>{n.label}{n.medianMs ? `, typically ${Math.round(n.medianMs / 60000)}m` : ""}</title>
          </g>
        );
      })}
    </svg>
  );

  // Compact (the chat, a `line` fence) draws the Graph view's own drawing, fitted to the column.
  const drawing = compact ? <GraphMini model={model} run={run} selectedStep={selectedStep} onOpen={nav.openStep} /> : svg;
  if (bare) return drawing;
  return (
    <div className="lw-obj" data-line-widget="graph">
      <div className="lw-obj-head">
        <span className="lw-obj-title">{model.title}</span>
        <span className="lw-spacer" />
        <span className="lw-obj-meta">{run ? `${run.caseRef ?? run.caseTitle}: ${run.visits.length} steps` : `${model.runs.length} ${model.runs.length === 1 ? "run" : "runs"}`}</span>
      </div>
      <div style={{ padding: "6px 8px 4px", overflowX: compact ? undefined : "auto" }}>{drawing}</div>
      <div className="lw-graph-legend">
        {counts.agent > 0 && <KindTag kind="agent">{counts.agent} {counts.agent === 1 ? "agent" : "agents"}, a prompt each</KindTag>}
        {counts.person > 0 && <KindTag kind="person">{counts.person} {counts.person === 1 ? "gate" : "gates"}, you decide</KindTag>}
        {counts.script > 0 && <KindTag kind="script">{counts.script} {counts.script === 1 ? "script" : "scripts"}, code</KindTag>}
      </div>
    </div>
  );
});
