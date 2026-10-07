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
import { EdgeArrows } from "../EdgeArrows";
import { edgeAttrs, useScrollEdges } from "../useScrollEdges";
import "../line.css";
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
  /** The node the map opens on: scrolled into view on first paint, a little
   *  left of center so the line past it shows too (the busiest node, LX2). */
  openAt?: string | null;
  /** Cards waiting on a person at the decide gate: the node asks. */
  asks?: number;
  onSelectNode?: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  className?: string;
};

const nodeSel = (id: string) => `[data-map-node="${id.replace(/"/g, '\\"')}"]`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const LineMap = memo(function LineMap({ map, layout: given, selectedNode, selectedEdge, focusedNode, highlightPath, openAt, asks = 0, onSelectNode, onSelectEdge, className }: LineMapProps) {
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

  const scroller = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scroller);
  // On open, the busiest node in view with room on both sides; once only, so
  // the viewer's own scrolling is never undone. A selection or a trace scrolls
  // by its own effect below.
  const placed = useRef(false);
  useEffect(() => {
    const el = scroller.current;
    if (placed.current || !el || !openAt) return;
    placed.current = true;
    if (selectedNode || highlightPath?.length || el.scrollLeft > 0) return;
    const node = el.querySelector<HTMLElement>(nodeSel(openAt));
    if (!node) return;
    const box = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    el.scrollTo({ left: el.scrollLeft + (r.left + r.width / 2) - (box.left + box.width * 0.42), top: 0 });
  }, [openAt, selectedNode, highlightPath]);
  // Keep the selected or focused node in view as it moves, and again when the
  // map's column narrows (a panel opening beside it), so the node a panel
  // describes is never the one hidden behind its edge (LX3).
  const target = focusedNode ?? selectedNode ?? null;
  useEffect(() => {
    const el = scroller.current;
    if (!target || !el) return;
    keepInView(el, target, "smooth");
    if (typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth < w) keepInView(el, target, "auto");
      w = el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [target]);
  // A trace scrolls to where its path starts.
  const first = highlightPath?.[0];
  useEffect(() => {
    if (!first) return;
    scroller.current?.querySelector<HTMLElement>(nodeSel(first))?.scrollIntoView?.({ block: "nearest", inline: "start", behavior: "smooth" });
  }, [first]);

  return (
    <div className={cn("lmap-frame", className)} data-line-map data-tracing={tracing ? "true" : undefined}>
    <div ref={scroller} className="lmap-scroll line-edge-fade" {...edgeAttrs(edges)}>
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
    <EdgeArrows scroller={scroller} edges={edges} label="the line" />
    </div>
  );
});

/** Scroll `el` the least that shows node `id` whole, clear of the faded
 *  edges. Rects and scrollTo, not scrollIntoView, so the page never moves. */
function keepInView(el: HTMLElement, id: string, behavior: ScrollBehavior) {
  const node = el.querySelector<HTMLElement>(nodeSel(id));
  if (!node) return;
  const box = el.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const clear = Math.min(64, box.width / 6);
  let dx = 0;
  if (r.left < box.left + clear) dx = r.left - box.left - clear;
  else if (r.right > box.right - clear) dx = r.right - box.right + clear;
  let dy = 0;
  if (r.top < box.top + 8) dy = r.top - box.top - 8;
  else if (r.bottom > box.bottom - 8) dy = r.bottom - box.bottom + 8;
  if (dx || dy) el.scrollTo({ left: el.scrollLeft + dx, top: el.scrollTop + dy, behavior });
}

/** An edge in words, for its tooltip: where it goes and how many crossed. */
export function edgeWords(e: MapEdge, byId: Map<string, MapNode>): string {
  const from = byId.get(e.from)?.label ?? e.from;
  const to = byId.get(e.to)?.label ?? e.to;
  const how = e.kind === "loop" ? "back to" : "to";
  return `${from} ${how} ${to}${e.label ? `, when ${e.label.toLowerCase()}` : ""}: ${e.count === 0 ? "nothing crossed" : `${plural(e.count, "crossing")}`}`;
}

/** What the window's count means at a node: signals are filed, causes are
 *  new, an end is where runs ended, and a station is passed through. */
export function throughWord(n: Pick<MapNode, "kind">): string {
  if (n.kind === "source" || n.kind === "signals" || n.kind === "expectations") return "filed";
  if (n.kind === "causes") return "new";
  if (n.kind === "end") return "ended";
  return "passed";
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
  const compact = n.kind === "source" || n.kind === "expectations" || n.kind === "end";
  const mark = n.marks[0];
  const passed = `${n.through} ${throughWord(n)}`;
  const empty = here === 0 && n.through === 0;
  const label = `${n.label}: ${empty ? "empty" : `${here > 0 ? `${here} ${asks > 0 ? "waiting on you" : "here now"}, ` : ""}${passed} in the last ${windowLabel}`}${n.marks.length ? `. ${n.marks.map((m) => m.words).join(". ")}` : ""}`;
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
        data-empty={empty ? "true" : undefined}
      >
        <span className="lmap-node-head">
          <span className="lmap-lamp" data-tone={tone} />
          <span className="lmap-node-label">{n.label}</span>
          {visits > 1 && <span className="lmap-visits" title={`${visits} visits on this path`}>x{visits}</span>}
        </span>
        {/* One reading per node: what is here now as the big number (only when
            something is), what passed in the window as small labeled words,
            and an empty node says so instead of drawing zeros (LX2). */}
        <span className="lmap-node-nums">
          {empty ? (
            <span className="lmap-empty-word">empty</span>
          ) : (
            <>
              {!compact && here > 0 && (
                <span className="lmap-here" data-ask={asks > 0 ? "true" : undefined}>
                  {/* With a count beside it the big number stands alone (the legend names it). */}
                  <b>{here}</b>{asks > 0 ? " ask" : n.through > 0 ? "" : " here"}
                </span>
              )}
              {n.through > 0 && <span className="lmap-through">{passed}</span>}
            </>
          )}
        </span>
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
