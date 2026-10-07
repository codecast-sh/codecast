"use client";
// One project's line as a map with its panel (docs/architecture/line-map.md
// LX1 to LX3): the hero of /line and of the project's Line tab. It derives
// the map from rows the store already holds (buildLineMap over the line's
// actual graph: the repo's, the project's customized copy, or the shipped
// one), keeps its window, panel and trace in the URL so each is a link, and
// walks the nodes with the arrow keys. A trace ref (`?trace=`) lights one
// item's path (lineTrace pathNodeIds) and dims the rest.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MessageSquarePlus, SlidersHorizontal, X } from "lucide-react";
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
import { KeyHint } from "../../changes/useChangesKeys";
import { LineSettingsPage } from "../settings/LineSettingsPage";
import { useProjectStations } from "../settings/LineStations";
import { ageShort } from "../../../lib/lineFlow";
import { WHOLE_LINE } from "../../../lib/line/lineCause";
import { LineMap, MORE_SOURCES, foldSources, nodeTone, throughWord } from "./LineMap";
import { ChangeComposer } from "./ChangeComposer";
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

/** With a panel beside it the map steps back a little and never below this
 *  floor, so its words stay readable; past that it scrolls sideways (LX3),
 *  keeping the first column at its gutter (LineMap keepInView). */
const PANEL_ZOOM = 0.85;
const TONE_RANK = { fail: 0, warn: 1, ask: 2, live: 3, info: 4, idle: 5 } as const;

/** Where work waits now, under the map (LX2): each node holding work, the
 *  trouble first, with its mark's words (the same sentence the node shows)
 *  and its oldest items. A row opens its node. */
function LineMapNow({ map, asks, now, selected, onSelectNode, brief }: { map: ReturnType<typeof buildLineMap>; asks: number; now: number; selected: string | null; onSelectNode: (id: string) => void; brief?: boolean }) {
  const rows = useMemo(() => map.nodes
    .map((n) => ({ n, here: n.kind === "decide" ? asks : n.now.length, tone: nodeTone(n, n.kind === "decide" ? asks : 0) }))
    .filter((r) => r.here > 0 && r.n.kind !== "end")
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.here - a.here), [map.nodes, asks]);
  const fit = useWholeRows(rows.length, !brief);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.here, 0);
  const across = rows.length === 1 ? "one step" : `${rows.length} steps`;
  // With a panel open the panel lists the items, so the strip keeps one line
  // and gives the map its height; each name still opens its node.
  if (brief) {
    return (
      <section className="lmap-now" data-brief="true" aria-label="Where work waits now" data-map-now>
        <p className="lmap-now-line"><b>{total} waiting</b> across {across}:{" "}
          {rows.map(({ n, here, tone }, i) => (
            <span key={n.id}>{i > 0 && ", "}
              <button type="button" className="lmap-now-name" onClick={() => onSelectNode(n.id)} aria-pressed={selected === n.id} data-map-now-node={n.id} data-tone={tone}>{n.label} {here}</button>
            </span>
          ))}
        </p>
      </section>
    );
  }
  return (
    <section ref={fit.section} className="lmap-now" aria-label="Where work waits now" data-map-now data-all={fit.all ? "true" : undefined}>
      <h3 className="lmap-now-title">Now<small>{total} waiting across {across}, the trouble first</small>
        {(fit.shown < rows.length || rows.some((r) => Math.min(r.n.now.length, NOW_ITEMS) > fit.items)) && <button type="button" className="lmap-now-all" onClick={fit.showAll} data-map-now-all>Show all</button>}
      </h3>
      <div ref={fit.list} className="lmap-now-list">
        {rows.map(({ n, here, tone }, i) => {
          const mark = n.marks.find((m) => m.level !== "info");
          const oldest = n.now[0];
          const words = mark ? (mark.short ?? mark.words) : n.kind === "decide" && asks > 0 ? `${here === 1 ? "A card waits" : `${here} cards wait`} on your answer` : oldest ? `Oldest here ${ageShort(Math.max(0, now - oldest.at))}` : "";
          return (
            <button key={n.id} type="button" className="lmap-now-node" onClick={() => onSelectNode(n.id)} aria-pressed={selected === n.id} data-map-now-node={n.id} hidden={i >= fit.shown}>
              <span className="lmap-now-head"><span className="lmap-lamp" data-tone={tone} /><b>{n.label}</b><span className="lmap-now-count">{here}</span></span>
              {words && <span className="lmap-now-words" data-level={mark?.level}>{words}</span>}
              {n.now.slice(0, fit.items).map((it) => <span key={`${it.kind}:${it.id}`} className="lmap-now-item" title={it.title}>{it.title}</span>)}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** How many of a grid's cards fit its section in whole rows, so the Now
 *  strip never shows a row cut through its middle (LX2): the rest wait
 *  behind "Show all", which lets the strip scroll. Measured from the first
 *  row, against the section's own height (its flex basis is zero, so what it
 *  shows never changes the room it has). */
/** A Now card's item lines at most: its oldest items, by title. */
const NOW_ITEMS = 2;
function useWholeRows(count: number, on: boolean) {
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(count);
  // Item lines per card: fewer when even one row is taller than the room.
  const [items, setItems] = useState(NOW_ITEMS);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const sec = section.current;
    const grid = list.current;
    if (!on || all || !sec || !grid || typeof ResizeObserver === "undefined") { setFit(count); setItems(NOW_ITEMS); return; }
    const measure = () => {
      const first = grid.firstElementChild as HTMLElement | null;
      if (!first) return;
      const style = getComputedStyle(grid);
      const cols = Math.max(1, style.gridTemplateColumns.split(" ").filter(Boolean).length);
      const gap = parseFloat(style.rowGap) || 0;
      const rowH = Math.max(...[...grid.children].slice(0, cols).map((c) => (c as HTMLElement).offsetHeight));
      // The section is the grid's offset parent (position: relative), so offsetTop is already inside it.
      const room = sec.clientHeight - grid.offsetTop - (parseFloat(getComputedStyle(sec).paddingBottom) || 0);
      const rows = Math.max(1, Math.floor((room + gap) / (rowH + gap)));
      setFit(Math.min(count, rows * cols));
      // One row is the least the strip shows: its cards drop item lines until it fits whole.
      const firstRow = [...grid.children].slice(0, cols) as HTMLElement[];
      const line = grid.querySelector<HTMLElement>(".lmap-now-item")?.offsetHeight ?? 0;
      if (!line) return;
      const tallest = firstRow.reduce((a, b) => (b.offsetHeight > a.offsetHeight ? b : a));
      const base = rowH - tallest.querySelectorAll(".lmap-now-item").length * line;
      setItems(Math.max(0, Math.min(NOW_ITEMS, Math.floor((room - base) / line))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sec);
    return () => ro.disconnect();
  }, [count, on, all]);
  const clamped = on && !all;
  return { section, list, shown: clamped ? fit : count, items: clamped ? items : NOW_ITEMS, all, showAll: () => setAll(true) };
}

/** The node the map opens on: the decide gate when a card waits on the
 *  viewer, else the node with the worst mark (a failure over a warning, the
 *  fuller one first), else the busiest. Null when nothing holds work. */
export function openTarget(nodes: readonly MapNode[], asks: number): string | null {
  if (asks > 0) {
    const decide = nodes.find((n) => n.kind === "decide");
    if (decide) return decide.id;
  }
  let best: { n: MapNode; rank: number } | null = null;
  for (const n of nodes) {
    const rank = n.marks.some((m) => m.level === "fail") ? 2 : n.marks.some((m) => m.level === "warn") ? 1 : 0;
    if (rank === 0 && n.now.length === 0) continue;
    if (!best || rank > best.rank || (rank === best.rank && n.now.length > best.n.now.length)) best = { n, rank };
  }
  return best?.n.id ?? null;
}

/** "Ask for a change to the line..." in the map's controls row (LX6), so the
 *  way to change the line shows before any node is chosen. It opens the
 *  panel's composer, scoped to the open node or the one the keyboard is on,
 *  else the whole line. */
function LineAsk({ projectId, node }: { projectId: string | null; node: MapNode | null }) {
  const [open, setOpen] = useState(false);
  const target = node && node.id !== MORE_SOURCES ? node : null;
  const label = target?.label ?? WHOLE_LINE.label;
  return (
    <span className="lmap-line-ask" data-map-line-ask={target?.id ?? WHOLE_LINE.id}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!projectId}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text disabled:opacity-50"
        title={projectId ? "An agent works the change through the line and brings you a card" : "Work under no project runs the shipped line"}
        data-map-line-ask-open
      >
        <MessageSquarePlus className="w-3 h-3" />
        <span className="max-w-[24ch] truncate">Ask for a change to {label}…</span>
      </button>
      {open && projectId && (
        <div
          className="lmap-line-ask-pop"
          role="dialog"
          aria-label={`Ask for a change to ${label}`}
          onKeyDown={(e) => {
            // The composer clears its words on the first Esc; the next closes this, not a panel.
            if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
          }}
        >
          <div className="lmap-ask-head">
            <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
            <span>Ask for a change to {label}</span>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto text-sol-text-dim hover:text-sol-text" aria-label="Close the composer"><X className="w-3.5 h-3.5" /></button>
          </div>
          <ChangeComposer node={target ?? WHOLE_LINE} projectId={projectId} autoFocus />
        </div>
      )}
    </span>
  );
}

const WINDOWS = Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[];
const KEY_DIR: Record<string, MapDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", h: "left", l: "right", k: "up", j: "down" };

// Every gate answer a run took, for the rounds of a loop the run row overwrote (lineMap runVisits).
const isGateDecision = (d: { workflow_run_id?: string; gate_node_id?: string }) => !!d.workflow_run_id && !!d.gate_node_id;
const gateSig = (d: SessionDecisionItem & { gate_node_id?: string }) => `${d.status}|${d.answer_index ?? ""}|${d.updated_at ?? 0}`;

export function LineMapView({ projectId, rows, flow, now, note, lineParam, barEnd }: {
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
  /** A link at the bar's end, after settings (the project tab's way out to every line). */
  barEnd?: ReactNode;
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
  const [sourcesOpen, setSourcesOpen] = useState<string | null>(null);

  // A trace: any ref the line knows, drawn as a path.
  const traceRows: TraceRows = useMemo(() => ({ signals: rows.signals as MapSignal[], tasks: rows.tasks, runs: rows.runs as MapRun[], decisions }), [rows, decisions]);
  const trace = useMemo(() => {
    if (!state.trace) return null;
    const resolved = resolveTraceRef(state.trace, traceRows);
    return resolved ? buildLineTrace(resolved, traceRows, { now, graph }) : null;
  }, [state.trace, traceRows, now, graph]);

  const asks = flow.awaiting.items.length;
  // Where the map opens and the cursor starts (LX2): a card waiting on you
  // first, then the worst trouble, then the busiest node. The bar's reading
  // key names the same node, so the first screen and its words agree.
  const openAt = useMemo(() => openTarget(map.nodes, asks), [map.nodes, asks]);
  // Sources past the fifth fold into one pill until it is opened, never the
  // open node, the opening one or one on a trace's path (LX2).
  const lineKey = projectId ?? "none";
  const shown = useMemo(() => {
    if (sourcesOpen === lineKey) return map;
    return foldSources(map, new Set([state.node ?? "", openAt ?? "", ...(trace?.pathNodeIds ?? [])]));
  }, [map, sourcesOpen, lineKey, state.node, openAt, trace]);
  const layout = useMemo(() => layoutLineMap(shown), [shown]);

  const node = state.node && state.node !== LINE_SETTINGS_NODE ? map.nodes.find((n) => n.id === state.node) ?? null : null;
  const edge = state.edge ? map.edges.find((e) => e.id === state.edge) ?? null : null;
  const settingsOpen = state.node === LINE_SETTINGS_NODE && !!projectId;
  const open = !!node || !!edge || settingsOpen;

  // The keyboard cursor: the open node, else where the viewer moved it, else
  // the first node holding work.
  const [cursor, setCursor] = useState<string | null>(null);
  // The legend's example: the node the map opens on when no card waits (the
  // same pick, LX2), else the busiest.
  const legendNode = useMemo(() => {
    const pick = asks === 0 && openAt ? map.nodes.find((n) => n.id === openAt) : undefined;
    if (pick) return pick;
    let best: MapNode | null = null;
    for (const n of map.nodes) if (n.now.length > 0 && (!best || n.now.length > best.now.length)) best = n;
    return best;
  }, [map.nodes, asks, openAt]);
  const firstBusy = openAt ?? map.nodes.find((n) => n.main && n.kind !== "source")?.id ?? null;
  const focused = node?.id ?? (cursor && layout.boxes.has(cursor) ? cursor : firstBusy);

  // The folded sources' pill opens in place rather than as a panel.
  const selectNode = useCallback((id: string) => {
    if (id === MORE_SOURCES) { setSourcesOpen(lineKey); return; }
    setCursor(id); set({ node: id });
  }, [set, lineKey]);
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
            {/* The reading key, in the busiest node's real numbers: big is what sits there now, small what passed in the window. */}
            {legendNode && <span data-map-legend-nums data-map-legend-node={legendNode.id} title="A node's big number is what sits there now; the small words count what passed in the window">{legendNode.label}: <b className="lmap-legend-num">{legendNode.now.length}</b> here now, {legendNode.through} {throughWord(legendNode)} in {state.window}</span>}
            <span title="Wider for more"><i />work that crossed</span>
            <span><i data-kind="loop" />sent back</span>
            <span><i data-kind="empty" />nothing yet</span>
          </span>
          <LineAsk projectId={projectId} node={node ?? (cursor ? map.nodes.find((n) => n.id === cursor) ?? null : null)} />
          {projectId && (
            <button type="button" onClick={() => set({ node: settingsOpen ? null : LINE_SETTINGS_NODE })} aria-pressed={settingsOpen} className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text" data-map-settings title="Every value of this line: its file, finders, checks and limits">
              <SlidersHorizontal className="w-3 h-3" />settings<KeyHint action="line.settings" />
            </button>
          )}
          {barEnd && <span>{barEnd}</span>}
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
        {/* Keyed by the line, so each line opens on its own work (openTarget), never at the last line's scroll. */}
        <LineMap
          key={projectId ?? "none"}
          className="lmap-fit"
          map={shown}
          layout={layout}
          selectedNode={node?.id ?? null}
          selectedEdge={edge?.id ?? null}
          focusedNode={focused}
          openAt={openAt}
          highlightPath={trace?.pathNodeIds ?? null}
          asks={asks}
          zoom={open ? PANEL_ZOOM : 1}
          onSelectNode={selectNode}
          onSelectEdge={(id) => set({ edge: id })}
        />
        <LineMapNow map={map} asks={asks} now={now} selected={node?.id ?? null} onSelectNode={selectNode} brief={open} />
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
