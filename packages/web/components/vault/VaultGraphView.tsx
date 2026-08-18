// The vault graph: every note as a dot, every resolved link as a line.
//
// Lazy-loaded — sigma and graphology are ~40kB gzip that a reader who never
// opens the graph should never download (see VaultQuickSwitcherDock for the
// same shape).
//
// The division of labor here is deliberate:
//   * React owns the OVERLAY (filters, toggles, counts) and nothing else.
//   * sigma owns the canvas. Nodes, positions, hover, and drag are imperative
//     mutations on one graphology instance held in a ref. Re-rendering React
//     on hover would mean rebuilding the scene 60 times a second.
//   * Highlight state lives in a ref that sigma's reducers read, so hovering
//     is one `refresh({skipIndexation: true})` — a repaint with no re-layout
//     and no React render at all.
// The layout itself runs off-thread (`graphLayout.worker.ts`) and streams
// positions back; the settling animation you see is those ticks landing.

import { useCallback, useMemo, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import Graph from "graphology";
import Sigma from "sigma";
import { Filter, Loader2, RotateCcw, Waypoints, X } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useTabContext } from "../../lib/tabParams";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import {
  buildVaultGraph,
  localSubgraph,
  type VaultGraph,
  type VaultGraphNode,
} from "../../lib/vault/graphBuilder";
import { runGraphLayout, seedPosition, type LayoutInput } from "../../lib/vault/graphLayout";
import type { LayoutRequest, LayoutResponse } from "../../lib/vault/graphLayout.worker";
import { cssVar, observeTheme, withAlpha } from "../../lib/solTheme";

/** Hops the local graph reaches. Obsidian's default depth, and the point past
 *  which "neighborhood" stops meaning anything in a densely linked vault. */
const LOCAL_HOPS = 2;

const MIN_NODE_SIZE = 2;
const MAX_NODE_SIZE = 12;

/** Folder colors, in token order. Accents only — the graph should read as the
 *  app's palette, not a chart library's. */
const FOLDER_ACCENTS: [token: string, fallback: string][] = [
  ["--sol-blue", "#268bd2"],
  ["--sol-cyan", "#2aa198"],
  ["--sol-green", "#859900"],
  ["--sol-yellow", "#b58900"],
  ["--sol-orange", "#cb4b16"],
  ["--sol-violet", "#6c71c4"],
  ["--sol-magenta", "#d33682"],
  ["--sol-red", "#dc322f"],
];

interface GraphPalette {
  accents: string[];
  ghost: string;
  edge: string;
  faded: string;
  fadedEdge: string;
  label: string;
}

function readPalette(): GraphPalette {
  const styles = getComputedStyle(document.documentElement);
  const accents = FOLDER_ACCENTS.map(([token, fallback]) => cssVar(styles, token, fallback));
  const dim = cssVar(styles, "--sol-text-dim", "#657b83");
  const border = cssVar(styles, "--sol-border", "#93a1a1");
  return {
    accents,
    ghost: withAlpha(dim, 0.5),
    edge: withAlpha(border, 0.45),
    faded: withAlpha(dim, 0.15),
    fadedEdge: withAlpha(border, 0.08),
    label: cssVar(styles, "--sol-text-muted", "#839496"),
  };
}

/** djb2 — any stable hash works; what matters is that a folder keeps its color
 *  across sessions and across vaults, so the picture stays recognizable. */
function folderColor(folder: string, palette: GraphPalette): string {
  let hash = 5381;
  for (let i = 0; i < folder.length; i++) hash = ((hash << 5) + hash + folder.charCodeAt(i)) | 0;
  return palette.accents[Math.abs(hash) % palette.accents.length];
}

/** Degree → radius, on a square root so one giant hub doesn't flatten every
 *  other node to the minimum. */
function nodeSize(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_NODE_SIZE;
  const scale = Math.sqrt(Math.min(degree, maxDegree) / maxDegree);
  return MIN_NODE_SIZE + (MAX_NODE_SIZE - MIN_NODE_SIZE) * scale;
}

function nodeColor(node: VaultGraphNode, palette: GraphPalette): string {
  return node.isUnresolved ? palette.ghost : folderColor(node.folder, palette);
}

/** What the reducers consult on every repaint. A ref, not state: hover fires
 *  far too often to route through React. */
interface DisplayState {
  hovered: string | null;
  /** Ids that survive the text filter, plus their neighbors. Null = no filter. */
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
          // The URL must stay a literal here — it's how Vite finds and bundles
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

export interface VaultGraphViewProps {
  /** The note the vault has open, if any — it anchors the local graph. */
  activePath: string | null;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

export function VaultGraphView({ activePath, onNavigate, onClose }: VaultGraphViewProps) {
  const indexVersion = useVaultIndexVersion();
  const [showUnresolved, setShowUnresolved] = useState(false);
  const [scope, setScope] = useState<"vault" | "local">("vault");
  const [filter, setFilter] = useState("");
  const [settling, setSettling] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const paletteRef = useRef<GraphPalette | null>(null);
  const displayRef = useRef<DisplayState>({ hovered: null, matched: null, active: null });
  /** Node ids in the order the layout indexes positions by. */
  const orderRef = useRef<string[]>([]);
  /** Nodes the user has dragged. Layout ticks leave these alone. */
  const pinnedRef = useRef<Set<string>>(new Set());

  // The graph is a pure function of the index, so it's rebuilt whenever the
  // index version bumps — a note saved on disk redraws the picture.
  // vaultIndex is a mutable singleton, so the version counter — not the object
  // — is what says the graph changed. eslint can't see that relationship.
  const fullGraph = useMemo<VaultGraph>(
    () => buildVaultGraph(vaultIndex, { includeUnresolved: showUnresolved }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexVersion, showUnresolved],
  );

  const graph = useMemo<VaultGraph>(
    () =>
      scope === "local" && activePath ? localSubgraph(fullGraph, activePath, LOCAL_HOPS) : fullGraph,
    [fullGraph, scope, activePath],
  );

  /** Which layout run the "re-run" button last asked for. A change means
   *  reseed from the circle rather than nudging what's on screen. */
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
      if (done) setSettling(false);
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
      // note force theirs on through the reducer.
      labelRenderedSizeThreshold: 7,
      labelFont: "JetBrains Mono, monospace",
      labelSize: 11,
      labelColor: { color: paletteRef.current.label },
      defaultNodeColor: paletteRef.current.accents[0],
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
        // `hovered` can name a node that a mid-hover index update removed —
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
      if (g.getNodeAttribute(node, "isUnresolved")) return;
      onNavigateRef.current(node);
    });

    // ---- theme ----
    const stopThemeWatch = observeTheme(() => {
      paletteRef.current = readPalette();
      const palette = paletteRef.current;
      renderer.setSetting("labelColor", { color: palette.label });
      renderer.setSetting("defaultEdgeColor", palette.edge);
      g.forEachNode((node, attributes) => {
        g.setNodeAttribute(
          node,
          "color",
          attributes.isUnresolved
            ? palette.ghost
            : folderColor((attributes.folder as string) ?? "", palette),
        );
      });
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

  // onNavigate is read through a ref so the sigma effect never re-runs (and
  // never tears down the scene) just because the parent re-rendered.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // ---- feed the graph, then lay it out ------------------------------------
  useWatchEffect(() => {
    const g = graphRef.current;
    const renderer = rendererRef.current;
    if (!g || !renderer) return;

    const palette = paletteRef.current ?? readPalette();
    const maxDegree = graph.nodes.reduce((max, n) => Math.max(max, n.degree), 0);
    const reseed = lastNonceRef.current !== layoutNonce;
    lastNonceRef.current = layoutNonce;

    // Carry existing positions over so a filter toggle re-settles from where
    // the picture already is. "Re-run layout" deliberately doesn't: the whole
    // point of that button is to throw the arrangement away and start over.
    const previous = new Map<string, { x: number; y: number }>();
    g.forEachNode((node, attributes) =>
      previous.set(node, { x: attributes.x as number, y: attributes.y as number }),
    );

    g.clear();
    renderer.setCustomBBox(null);
    pinnedRef.current = new Set();

    graph.nodes.forEach((node, i) => {
      // Nodes we already had keep their position (a filter toggle re-settles
      // from where the picture is); new ones start where the layout will seed
      // them, so the first frame is a ring rather than a pile at the origin.
      const at = (reseed ? undefined : previous.get(node.id)) ?? seedPosition(i, graph.nodes.length);
      g.addNode(node.id, {
        x: at.x,
        y: at.y,
        size: nodeSize(node.degree, maxDegree),
        label: node.label,
        color: nodeColor(node, palette),
        folder: node.folder,
        isUnresolved: node.isUnresolved === true,
      });
    });
    for (const edge of graph.edges) {
      if (!g.hasEdge(edge.source, edge.target)) {
        g.addEdge(edge.source, edge.target, { color: palette.edge, size: 0.6 });
      }
    }

    orderRef.current = graph.nodes.map((n) => n.id);
    renderer.refresh();

    if (graph.nodes.length === 0) {
      setSettling(false);
      return;
    }
    setSettling(true);
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
  const matched = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return null;
    // Path as well as title: "projects/" is the natural way to ask for a
    // folder, and the title alone can't answer it.
    const direct = new Set(
      graph.nodes
        .filter((n) => n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term))
        .map((n) => n.id),
    );
    // Neighbors stay lit: a match is only meaningful with what it connects to.
    const withNeighbors = new Set(direct);
    for (const edge of graph.edges) {
      if (direct.has(edge.source)) withNeighbors.add(edge.target);
      if (direct.has(edge.target)) withNeighbors.add(edge.source);
    }
    return { ids: withNeighbors, hits: direct.size };
  }, [filter, graph]);

  useWatchEffect(() => {
    displayRef.current.matched = matched?.ids ?? null;
    displayRef.current.active = activePath;
    rendererRef.current?.refresh({ skipIndexation: true });
  }, [matched, activePath]);

  // Esc leaves the graph, matching the header toggle — but not while the
  // filter box has focus, where Esc means "clear what I typed".
  //
  // The tab shell keeps inactive tabs mounted, so a bare window listener would
  // fire this from whatever tab the user is actually looking at.
  const tabCtx = useTabContext();
  const isTabActive = (tabCtx as { isActive?: boolean } | null)?.isActive !== false;
  useEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isTabActive) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      if (target === filterInputRef.current && filter) setFilter("");
      return;
    }
    event.preventDefault();
    onClose();
  });

  // Closing the note that anchors the local graph drops us back to the vault.
  const hasLocalAnchor = activePath !== null;
  useWatchEffect(() => {
    if (!hasLocalAnchor) setScope("vault");
  }, [hasLocalAnchor]);

  return (
    <div className="relative h-full w-full min-h-0 bg-sol-bg">
      <div ref={containerRef} className="absolute inset-0" />

      {graph.nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center pointer-events-none">
          <Waypoints className="w-8 h-8 text-sol-text-dim opacity-30" />
          <div className="text-sm text-sol-text-muted">
            {scope === "local" ? "This note has no links yet." : "No notes to graph yet."}
          </div>
          <div className="text-xs text-sol-text-dim max-w-xs">
            Link notes with <code className="text-sol-text-muted">[[Wiki Links]]</code> and they
            appear here, connected.
          </div>
        </div>
      )}

      <div className="absolute top-3 right-3 w-60 sol-card p-3 flex flex-col gap-2.5 text-xs shadow-lg">
        <div className="flex items-center gap-2">
          <Waypoints className="w-3.5 h-3.5 text-sol-cyan" />
          <span className="font-medium text-sol-text flex-1">Graph</span>
          {settling && <Loader2 className="w-3 h-3 text-sol-text-dim animate-spin" />}
          <button
            type="button"
            onClick={onClose}
            title="Close graph"
            className="text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="text-sol-text-dim tabular-nums">
          {graph.nodes.length} note{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} link
          {graph.edges.length === 1 ? "" : "s"}
        </div>

        {hasLocalAnchor && (
          <div className="flex rounded-md border border-sol-border overflow-hidden">
            {(["vault", "local"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                className={`flex-1 px-2 py-1 transition-colors ${
                  scope === option
                    ? "bg-sol-cyan text-sol-bg"
                    : "text-sol-text-muted hover:text-sol-text"
                }`}
              >
                {option === "vault" ? "Whole vault" : "Local"}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          <Filter className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-sol-text-dim" />
          <input
            ref={filterInputRef}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter notes"
            spellCheck={false}
            className="w-full bg-sol-bg border border-sol-border rounded-md pl-7 pr-2 py-1 text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan transition-colors"
          />
        </div>
        {matched && (
          <div className="text-sol-text-dim -mt-1">
            {matched.hits} match{matched.hits === 1 ? "" : "es"}
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer text-sol-text-muted hover:text-sol-text transition-colors">
          <input
            type="checkbox"
            checked={showUnresolved}
            onChange={(event) => setShowUnresolved(event.target.checked)}
            className="accent-sol-cyan"
          />
          Show unresolved links
        </label>

        <button
          type="button"
          onClick={() => setLayoutNonce((n) => n + 1)}
          className="flex items-center justify-center gap-1.5 px-2 py-1 rounded-md border border-sol-border text-sol-text-muted hover:text-sol-text hover:border-sol-cyan transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          Re-run layout
        </button>

        <div className="flex items-center gap-1.5 text-sol-text-dim pt-0.5">
          <KeyCap size="xs">esc</KeyCap>
          <span>back to notes</span>
        </div>
      </div>
    </div>
  );
}

export default VaultGraphView;
