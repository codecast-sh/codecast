"use client";
// One project's line as a map with its panel (docs/architecture/line-map.md
// LX1 to LX3): the hero of /line and of the project's Line tab. It derives
// the map from rows the store already holds (buildLineMap over the line's
// actual graph: the repo's, the project's customized copy, or the shipped
// one), keeps its window, panel and trace in the URL so each is a link, and
// walks the nodes with the arrow keys. A trace ref (`?trace=`) lights one
// item's path (lineTrace pathNodeIds) and dims the rest.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SlidersHorizontal, X } from "lucide-react";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import type { SessionDecisionItem } from "../../../store/inboxStore";
import { useInboxStore } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { hasOpenModal } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import type { LineFlow, LineCauseTask, LineFlowRun, LineSignal, LineDecision } from "../../../lib/lineFlow";
import { LINE_MAP_WINDOWS, buildLineMap, type LineGraph, type LineMapWindow, type MapDecision, type MapNode, type MapRun, type MapSignal } from "../../../lib/line/lineMap";
import { layoutLineMap, neighbor, type MapDirection } from "../../../lib/line/lineMapLayout";
import { LINE_SETTINGS_NODE, lineMapSearch, lineTraceHref, readLineMapState, type LineMapState } from "../../../lib/line/lineMapUrl";
import { buildLineTrace, resolveTraceRef, type TraceRows } from "../../../lib/line/lineTrace";
import { KeyCap } from "../../KeyboardShortcutsHelp";
import { LineSettingsPage } from "../settings/LineSettingsPage";
import { useProjectStations } from "../settings/LineStations";
import { LineMap } from "./LineMap";
import { LineMapPanel } from "./LineMapPanel";
import "./lineMap.css";

export type LineMapRows = { signals: LineSignal[]; tasks: LineCauseTask[]; runs: LineFlowRun[]; decisions: LineDecision[] };

/** The map's URL state, read and written in place (lineMapUrl). `project`
 *  pins the line on the page into the URL with the first write, so a line
 *  chosen by default (lineFlow defaultLineKey) cannot switch under a click
 *  when the default's inputs change. */
export function useLineMapUrl(project?: string | null) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const state = useMemo(() => readLineMapState(search), [search]);
  const set = useCallback((patch: Partial<Record<keyof LineMapState, string | null>>) => {
    const base = new URLSearchParams(search?.toString() ?? "");
    if (project && !base.get("project")) base.set("project", project);
    router.replace(`${pathname ?? "/line"}${lineMapSearch(base, patch)}`, { scroll: false });
  }, [router, pathname, search, project]);
  return { state, set };
}

const WINDOWS = Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[];
const KEY_DIR: Record<string, MapDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", h: "left", l: "right", k: "up", j: "down" };

// Every gate answer a run took, for the rounds of a loop the run row overwrote (lineMap runVisits).
const isGateDecision = (d: { workflow_run_id?: string; gate_node_id?: string }) => !!d.workflow_run_id && !!d.gate_node_id;
const gateSig = (d: SessionDecisionItem & { gate_node_id?: string }) => `${d.status}|${d.answer_index ?? ""}|${d.updated_at ?? 0}`;

export function LineMapView({ projectId, rows, flow, now, note, lineParam }: {
  /** The project whose line this is; null draws the shipped line for work under no project. */
  projectId: string | null;
  /** The project's rows, already scoped (lineFlow scopeLine). */
  rows: LineMapRows;
  /** The same rows read the /line way, for the decide gate's cards and the sources' health. */
  flow: LineFlow;
  now: number;
  /** One line above the map: an honest word for a line nothing has reached. */
  note?: ReactNode;
  /** The page's `?project=` for this line, pinned with the map's first write (useLineMapUrl). */
  lineParam?: string | null;
}) {
  const { state, set } = useLineMapUrl(lineParam);
  const windowMs = LINE_MAP_WINDOWS[state.window];

  // The line's actual graph and its declared finders.
  const stations = useProjectStations(projectId ?? "");
  const graph: LineGraph | null = useMemo(() => (projectId ? { nodes: stations.nodes, edges: stations.edges } : null), [projectId, stations.nodes, stations.edges]);
  const lp = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { line_profile?: PublishedLineProfile | null }>)[projectId]?.line_profile ?? null) : null));
  const answered = useCollectionRows<SessionDecisionItem & MapDecision>("sessionDecisions", { where: isGateDecision as (d: SessionDecisionItem) => boolean, sig: gateSig });
  const decisions = useMemo(() => {
    const runIds = new Set(rows.runs.map((r) => r._id));
    const byId = new Map<string, MapDecision>(rows.decisions.map((d) => [d._id, d as MapDecision]));
    for (const d of answered) if (d.workflow_run_id && runIds.has(d.workflow_run_id)) byId.set(d._id, d);
    return [...byId.values()];
  }, [rows.decisions, rows.runs, answered]);

  const map = useMemo(() => buildLineMap({
    graph, finders: lp?.finders, findersSince: lp?.changed_at,
    signals: rows.signals as MapSignal[], tasks: rows.tasks, runs: rows.runs as MapRun[], decisions, now, windowMs,
  }), [graph, lp, rows, decisions, now, windowMs]);
  const layout = useMemo(() => layoutLineMap(map), [map]);

  // A trace: any ref the line knows, drawn as a path.
  const traceRows: TraceRows = useMemo(() => ({ signals: rows.signals as MapSignal[], tasks: rows.tasks, runs: rows.runs as MapRun[], decisions }), [rows, decisions]);
  const trace = useMemo(() => {
    if (!state.trace) return null;
    const resolved = resolveTraceRef(state.trace, traceRows);
    return resolved ? buildLineTrace(resolved, traceRows, { now, graph }) : null;
  }, [state.trace, traceRows, now, graph]);

  const node = state.node && state.node !== LINE_SETTINGS_NODE ? map.nodes.find((n) => n.id === state.node) ?? null : null;
  const edge = state.edge ? map.edges.find((e) => e.id === state.edge) ?? null : null;
  const settingsOpen = state.node === LINE_SETTINGS_NODE && !!projectId;
  const open = !!node || !!edge || settingsOpen;

  // The keyboard cursor: the open node, else where the viewer moved it, else
  // the first node holding work.
  const [cursor, setCursor] = useState<string | null>(null);
  // The busiest node: where the map opens, and where the cursor starts.
  const busiest = useMemo(() => {
    let best: MapNode | null = null;
    for (const n of map.nodes) if (n.now.length > 0 && (!best || n.now.length > best.now.length)) best = n;
    return best?.id ?? null;
  }, [map.nodes]);
  const firstBusy = busiest ?? map.nodes.find((n) => n.main && n.kind !== "source")?.id ?? null;
  const focused = node?.id ?? (cursor && layout.boxes.has(cursor) ? cursor : firstBusy);

  const selectNode = useCallback((id: string) => { setCursor(id); set({ node: id }); }, [set]);
  const close = useCallback(() => set({ node: null, edge: null, section: null }), [set]);

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      // A key inside the panel belongs to what is there (a card answers with digits and return).
      const inPanel = (e.target as HTMLElement | null)?.closest?.(".lmap-panel");
      if (e.key === "Escape") {
        if (open) { e.preventDefault(); return close(); }
        if (state.trace) { e.preventDefault(); return set({ trace: null }); }
        return;
      }
      if (inPanel) return;
      const dir = KEY_DIR[e.key];
      if (dir && focused) {
        const next = neighbor(layout, focused, dir);
        e.preventDefault();
        if (!next) return;
        setCursor(next);
        if (node) set({ node: next });
        return;
      }
      if (e.key === "Enter" && focused && !node && !edge) { e.preventDefault(); return selectNode(focused); }
      if (e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        set({ window: WINDOWS[(WINDOWS.indexOf(state.window) + 1) % WINDOWS.length] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layout, focused, node, edge, open, state.trace, state.window, set, close, selectNode]);

  const asks = flow.awaiting.items.length;
  const empty = map.nodes.every((n) => n.through === 0 && n.now.length === 0);

  return (
    <div className="lmap-view" data-line-map-view data-window={state.window}>
      <div className="lmap-main">
        <div className="lmap-bar">
          <div className="lmap-windows" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} type="button" aria-pressed={state.window === w} onClick={() => set({ window: w })} data-map-window={w} title={`What passed in the last ${w}`}>{w}</button>
            ))}
          </div>
          <span className="lmap-legend" aria-hidden>
            <span data-map-legend-nums title="A node's big number is what sits there now; the small words count what passed in the window"><b className="lmap-legend-num">48</b> here now, 6 passed in {state.window}</span>
            <span title="Wider for more"><i />work that crossed</span>
            <span><i data-kind="loop" />sent back</span>
            <span><i data-kind="empty" />nothing yet</span>
          </span>
          {projectId && (
            <button type="button" onClick={() => set({ node: settingsOpen ? null : LINE_SETTINGS_NODE })} aria-pressed={settingsOpen} className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text" data-map-settings title="Every value of this line: its file, finders, checks and limits">
              <SlidersHorizontal className="w-3 h-3" />all settings
            </button>
          )}
        </div>
        {empty && (note ?? <p className="lmap-note" data-map-empty>Nothing passed through this line in the last {state.window}. The map shows its stations; counts fill in as work arrives.</p>)}
        {state.trace && (
          <div className="lmap-trace-bar" data-map-trace={state.trace}>
            <span className="min-w-0 truncate text-sol-text">
              {trace ? <><b className="font-semibold">{trace.cause.title}</b><span className="text-sol-text-muted">: {trace.where.text}</span></> : <>No cause on this line matches {state.trace}.</>}
            </span>
            <span className="ml-auto shrink-0 flex items-center gap-3 text-[11px]">
              {trace && <Link href={lineTraceHref(state.trace)} className="text-sol-blue hover:underline">full trace</Link>}
              <button type="button" onClick={() => set({ trace: null })} className="inline-flex items-center gap-1 text-sol-text-dim hover:text-sol-text" aria-label="Stop tracing">
                <X className="w-3 h-3" />
              </button>
            </span>
          </div>
        )}
        <LineMap
          className="lmap-fill"
          map={map}
          layout={layout}
          selectedNode={node?.id ?? null}
          selectedEdge={edge?.id ?? null}
          focusedNode={focused}
          openAt={busiest}
          highlightPath={trace?.pathNodeIds ?? null}
          asks={asks}
          onSelectNode={selectNode}
          onSelectEdge={(id) => set({ edge: id })}
        />
        <footer className="lmap-panel-foot" data-map-keys>
          <span><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap>nodes</span>
          <span><KeyCap size="xs">↵</KeyCap>open</span>
          {(open || state.trace) && <span><KeyCap size="xs">Esc</KeyCap>{open ? "close" : "stop tracing"}</span>}
          <span><KeyCap size="xs">w</KeyCap>window</span>
        </footer>
      </div>
      {settingsOpen && projectId ? (
        <aside className="lmap-panel" data-wide="true" aria-label="Line settings" data-map-panel={LINE_SETTINGS_NODE}>
          <div className="lmap-panel-head">
            <div className="lmap-panel-title">
              <h2>This line's settings</h2>
              <button type="button" onClick={close} className="ml-auto shrink-0 inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text" aria-label="Close the panel" data-map-panel-close>
                <KeyCap size="xs">Esc</KeyCap><X className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="lmap-panel-what">Every value of the line at once. Each also shows on the node it shapes.</p>
          </div>
          <div className="flex-1 min-h-0 flex flex-col"><LineSettingsPage project={projectId} /></div>
        </aside>
      ) : open ? (
        <LineMapPanel
          map={map}
          node={node}
          edge={edge}
          projectId={projectId}
          flow={flow}
          now={now}
          tracing={state.trace}
          onTrace={(ref) => set({ trace: state.trace === ref ? null : ref })}
          onSelectNode={selectNode}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
