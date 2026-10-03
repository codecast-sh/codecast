// A force-laid graph of linked documents: every node a dot, every link a line.
// The Files graph (vault notes) and the Memory map (Claude Code memories) both
// draw through this, so hover, drag, theme and layout behave the same on both.
//
// The division of labor here is deliberate:
//   * The caller owns the OVERLAY (filters, toggles, counts) and what each node
//     means. It hands over a plain {nodes, edges} picture.
//   * sigma owns the canvas. Nodes, positions, hover, and drag are imperative
//     mutations on one graphology instance held in a ref. Re-rendering React
//     on hover would mean rebuilding the scene 60 times a second.
//   * Highlight state lives in a ref that sigma's reducers read, so hovering
//     is one `refresh({skipIndexation: true})`: a repaint with no re-layout
//     and no React render at all.
// The layout itself runs off-thread (`graphLayout.worker.ts`) and streams
// positions back; the settling animation you see is those ticks landing.
//
// Lazy-load whatever renders this: sigma and graphology are ~40kB gzip that a
// reader who never opens a graph should never download.

import { useCallback, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { runGraphLayout, seedPosition, type LayoutInput } from "../../lib/vault/graphLayout";
import type { LayoutRequest, LayoutResponse } from "../../lib/vault/graphLayout.worker";
import { cssVar, observeTheme, withAlpha } from "../../lib/solTheme";

const MIN_NODE_SIZE = 2;
const MAX_NODE_SIZE = 12;

/** The accent tokens a node may be colored with, in palette order. Accents
 *  only: a graph should read as the app's palette, not a chart library's. */
export const GRAPH_ACCENTS: [token: string, fallback: string][] = [
  ["--sol-blue", "#268bd2"],
  ["--sol-cyan", "#2aa198"],
  ["--sol-green", "#859900"],
  ["--sol-yellow", "#b58900"],
  ["--sol-orange", "#cb4b16"],
  ["--sol-violet", "#6c71c4"],
  ["--sol-magenta", "#d33682"],
  ["--sol-red", "#dc322f"],
];

/** A node's color: one of GRAPH_ACCENTS by token, or "ghost" (a dim dot for
 *  something that exists only as a link target), or "dim" (present but quiet). */
export type GraphTone = string;

export interface LinkGraphNode {
  id: string;
  label: string;
  /** Links in and out; sizes the dot. */
  degree: number;
  tone: GraphTone;
  /** Clicking opens it. Ghost nodes usually aren't. */
  clickable?: boolean;
}

export interface LinkGraph {
  nodes: LinkGraphNode[];
  edges: { source: string; target: string }[];
}

/** djb2 into the accents: a key (a folder, a type) keeps its color across
 *  sessions, so the picture stays recognizable. */
export function hashedTone(key: string): GraphTone {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return GRAPH_ACCENTS[Math.abs(hash) % GRAPH_ACCENTS.length][0];
}

/** The nodes a text filter keeps lit: the direct hits plus their neighbors,
 *  because a match is only meaningful with what it connects to. */
export function matchWithNeighbors(graph: LinkGraph, hit: (node: LinkGraphNode) => boolean): { ids: Set<string>; hits: number } {
  const direct = new Set(graph.nodes.filter(hit).map((n) => n.id));
  const ids = new Set(direct);
  for (const edge of graph.edges) {
    if (direct.has(edge.source)) ids.add(edge.target);
    if (direct.has(edge.target)) ids.add(edge.source);
  }
  return { ids, hits: direct.size };
}

interface GraphPalette {
  tones: Map<string, string>;
  ghost: string;
  dim: string;
  edge: string;
  faded: string;
  fadedEdge: string;
  label: string;
}

function readPalette(): GraphPalette {
  const styles = getComputedStyle(document.documentElement);
  const dim = cssVar(styles, "--sol-text-dim", "#657b83");
  const border = cssVar(styles, "--sol-border", "#93a1a1");
  return {
    tones: new Map(GRAPH_ACCENTS.map(([token, fallback]) => [token, cssVar(styles, token, fallback)])),
    ghost: withAlpha(dim, 0.5),
    dim: withAlpha(dim, 0.75),
    edge: withAlpha(border, 0.45),
    faded: withAlpha(dim, 0.15),
    fadedEdge: withAlpha(border, 0.08),
    label: cssVar(styles, "--sol-text-muted", "#839496"),
  };
}

function toneColor(tone: GraphTone, palette: GraphPalette): string {
  if (tone === "ghost") return palette.ghost;
  if (tone === "dim") return palette.dim;
  return palette.tones.get(tone) ?? palette.tones.get(GRAPH_ACCENTS[0][0])!;
}

/** Degree → radius, on a square root so one giant hub doesn't flatten every
 *  other node to the minimum. */
function nodeSize(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_NODE_SIZE;
  const scale = Math.sqrt(Math.min(degree, maxDegree) / maxDegree);
  return MIN_NODE_SIZE + (MAX_NODE_SIZE - MIN_NODE_SIZE) * scale;
}

/** What the reducers consult on every repaint. A ref, not state: hover fires
 *  far too often to route through React. */
interface DisplayState {
  hovered: string | null;
  /** Ids that survive the caller's filter. Null = no filter. */
  matched: Set<string> | null;
  active: string | null;
}

/**
 * Runs layouts in the worker, falling back to the main thread when a worker
 * can't be constructed (strict CSP, or an environment without module workers).
 * Ticks from superseded runs are dropped by run id.
 */
function useLayoutRunner(onTick: (positions: Float32Array, done: boolean) => void) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const workerRef = useRef<Worker | null>(null);
  const workerFailedRef = useRef(false);
  const runIdRef = useRef(0);
  const cancelLocalRef = useRef<(() => void) | null>(null);
  const lastInputRef = useRef<LayoutInput | null>(null);

  const runLocally = useCallback((runId: number) => {
    const input = lastInputRef.current;
    if (!input) return;
    cancelLocalRef.current = runGraphLayout(input, (tick) => {
      if (runId !== runIdRef.current) return;
      onTickRef.current(tick.positions, tick.done);
    });
  }, []);

  useMountEffect(() => () => {
    runIdRef.current += 1;
    cancelLocalRef.current?.();
    workerRef.current?.terminate();
    workerRef.current = null;
  });

  return useCallback(
    (nodes: string[], edges: [string, string][], positions?: Float32Array) => {
      const runId = (runIdRef.current += 1);
      cancelLocalRef.current?.();
      cancelLocalRef.current = null;
      lastInputRef.current = { nodes, edges, positions };

      if (!workerRef.current && !workerFailedRef.current) {
        try {
          // The URL must stay a literal here: it's how Vite finds and bundles
          // the worker.
          const worker = new Worker(new URL("../../lib/vault/graphLayout.worker.ts", import.meta.url), {
            type: "module",
          });
          worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
            if (event.data.runId !== runIdRef.current) return;
            onTickRef.current(event.data.positions, event.data.done);
          };
          worker.onerror = () => {
            workerFailedRef.current = true;
            worker.terminate();
            workerRef.current = null;
            runLocally(runIdRef.current);
          };
          workerRef.current = worker;
        } catch {
          workerFailedRef.current = true;
        }
      }

      const worker = workerRef.current;
      if (worker) {
        const request: LayoutRequest = { type: "layout", runId, nodes, edges, positions };
        worker.postMessage(request);
      } else {
        runLocally(runId);
      }
    },
    [runLocally],
  );
}

export interface LinkGraphCanvasProps {
  graph: LinkGraph;
  /** Ids the caller's filter keeps lit; everything else fades. */
  matched: Set<string> | null;
  /** The open document: labeled and drawn larger. */
  active: string | null;
  onNavigate: (id: string) => void;
  /** Bump to throw the arrangement away and lay out from the circle again. */
  layoutNonce?: number;
  onSettlingChange?: (settling: boolean) => void;
}

export function LinkGraphCanvas({ graph, matched, active, onNavigate, layoutNonce = 0, onSettlingChange }: LinkGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const paletteRef = useRef<GraphPalette | null>(null);
  const displayRef = useRef<DisplayState>({ hovered: null, matched: null, active: null });
  /** Node ids in the order the layout indexes positions by. */
  const orderRef = useRef<string[]>([]);
  /** Nodes the user has dragged. Layout ticks leave these alone. */
  const pinnedRef = useRef<Set<string>>(new Set());
  // Callbacks are read through refs so the sigma effect never re-runs (and
  // never tears down the scene) just because the parent re-rendered.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onSettlingRef = useRef(onSettlingChange);
  onSettlingRef.current = onSettlingChange;
  /** Which layout run the caller last asked for. A change means reseed from
   *  the circle rather than nudging what's on screen. */
  const lastNonceRef = useRef(layoutNonce);

  const startLayout = useLayoutRunner(
    useCallback((positions: Float32Array, done: boolean) => {
      const g = graphRef.current;
      if (!g) return;
      const order = orderRef.current;
      for (let i = 0; i < order.length; i++) {
        const id = order[i];
        if (pinnedRef.current.has(id) || !g.hasNode(id)) continue;
        g.setNodeAttribute(id, "x", positions[i * 2]);
        g.setNodeAttribute(id, "y", positions[i * 2 + 1]);
      }
      rendererRef.current?.refresh();
      if (done) onSettlingRef.current?.(false);
    }, []),
  );

  // ---- sigma lifecycle -----------------------------------------------------
  useMountEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const g = new Graph({ type: "undirected" });
    graphRef.current = g;
    paletteRef.current = readPalette();

    const renderer = new Sigma(g, container, {
      renderLabels: true,
      // Only nodes big enough on screen carry a label; hover and the active
      // node force theirs on through the reducer.
      labelRenderedSizeThreshold: 7,
      labelFont: "JetBrains Mono, monospace",
      labelSize: 11,
      labelColor: { color: paletteRef.current.label },
      defaultNodeColor: toneColor(GRAPH_ACCENTS[0][0], paletteRef.current),
      defaultEdgeColor: paletteRef.current.edge,
      minCameraRatio: 0.05,
      maxCameraRatio: 12,
      // The container is sized by a resizable panel and can legitimately be
      // 0×0 for a frame during a drag.
      allowInvalidContainer: true,
      nodeReducer: (node, data) => {
        const palette = paletteRef.current!;
        const { hovered, matched, active } = displayRef.current;
        const res = { ...data } as typeof data & { forceLabel?: boolean; zIndex?: number };
        // `hovered` can name a node that a mid-hover update removed:
        // graphology throws on areNeighbors with an unknown node, and a throw
        // inside a reducer takes down the whole render.
        const hoverLive = hovered !== null && g.hasNode(hovered);
        const neighborOfHover = hoverLive && (node === hovered || g.areNeighbors(hovered!, node));
        const dimmed = (hoverLive && !neighborOfHover) || (matched !== null && !matched.has(node));

        if (dimmed) {
          res.color = palette.faded;
          res.label = "";
          res.zIndex = 0;
          return res;
        }
        if (node === active) {
          res.forceLabel = true;
          res.size = (data.size ?? MIN_NODE_SIZE) * 1.35;
        }
        if (neighborOfHover) {
          res.forceLabel = true;
          res.zIndex = 2;
        }
        return res;
      },
      edgeReducer: (edge, data) => {
        const palette = paletteRef.current!;
        const { hovered, matched } = displayRef.current;
        const res = { ...data };
        const [source, target] = g.extremities(edge);
        const touchesHover = hovered !== null && (source === hovered || target === hovered);
        const hoverLive = hovered !== null && g.hasNode(hovered);
        const inMatch = matched === null || (matched.has(source) && matched.has(target));

        if ((hoverLive && !touchesHover) || !inMatch) res.color = palette.fadedEdge;
        else if (touchesHover) res.color = palette.label;
        return res;
      },
    });
    rendererRef.current = renderer;

    // ---- hover ----
    const repaint = () => renderer.refresh({ skipIndexation: true });
    renderer.on("enterNode", ({ node }) => {
      displayRef.current.hovered = node;
      container.style.cursor = "pointer";
      repaint();
    });
    renderer.on("leaveNode", () => {
      displayRef.current.hovered = null;
      container.style.cursor = "";
      repaint();
    });

    // ---- drag to pin ----
    let dragging: string | null = null;
    let dragMoved = false;
    renderer.on("downNode", ({ node }) => {
      dragging = node;
      dragMoved = false;
      // Freeze the viewport transform: without a custom bbox, sigma re-fits
      // the camera as the dragged node moves and the whole graph swims.
      if (!renderer.getCustomBBox()) renderer.setCustomBBox(renderer.getBBox());
    });
    renderer.on("moveBody", ({ event }) => {
      if (!dragging) return;
      const position = renderer.viewportToGraph(event);
      g.setNodeAttribute(dragging, "x", position.x);
      g.setNodeAttribute(dragging, "y", position.y);
      pinnedRef.current.add(dragging);
      dragMoved = true;
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
    });
    const endDrag = () => {
      dragging = null;
    };
    renderer.on("upNode", endDrag);
    renderer.on("upStage", endDrag);

    // ---- click to open ----
    renderer.on("clickNode", ({ node }) => {
      // A drag that ends on the node it started on also fires a click.
      if (dragMoved) {
        dragMoved = false;
        return;
      }
      if (!g.getNodeAttribute(node, "clickable")) return;
      onNavigateRef.current(node);
    });

    // ---- theme ----
    const stopThemeWatch = observeTheme(() => {
      paletteRef.current = readPalette();
      const palette = paletteRef.current;
      renderer.setSetting("labelColor", { color: palette.label });
      renderer.setSetting("defaultEdgeColor", palette.edge);
      g.forEachNode((node, attributes) => g.setNodeAttribute(node, "color", toneColor(attributes.tone as string, palette)));
      g.forEachEdge((edge) => g.setEdgeAttribute(edge, "color", palette.edge));
      renderer.refresh();
    });

    // ---- container resize (the pane is user-resizable) ----
    const resizeObserver = new ResizeObserver(() => {
      renderer.resize();
      renderer.refresh({ skipIndexation: true });
    });
    resizeObserver.observe(container);

    return () => {
      stopThemeWatch();
      resizeObserver.disconnect();
      renderer.kill();
      rendererRef.current = null;
      graphRef.current = null;
    };
  });

  // ---- feed the graph, then lay it out ------------------------------------
  useWatchEffect(() => {
    const g = graphRef.current;
    const renderer = rendererRef.current;
    if (!g || !renderer) return;

    const palette = paletteRef.current ?? readPalette();
    const maxDegree = graph.nodes.reduce((max, n) => Math.max(max, n.degree), 0);
    const reseed = lastNonceRef.current !== layoutNonce;
    lastNonceRef.current = layoutNonce;

    // Carry existing positions over so a filter toggle or a saved edit
    // re-settles from where the picture already is. A reseed deliberately
    // doesn't: the point of it is to throw the arrangement away.
    const previous = new Map<string, { x: number; y: number }>();
    g.forEachNode((node, attributes) => previous.set(node, { x: attributes.x as number, y: attributes.y as number }));

    g.clear();
    renderer.setCustomBBox(null);
    pinnedRef.current = new Set();

    graph.nodes.forEach((node, i) => {
      // New nodes start where the layout will seed them, so the first frame
      // is a ring rather than a pile at the origin.
      const at = (reseed ? undefined : previous.get(node.id)) ?? seedPosition(i, graph.nodes.length);
      g.addNode(node.id, {
        x: at.x,
        y: at.y,
        size: nodeSize(node.degree, maxDegree),
        label: node.label,
        color: toneColor(node.tone, palette),
        tone: node.tone,
        clickable: node.clickable !== false,
      });
    });
    for (const edge of graph.edges) {
      if (g.hasNode(edge.source) && g.hasNode(edge.target) && !g.hasEdge(edge.source, edge.target)) {
        g.addEdge(edge.source, edge.target, { color: palette.edge, size: 0.6 });
      }
    }

    orderRef.current = graph.nodes.map((n) => n.id);
    renderer.refresh();

    if (graph.nodes.length === 0) {
      onSettlingRef.current?.(false);
      return;
    }
    onSettlingRef.current?.(true);
    // Hand the layout the exact picture now on screen so it continues from
    // there; on a reseed those ARE the circle positions, so it starts fresh.
    const start = new Float32Array(graph.nodes.length * 2);
    graph.nodes.forEach((node, i) => {
      start[i * 2] = g.getNodeAttribute(node.id, "x") as number;
      start[i * 2 + 1] = g.getNodeAttribute(node.id, "y") as number;
    });
    startLayout(
      orderRef.current,
      graph.edges.map((e) => [e.source, e.target] as [string, string]),
      start,
    );
  }, [graph, startLayout, layoutNonce]);

  // ---- highlight state → repaint ------------------------------------------
  useWatchEffect(() => {
    displayRef.current.matched = matched;
    displayRef.current.active = active;
    rendererRef.current?.refresh({ skipIndexation: true });
  }, [matched, active]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
