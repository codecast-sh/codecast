"use client";
// The line map (docs/architecture/line-map.md LX2): a project's line drawn
// left to right as the path work takes, with a window's data over it. Nodes
// come from the line's definition (buildLineMap); each says what is there now
// and what passed through, and a mark says in words what is wrong. An edge's
// width is how many crossed it. Loops arc back over the path; branches that
// return sit above it and branches that leave sit below (lineMapLayout).
//
// Presentational: it paints a LineMap and reports clicks. `highlightPath`
// (map node ids in order, loops repeated) draws one item's path with the
// rest dimmed, which is how a trace (LX4) shows on the map.
import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { LineMap as LineMapModel, MapEdge, MapNode } from "../../../lib/line/lineMap";
import { edgeWidth, layoutLineMap, pathEdges, type MapLayout } from "../../../lib/line/lineMapLayout";
import { cn } from "../../../lib/utils";
import "./lineMap.css";

export type LineMapProps = {
  map: LineMapModel;
  /** Precomputed geometry, when the caller also walks it (keyboard). */
  layout?: MapLayout;
  selectedNode?: string | null;
  selectedEdge?: string | null;
  /** The keyboard cursor, when it is not on the selected node. */
  focusedNode?: string | null;
  highlightPath?: readonly string[] | null;
  /** Cards waiting on a person at the decide gate: the node asks. */
  asks?: number;
  onSelectNode?: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  className?: string;
};

const nodeSel = (id: string) => `[data-map-node="${id.replace(/"/g, '\\"')}"]`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const LineMap = memo(function LineMap({ map, layout: given, selectedNode, selectedEdge, focusedNode, highlightPath, asks = 0, onSelectNode, onSelectEdge, className }: LineMapProps) {
  const layout = useMemo(() => given ?? layoutLineMap(map), [given, map]);
  const maxCount = useMemo(() => Math.max(0, ...map.edges.map((e) => e.count)), [map.edges]);
  const byId = useMemo(() => new Map(map.nodes.map((n) => [n.id, n])), [map.nodes]);
  const tracing = !!highlightPath?.length;
  const onPath = useMemo(() => new Set(highlightPath ?? []), [highlightPath]);
  const pathHops = useMemo(() => pathEdges(highlightPath ?? []), [highlightPath]);
  const visits = useMemo(() => {
    const v = new Map<string, number>();
    for (const id of highlightPath ?? []) v.set(id, (v.get(id) ?? 0) + 1);
    return v;
  }, [highlightPath]);

  // Keep the selected or focused node in view as it moves.
  const scroller = useRef<HTMLDivElement>(null);
  const target = focusedNode ?? selectedNode ?? null;
  useEffect(() => {
    if (!target) return;
    scroller.current?.querySelector<HTMLElement>(nodeSel(target))?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [target]);
  // A trace scrolls to where its path starts.
  const first = highlightPath?.[0];
  useEffect(() => {
    if (!first) return;
    scroller.current?.querySelector<HTMLElement>(nodeSel(first))?.scrollIntoView?.({ block: "nearest", inline: "start", behavior: "smooth" });
  }, [first]);

  return (
    <div ref={scroller} className={cn("lmap-scroll", className)} data-line-map data-tracing={tracing ? "true" : undefined}>
      <div className="lmap-canvas" style={{ width: layout.width, height: layout.height }}>
        <div className="lmap-phases" aria-hidden>
          {layout.phases.map((p) => (
            <span key={p.key} className="lmap-phase" style={{ left: p.x, width: p.w }} data-map-phase={p.key}>{p.label}</span>
          ))}
        </div>

        <svg className="lmap-edges" width={layout.width} height={layout.height} aria-hidden={!onSelectEdge}>
          {map.edges.map((e) => {
            const p = layout.paths.get(e.id);
            if (!p) return null;
            const on = pathHops.has(e.id);
            const into = byId.get(e.to);
            // Motion only where it explains flow: work crossed this edge and sits where it leads.
            const flowing = !tracing && e.count > 0 && (into?.now.length ?? 0) > 0;
            const w = on ? Math.max(3, edgeWidth(e.count, maxCount)) : edgeWidth(e.count, maxCount);
            const words = edgeWords(e, byId);
            return (
              <g
                key={e.id}
                className="lmap-edge"
                data-map-edge={e.id}
                data-kind={e.kind}
                data-empty={e.count === 0 ? "true" : undefined}
                data-on={on ? "true" : undefined}
                data-selected={selectedEdge === e.id ? "true" : undefined}
                data-end={into?.end}
                onClick={onSelectEdge ? () => onSelectEdge(e.id) : undefined}
              >
                <title>{words}</title>
                <path d={p.d} className="lmap-edge-hit" />
                <path d={p.d} className="lmap-edge-line" style={{ strokeWidth: w }} />
                {flowing && <path d={p.d} className="lmap-edge-flow" style={{ animationDuration: `${Math.max(1.6, 4 - e.count * 0.2)}s` }} />}
                {p.labelAt && (e.label || (on && (pathHops.get(e.id) ?? 0) > 1)) && (
                  <text x={p.labelAt.x} y={p.labelAt.y} className="lmap-edge-label" textAnchor="middle">
                    {[e.label, on && (pathHops.get(e.id) ?? 0) > 1 ? `x${pathHops.get(e.id)}` : e.count > 0 ? String(e.count) : null].filter(Boolean).join("  ")}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {map.nodes.map((n) => {
          const b = layout.boxes.get(n.id);
          if (!b) return null;
          return (
            <MapNodeView
              key={n.id}
              node={n}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
              asks={n.kind === "decide" ? asks : 0}
              selected={selectedNode === n.id}
              focused={focusedNode === n.id}
              on={onPath.has(n.id)}
              visits={visits.get(n.id) ?? 0}
              windowLabel={map.window.label}
              onClick={onSelectNode ? () => onSelectNode(n.id) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
});

/** An edge in words, for its tooltip: where it goes and how many crossed. */
export function edgeWords(e: MapEdge, byId: Map<string, MapNode>): string {
  const from = byId.get(e.from)?.label ?? e.from;
  const to = byId.get(e.to)?.label ?? e.to;
  const how = e.kind === "loop" ? "back to" : "to";
  return `${from} ${how} ${to}${e.label ? `, when ${e.label.toLowerCase()}` : ""}: ${e.count === 0 ? "nothing crossed" : `${plural(e.count, "crossing")}`}`;
}

/** How a node is doing at a glance: what its lamp shows. */
export function nodeTone(n: MapNode, asks = 0): "fail" | "warn" | "ask" | "live" | "idle" | "info" {
  if (n.marks.some((m) => m.level === "fail")) return "fail";
  if (n.marks.some((m) => m.level === "warn")) return "warn";
  if (asks > 0) return "ask";
  if (n.now.length > 0) return "live";
  if (n.marks.length > 0) return "info";
  return "idle";
}

function MapNodeView({ node: n, style, asks, selected, focused, on, visits, windowLabel, onClick }: {
  node: MapNode;
  style: CSSProperties;
  asks: number;
  selected: boolean;
  focused: boolean;
  on: boolean;
  visits: number;
  windowLabel: string;
  onClick?: () => void;
}) {
  const tone = nodeTone(n, asks);
  const here = asks > 0 ? asks : n.now.length;
  const compact = n.kind === "source" || n.kind === "expectations";
  const mark = n.marks[0];
  const label = `${n.label}: ${here} ${asks > 0 ? "waiting on you" : "here now"}, ${n.through} through in ${windowLabel}${n.marks.length ? `. ${n.marks.map((m) => m.words).join(". ")}` : ""}`;
  return (
    <>
      <button
        type="button"
        className="lmap-node"
        style={style}
        onClick={onClick}
        aria-label={label}
        aria-pressed={selected}
        title={label}
        data-map-node={n.id}
        data-kind={n.kind}
        data-tone={tone}
        data-main={n.main ? "true" : undefined}
        data-end={n.end}
        data-selected={selected ? "true" : undefined}
        data-focused={focused ? "true" : undefined}
        data-on={on ? "true" : undefined}
        data-compact={compact ? "true" : undefined}
      >
        <span className="lmap-node-head">
          <span className="lmap-lamp" data-tone={tone} />
          <span className="lmap-node-label">{n.label}</span>
          {visits > 1 && <span className="lmap-visits" title={`${visits} visits on this path`}>x{visits}</span>}
        </span>
        {compact ? (
          <span className="lmap-node-nums">
            <span className="lmap-through" data-zero={n.through === 0 ? "true" : undefined}><b>{n.through}</b> in {windowLabel}</span>
          </span>
        ) : (
          <span className="lmap-node-nums">
            <span className="lmap-here" data-zero={here === 0 ? "true" : undefined} data-ask={asks > 0 ? "true" : undefined}>
              <b>{here}</b>{asks > 0 ? " ask" : n.kind === "end" ? "" : " here"}
            </span>
            <span className="lmap-through" data-zero={n.through === 0 ? "true" : undefined} title={`${n.through} through in the last ${windowLabel}`}>{n.through}</span>
          </span>
        )}
      </button>
      {mark && (
        <span
          className="lmap-mark"
          data-level={mark.level}
          style={{ left: (style.left as number) - 14, top: (style.top as number) + (style.height as number) + 5, width: (style.width as number) + 28 }}
          title={n.marks.map((m) => m.words).join("\n")}
          data-map-mark={n.id}
        >
          {mark.words}{n.marks.length > 1 ? ` (+${n.marks.length - 1})` : ""}
        </span>
      )}
    </>
  );
}
