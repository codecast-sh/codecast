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
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { CAUSES_NODE, type LineMap as LineMapModel, type MapEdge, type MapNode } from "../../../lib/line/lineMap";
import { MARK_GAP, MARK_SPILL, edgeWidth, layoutLineMap, neighbor, pathEdges, type MapLayout } from "../../../lib/line/lineMapLayout";
import { cn } from "../../../lib/utils";
import { EdgeArrows } from "../EdgeArrows";
import { edgeAttrs, useScrollEdges } from "../useScrollEdges";
import "../line.css";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
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
  /** Scale the whole map (CSS zoom): a panel beside it narrows the column, so
   *  the map steps back to keep the selected node and its neighbors in view (LX3). */
  zoom?: number;
  onSelectNode?: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  className?: string;
};

const nodeSel = (id: string) => `[data-map-node="${id.replace(/"/g, '\\"')}"]`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const LineMap = memo(function LineMap({ map, layout: given, selectedNode, selectedEdge, focusedNode, highlightPath, openAt, asks = 0, zoom: zoomMax = 1, onSelectNode, onSelectEdge, className }: LineMapProps) {
  const layout = useMemo(() => given ?? layoutLineMap(map), [given, map]);
  const scroller = useRef<HTMLDivElement>(null);
  const zoom = useIntakeZoom(scroller, layout, selectedNode ?? null, zoomMax);
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

  const edges = useScrollEdges(scroller);
  // On open, the node the map opens on (a card for you, the worst trouble,
  // the busiest) in view with room on both sides. It places again only when
  // that node changes before the viewer has scrolled (a card arriving after
  // first paint), so the viewer's own scrolling is never undone. A selection
  // or a trace scrolls by its own effect below.
  const placed = useRef<{ at: string; left: number } | null>(null);
  useWatchEffect(() => {
    const el = scroller.current;
    if (!el || !openAt) return;
    const was = placed.current;
    if (was && (was.at === openAt || Math.abs(el.scrollLeft - was.left) > 1)) return;
    if (selectedNode || highlightPath?.length || (!was && el.scrollLeft > 0)) { placed.current = { at: openAt, left: NaN }; return; }
    const node = el.querySelector<HTMLElement>(nodeSel(openAt));
    if (!node) return;
    const box = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    // Already in view from the start: keep the sources and the Sense label on screen.
    if (!(was && r.left < box.left + EDGE_ROOM) && r.right <= box.right - Math.min(64, box.width / 6)) { placed.current = { at: openAt, left: el.scrollLeft }; return; }
    // The gutter rule holds on open too: no node is left split at the left edge (LX3).
    el.scrollTo({ left: uncutLeft(el, layout, zoom, el.scrollLeft + (r.left + r.width / 2) - (box.left + box.width * 0.42)), top: 0 });
    placed.current = { at: openAt, left: el.scrollLeft };
  }, [openAt, selectedNode, highlightPath, layout, zoom]);

  // What the viewport cuts (LX2): a node less than half in view loses its
  // mark and the labels of its edges, an edge label that would cross an edge
  // of the view hides, and each stage name slides to stay inside the arrows'
  // gutters (or hides when it no longer fits). Cards waiting past an edge ride
  // its arrow. Direct attribute writes on scroll, so scrolling re-renders nothing.
  const [waiting, setWaiting] = useState({ left: 0, right: 0 });
  // The stages past each edge, so the arrow says what scrolling that way shows.
  const [past, setPast] = useState<{ left: string[]; right: string[] }>({ left: [], right: [] });
  const decideId = useMemo(() => map.nodes.find((n) => n.kind === "decide")?.id ?? null, [map.nodes]);
  useWatchEffect(() => {
    const el = scroller.current;
    const canvas = el?.querySelector<HTMLElement>(".lmap-canvas");
    if (!el || !canvas) return;
    const edgeById = new Map(map.edges.map((e) => [e.id, e]));
    // Each curve's box, measured once per layout: scrolling only compares it.
    const boxes = new Map<string, Box | null>();
    const boxOf = (g: SVGGElement, id: string) => {
      if (!boxes.has(id)) boxes.set(id, curveBox(g));
      return boxes.get(id)!;
    };
    const run = () => {
      const at = canvas.offsetLeft;
      const top = canvas.offsetTop;
      const canL = el.scrollLeft > 2;
      const canR = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      // An arrow that names what lies past its edge is wider than the plain one: the stage names keep clear of it.
      const room = (side: "left" | "right") => Math.max(EDGE_ROOM, (el.parentElement?.querySelector<HTMLElement>(`[data-edge-arrow="${side}"]`)?.offsetWidth ?? 0) + 10);
      const x0 = (el.scrollLeft + (canL ? EDGE_ROOM : 0) - at) / zoom;
      const x1 = (el.scrollLeft + el.clientWidth - (canR ? EDGE_ROOM : 0) - at) / zoom;
      const p0 = (el.scrollLeft + (canL ? room("left") : 0) - at) / zoom;
      const p1 = (el.scrollLeft + el.clientWidth - (canR ? room("right") : 0) - at) / zoom;
      const y0 = (el.scrollTop - top) / zoom;
      const y1 = (el.scrollTop + el.clientHeight - top) / zoom;
      const cut = new Set<string>();
      // Less than half in view either way: a loop's label over the stage, tied to a node out of sight below, hides with it.
      for (const b of layout.boxes.values()) if (Math.min(b.x + b.w, x1) - Math.max(b.x, x0) < b.w / 2 || Math.min(b.y + b.h, y1) - Math.max(b.y, y0) < b.h / 2) cut.add(b.id);
      for (const m of canvas.querySelectorAll<HTMLElement>("[data-map-mark]")) flag(m, "data-cut", cut.has(m.dataset.mapMark ?? ""));
      // A node the side edge leaves less than half of keeps its box but not its
      // words, so the view never reads "Groun / empty." at the panel's edge.
      for (const n of canvas.querySelectorAll<HTMLElement>("[data-map-node]")) {
        const b = layout.boxes.get(n.dataset.mapNode ?? "");
        flag(n, "data-cut-x", !!b && Math.min(b.x + b.w, x1) - Math.max(b.x, x0) < b.w / 2);
      }
      for (const g of canvas.querySelectorAll<SVGGElement>("[data-map-edge]")) {
        const id = g.dataset.mapEdge ?? "";
        const e = edgeById.get(id);
        if (!e) continue;
        // A loop or branch that runs out of the view (an end less than half
        // in, or most of its curve outside) would leave the stage with nothing
        // to anchor it: it fades, label and all, until it comes back in (LX2).
        const off = e.kind !== "flow" && (cut.has(e.to) || cut.has(e.from) || inView(boxOf(g, id), x0, x1, y0, y1) < 0.6);
        flag(g, "data-off", off);
        const p = layout.paths.get(id)?.labelAt;
        const t = g.querySelector("text");
        if (!p || !t) continue;
        const half = ((t.textContent?.length ?? 0) * LABEL_CH) / 2 + 2;
        flag(g, "data-label-cut", off || cut.has(e.from) || cut.has(e.to) || p.x - half < x0 || p.x + half > x1 || p.y - 10 < y0 || p.y + 3 > y1);
      }
      for (const s of canvas.querySelectorAll<HTMLElement>("[data-map-phase]")) {
        const p = layout.phases[Number(s.dataset.mapPhaseAt)];
        if (!p) continue;
        const from = Math.max(p.x, p0);
        const indent = Math.round(from - p.x);
        s.style.textIndent = indent > 0 ? `${indent}px` : "";
        flag(s, "data-cut", Math.min(p.x + p.w, p1) - from < p.label.length * PHASE_CH);
      }
      const left: string[] = [];
      const right: string[] = [];
      for (const p of layout.phases) {
        if (p.x + p.w / 2 < x0 && !left.includes(p.label)) left.push(p.label);
        if (p.x + p.w / 2 > x1 && !right.includes(p.label)) right.push(p.label);
      }
      left.reverse();
      setPast((was) => (was.left.join() === left.join() && was.right.join() === right.join() ? was : { left, right }));
      const b = decideId && asks > 0 ? layout.boxes.get(decideId) : undefined;
      const mid = b ? b.x + b.w / 2 : NaN;
      const next = { left: mid < x0 ? asks : 0, right: mid > x1 ? asks : 0 };
      setWaiting((w) => (w.left === next.left && w.right === next.right ? w : next));
    };
    run();
    el.addEventListener("scroll", run, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", run); ro?.disconnect(); };
  }, [layout, map, zoom, asks, decideId, past]);
  // Keep the selected or focused node in view as it moves, and again when the
  // map's column narrows (a panel opening beside it), so the node a panel
  // describes is never the one hidden behind its edge (LX3).
  const target = focusedNode ?? selectedNode ?? null;
  // Where the target sits: data arriving can move it, a data tick does not.
  const tb = target ? layout.boxes.get(target) : undefined;
  const targetAt = tb ? `${tb.x},${tb.y}` : null;
  // Smooth only when the viewer moves the cursor; arriving on a page or a
  // layout settling jumps, so the node is in view on first paint.
  const lastTarget = useRef<string | null>(null);
  const resting = useRef<string | null | undefined>(undefined);
  // Where the map sat before a panel opened, so closing it puts the map back (LX3).
  const prevSelected = useRef<string | null>(selectedNode ?? null);
  const beforePanel = useRef<{ left: number; top: number } | null>(null);
  useWatchEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (selectedNode && !prevSelected.current) beforePanel.current = { left: el.scrollLeft, top: el.scrollTop };
    // Closing a panel is not a move of the cursor: the effect below puts the map back.
    if (!selectedNode && prevSelected.current) { resting.current = target; return; }
    if (!target) return;
    // The cursor's default spot is not a move, however the layout settles
    // under it: the open placement above owns first paint.
    if (!selectedNode && (resting.current === undefined || resting.current === target)) { resting.current = target; return; }
    keepInView(el, layout, target, zoom, lastTarget.current && lastTarget.current !== target ? "smooth" : "auto");
    lastTarget.current = target;
    if (typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    // The column narrowing (a panel opening) or widening keeps the same span in view.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) keepInView(el, layout, target, zoom, "auto");
      w = el.clientWidth;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [target, targetAt, zoom, selectedNode, layout]);
  // The panel closed: back to where the map sat before it opened, and with
  // no such place (the page opened on a node), the left gutter rule alone,
  // so no source pill or stage label is left cut at the edge (LX3).
  useWatchEffect(() => {
    const el = scroller.current;
    const was = prevSelected.current;
    prevSelected.current = selectedNode ?? null;
    if (!el || selectedNode || !was) return;
    const back = beforePanel.current;
    beforePanel.current = null;
    const left = uncutLeft(el, layout, zoom, back ? back.left : el.scrollLeft);
    el.scrollTo({ left, top: back ? back.top : el.scrollTop });
  }, [selectedNode, layout, zoom]);
  // A trace opens on where its path ends (where the item is, or where it
  // stopped), and follows the step the reader points at in its story.
  // The last step of the path the map draws (a graph's folded terminal steps are its ends).
  const last = [...(highlightPath ?? [])].reverse().find((id) => !id.startsWith("end:") && layout.boxes.has(id)) ?? highlightPath?.[highlightPath.length - 1];
  const follow = tracing && focusedNode && onPath.has(focusedNode) ? focusedNode : last;
  // Once per target: the node may draw only after the graph arrives, and a
  // later refresh of the same map never moves the reader's own scroll.
  const followed = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!follow || followed.current === follow) return;
    // The frame may still be laying out (no width yet): try again shortly
    // until the node really sits in view, then never again for this target.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const place = () => {
      const el = scroller.current;
      const node = el?.querySelector<HTMLElement>(nodeSel(follow));
      if (el && node && el.clientWidth > 0) {
        node.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "auto" });
        const box = el.getBoundingClientRect();
        const r = node.getBoundingClientRect();
        if (r.left >= box.left - 1 && r.right <= box.right + 1) { followed.current = follow; return; }
      }
      if (++tries < 20) timer = setTimeout(place, 100);
    };
    place();
    return () => clearTimeout(timer);
  }, [follow, layout]);

  return (
    <div className={cn("lmap-frame", className)} data-line-map data-tracing={tracing ? "true" : undefined}>
    <div ref={scroller} className="lmap-scroll line-edge-fade" {...edgeAttrs(edges)}>
      <div className="lmap-canvas" style={{ width: layout.width, height: layout.height, ...(zoom !== 1 ? { zoom } : {}) }} data-zoom={zoom !== 1 ? zoom : undefined}>
        <div className="lmap-phases" aria-hidden>
          {layout.phases.map((p, i) => (
            <span key={`${p.key}@${p.y}`} className="lmap-phase" style={{ left: p.x, width: p.w, top: p.y }} data-map-phase={p.key} data-map-phase-at={i}>{p.label}</span>
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
                {p.labelAt && (p.note || e.label || (on && (pathHops.get(e.id) ?? 0) > 1)) && (
                  <text x={p.labelAt.x} y={p.labelAt.y} className="lmap-edge-label" textAnchor="middle" data-map-edge-note={p.note ? "" : undefined}>
                    {[p.note ?? e.label, on && (pathHops.get(e.id) ?? 0) > 1 ? `x${pathHops.get(e.id)}` : e.count > 0 ? String(e.count) : null].filter(Boolean).join("  ")}
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
    <EdgeArrows scroller={scroller} edges={edges} label="the line" waiting={waiting} names={past} />
    </div>
  );
});

/** The room kept at the scroller's left edge, so a source pill never clips there. */
const GUTTER = 24;
/** An edge arrow's gutter: the arrow (22px) and its inset, where no label is drawn. */
const EDGE_ROOM = 28;
/** Rough glyph widths, in canvas px: an edge label (10px mono) and a stage name (11.5px). */
const LABEL_CH = 6.1;
const PHASE_CH = 7;
const flag = (el: Element, name: string, on: boolean) => (on ? el.setAttribute(name, "true") : el.removeAttribute(name));

type Box = { x: number; y: number; width: number; height: number };
/** An edge curve's box in canvas units, or null where it cannot be measured (jsdom). */
function curveBox(g: SVGGElement): Box | null {
  try {
    const b = g.querySelector<SVGGraphicsElement>(".lmap-edge-line")?.getBBox?.();
    return b && (b.width > 0 || b.height > 0) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  } catch { return null; }
}

/** How much of a curve's box lies inside the view, 0 to 1; 1 when unmeasured. */
function inView(b: Box | null, x0: number, x1: number, y0: number, y1: number): number {
  if (!b) return 1;
  const w = Math.max(1, b.width);
  const h = Math.max(1, b.height);
  const ox = Math.max(0, Math.min(b.x + w, x1) - Math.max(b.x, x0));
  const oy = Math.max(0, Math.min(b.y + h, y1) - Math.max(b.y, y0));
  return (ox / w) * (oy / h);
}

/** Scroll `el` so node `id` shows whole with its nearest neighbor on each
 *  side (LX3). A node in the first two columns keeps the map at its start, so
 *  the sources sit at the left gutter; any other node pans as far left as its
 *  right neighbor allows, so what feeds it shows too. When even the node and
 *  its neighbors are wider than the column, the node and its left neighbor
 *  win. Read from the layout, in canvas units times the zoom, so it holds
 *  while the column resizes. scrollTo, not scrollIntoView, so the page never moves. */
function keepInView(el: HTMLElement, layout: MapLayout, id: string, zoom: number, behavior: ScrollBehavior) {
  const b = layout.boxes.get(id);
  const canvas = el.querySelector<HTMLElement>(".lmap-canvas");
  if (!b || !canvas) return;
  const left = layout.boxes.get(neighbor(layout, id, "left") ?? "") ?? b;
  const right = layout.boxes.get(neighbor(layout, id, "right") ?? "") ?? b;
  const at = canvas.offsetLeft;
  const lo = at + Math.min(left.x, b.x) * zoom - GUTTER;
  const hi = at + Math.max(right.x + right.w, b.x + b.w) * zoom + GUTTER;
  const W = el.clientWidth;
  // Up to Causes (expectations, sources, signals, the queue) the map stays at
  // its start whenever the node shows whole from there, so the sources keep
  // the left gutter and the reader sees what feeds the node (LX3).
  const intake = isIntake(layout, id);
  const x = intake && at + (b.x + b.w) * zoom + GUTTER <= W ? 0 : hi - lo <= W ? Math.min(Math.max(0, hi - W), lo) : lo;
  // A node the edge would split comes in whole when the span still fits, else
  // the edge moves past it, never past the left neighbor.
  // At the start the gutter already holds the first column whole, so the
  // intake stays there even when its right neighbor does not fit beside it.
  const nx = x === 0 && intake ? 0 : Math.min(uncutLeft(el, layout, zoom, x, (l) => hi - l <= W), Math.max(0, Math.round(lo)));
  const top = canvas.offsetTop;
  const y1 = top + b.y * zoom - 8;
  const y2 = top + (b.y + b.h) * zoom + 8;
  const ny = y1 < el.scrollTop ? y1 : y2 > el.scrollTop + el.clientHeight ? y2 - el.clientHeight : el.scrollTop;
  if (Math.abs(nx - el.scrollLeft) > 1 || Math.abs(ny - el.scrollTop) > 1) el.scrollTo({ left: nx, top: Math.max(0, ny), behavior });
}

/** Up to Causes: expectations, the sources, Signals and the queue (LX3). */
const isIntake = (layout: MapLayout, id: string) => (layout.boxes.get(id)?.col ?? Infinity) <= (layout.boxes.get(CAUSES_NODE)?.col ?? -1);
/** The smallest scale the map steps back to so the intake shows whole; below it the words stop reading. */
const INTAKE_ZOOM_MIN = 0.7;

/** The map's scale with a panel open (LX3). A node up to Causes keeps the map
 *  at its start, sources at the left gutter, so the map steps back a little
 *  further than `max` when that is what fits the node whole beside the panel,
 *  rather than panning the sources off screen. Any other node takes `max`. */
function useIntakeZoom(scroller: RefObject<HTMLDivElement | null>, layout: MapLayout, selected: string | null, max: number): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scroller]);
  // A line folded onto rows (lineMapLayout bands) steps back to fit its
  // widest row in the column, down to the floor where words stop reading.
  if (layout.bands > 1 && width) max = Math.max(INTAKE_ZOOM_MIN, Math.min(max, Math.floor(((width - 2 * GUTTER) / layout.width) * 100) / 100));
  if (max >= 1 || !selected || !width || !isIntake(layout, selected)) return max;
  const b = layout.boxes.get(selected)!;
  const fit = (width - 2 * GUTTER) / (b.x + b.w);
  return Math.max(INTAKE_ZOOM_MIN, Math.min(max, Math.floor(fit * 100) / 100));
}

/** The left edge's scroll position adjusted so it cuts no node (the gutter
 *  rule, LX3): a node the edge would split comes into view whole, with the
 *  gutter, when `fits` says there is room (always, by default), else the edge
 *  moves past it. With or without a panel open. */
function uncutLeft(el: HTMLElement, layout: MapLayout, zoom: number, x: number, fits: (l: number) => boolean = () => true): number {
  const at = el.querySelector<HTMLElement>(".lmap-canvas")?.offsetLeft ?? 0;
  let nx = Math.max(0, x);
  for (const o of layout.boxes.values()) {
    const l = at + o.x * zoom - GUTTER;
    const r = at + (o.x + o.w) * zoom;
    if (l < nx && r > nx) nx = fits(l) ? Math.max(0, l) : r + 4;
  }
  return Math.round(nx);
}

/** The one stacked chip the sources fold into (LX2). */
export const MORE_SOURCES = "sources:more";
const sourceRank = (n: MapNode) => (n.marks.some((m) => m.level === "fail") ? 2 : n.marks.some((m) => m.level === "warn") ? 1 : 0);

/** The map with its sources folded into one stacked chip ("6 sources"), so
 *  the intake takes one node's height and the stations lead (LX2). A source
 *  in trouble and the `pinned` ids (the open node, a trace's path) stay out
 *  beside it. The chip's count is what the folded ones filed, and their
 *  edges merge into its own. Opening the chip draws every source. */
export function foldSources(map: LineMapModel, pinned: ReadonlySet<string> = new Set()): LineMapModel {
  const sources = map.nodes.filter((n) => n.kind === "source");
  if (sources.length <= 2) return map;
  const kept = new Set(sources.filter((n) => pinned.has(n.id) || sourceRank(n) > 0).map((n) => n.id));
  const folded = sources.filter((n) => !kept.has(n.id));
  if (folded.length < 2) return map;
  const gone = new Set(folded.map((n) => n.id));
  const more: MapNode = {
    id: MORE_SOURCES, kind: "source", label: kept.size ? `+${folded.length} more sources` : `${folded.length} sources`, phase: folded[0].phase, col: folded[0].col, main: false,
    now: [], through: folded.reduce((t, n) => t + n.through, 0), passed: [], marks: [], medianMs: null, failed: 0,
  };
  // The chip takes the first folded source's place, so the order holds.
  const nodes = map.nodes.flatMap((n) => (n === folded[0] ? [more] : gone.has(n.id) ? [] : [n]));
  // Each edge into or out of a folded source becomes the pill's, one per far end and kind.
  const merged = new Map<string, MapEdge>();
  const edges: MapEdge[] = [];
  for (const e of map.edges) {
    if (!gone.has(e.from) && !gone.has(e.to)) { edges.push(e); continue; }
    const from = gone.has(e.from) ? MORE_SOURCES : e.from;
    const to = gone.has(e.to) ? MORE_SOURCES : e.to;
    if (from === to) continue;
    const id = `${from}->${to}:${e.kind}`;
    const was = merged.get(id);
    if (was) { was.count += e.count; was.items = [...was.items, ...e.items]; continue; }
    const edge: MapEdge = { id, from, to, kind: e.kind, count: e.count, items: [...e.items] };
    merged.set(id, edge);
    edges.push(edge);
  }
  return { ...map, nodes, edges };
}

/** An edge in words, for its tooltip: where it goes and how many crossed. */
export function edgeWords(e: MapEdge, byId: Map<string, MapNode>): string {
  const from = byId.get(e.from)?.label ?? e.from;
  const to = byId.get(e.to)?.label ?? e.to;
  const how = e.kind === "loop" ? "back to" : "to";
  return `${from} ${how} ${to}${e.label ? `, when ${e.label.toLowerCase()}` : ""}: ${e.count === 0 ? "nothing crossed" : `${plural(e.count, "crossing")}`}`;
}

/** What the window's count means at a node: signals are filed, causes are
 *  new, an end is where runs ended, and a station counts what went through
 *  it. Never "passed": next to "2 of 5 failed" that reads as succeeded, and
 *  how visits ended is the mark's to say. */
export function throughWord(n: Pick<MapNode, "kind">): string {
  if (n.kind === "source" || n.kind === "signals" || n.kind === "expectations") return "filed";
  if (n.kind === "causes") return "new";
  if (n.kind === "end") return "ended";
  return "runs";
}

/** The window's count in words: "5 runs", "1 run", "12 filed". */
export const throughWords = (n: Pick<MapNode, "kind" | "through">) => `${n.through} ${n.through === 1 && throughWord(n) === "runs" ? "run" : throughWord(n)}`;

/** How a node is doing at a glance: what its lamp shows. */
export function nodeTone(n: MapNode, asks = 0): "fail" | "warn" | "ask" | "live" | "idle" | "info" {
  if (n.marks.some((m) => m.level === "fail")) return "fail";
  if (n.marks.some((m) => m.level === "warn")) return "warn";
  if (asks > 0) return "ask";
  if (n.now.length > 0) return "live";
  if (n.marks.length > 0) return "info";
  return "idle";
}

/** The marks a node's first one leaves out, named by what they are: "1 more warning". */
function moreWords(rest: MapNode["marks"]): string {
  const fail = rest.filter((m) => m.level === "fail").length;
  const warn = rest.filter((m) => m.level === "warn").length;
  const note = rest.length - fail - warn;
  return [fail && plural(fail, "more failure", "more failures"), warn && plural(warn, "more warning", "more warnings"), note && plural(note, "more note", "more notes")].filter(Boolean).join(", ");
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
  // A card waiting on the viewer is the node's mark unless something is wrong
  // there: the same yellow the project pill uses, so the reason the map
  // opened here shows under the node (LX2).
  const trouble = n.marks.some((m) => m.level !== "info");
  const mark: (Omit<MapNode["marks"][number], "level"> & { level: MapNode["marks"][number]["level"] | "ask" }) | undefined = asks > 0 && !trouble
    ? { level: "ask", words: `${asks === 1 ? "A decision waits" : `${asks} decisions wait`} on your answer`, short: "Waiting on you" }
    : n.marks[0];
  const marks = mark?.level === "ask" ? [mark, ...n.marks] : n.marks;
  const passed = throughWords(n);
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
        data-who={n.who}
        data-empty={empty ? "true" : undefined}
      >
        <span className="lmap-node-head">
          <span className="lmap-lamp" data-tone={tone} />
          <span className="lmap-node-label">{n.label}</span>
          {n.who === "person" && <span className="lmap-you" title="You decide at this step">you</span>}
        </span>
        {/* One reading per node: what is here now as the big number (only when
            something is), what passed in the window as small labeled words,
            and an empty node says so instead of drawing zeros (LX2). */}
        <span className="lmap-node-nums">
          {empty ? (
            <span className="lmap-empty-word">{n.kind === "end" ? "none yet" : "empty"}</span>
          ) : (
            <>
              {!compact && here > 0 && (
                <span className="lmap-here" data-ask={asks > 0 ? "true" : undefined}>
                  {/* With a count beside it the big number stands alone (the legend names it). */}
                  <b>{here}</b>{asks > 0 ? " for you" : n.through > 0 ? "" : " here"}
                </span>
              )}
              {/* A card waiting on you is the node's one reading; what passed waits in the tooltip. */}
              {n.through > 0 && !(asks > 0 && !compact) && <span className="lmap-through">{passed}</span>}
            </>
          )}
          {visits > 1 && <span className="lmap-visits" title={`${visits} visits on this path`}>x{visits}</span>}
        </span>
      </button>
      {mark && (
        <span
          className="lmap-mark"
          data-level={mark.level}
          // Into most of the column gap on each side, so a short sentence fits whole and neighbours' marks still keep apart.
          style={{ left: (style.left as number) - MARK_SPILL, top: (style.top as number) + (style.height as number) + MARK_GAP, width: (style.width as number) + 2 * MARK_SPILL }}
          title={marks.map((m) => m.words).join("\n")}
          data-map-mark={n.id}
        >
          {mark.short ?? mark.words}
          {marks.length > 1 && <span className="lmap-mark-more" title={`And ${moreWords(marks.slice(1) as MapNode["marks"])}`}> +{marks.length - 1}</span>}
        </span>
      )}
    </>
  );
}
