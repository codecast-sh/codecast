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
import { ageShort, causesNeverRun } from "../../../lib/lineFlow";
import { WHOLE_LINE } from "../../../lib/line/lineCause";
import { LineMap, MORE_SOURCES, foldSources, nodeTone, throughWords } from "./LineMap";
import { ChangeComposer } from "./ChangeComposer";
import { LineMapPanel, AskProjectPick, useProjectTitle } from "./LineMapPanel";
import type { useLineAdmission } from "./useLineAdmission";
import { cn } from "../../../lib/utils";
import { projectLineVersions } from "../../../lib/line/runReport";
import { lineMetrics } from "../../../lib/line/lineMetrics";
import { lineMetricsPhrases, windowWords } from "../../../lib/line/lineMetricsWords";
import { graphKeyOf, type ProjectGraph } from "../../../lib/line/lineGraphs";
import { useLineGraph } from "./useLineGraph";
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
 *  and its oldest items. A row opens its node. With a panel open the map
 *  stays as tall as its line and Now takes the height under it, so the
 *  column never ends in empty canvas. */
function LineMapNow({ map, asks, now, selected, onSelectNode }: { map: ReturnType<typeof buildLineMap>; asks: number; now: number; selected: string | null; onSelectNode: (id: string) => void }) {
  const rows = useMemo(() => map.nodes
    .map((n) => ({ n, here: n.kind === "decide" ? asks : n.now.length, tone: nodeTone(n, n.kind === "decide" ? asks : 0) }))
    .filter((r) => r.here > 0 && r.n.kind !== "end")
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.here - a.here), [map.nodes, asks]);
  const fit = useWholeRows(rows.length);
  if (!rows.length) return null;
  const total = rows.reduce((s, r) => s + r.here, 0);
  const across = rows.length === 1 ? "one step" : `${rows.length} steps`;
  return (
    <section ref={fit.section} className="lmap-now" aria-label="Where work waits now" data-map-now data-all={fit.all ? "true" : undefined}>
      <h3 className="lmap-now-title">Now<small>{total} waiting across {across}, the trouble first</small>
        {(fit.shown < rows.length || rows.some((r) => Math.min(r.n.now.length, NOW_ITEMS) > fit.items)) && <button type="button" className="lmap-now-all" onClick={fit.showAll} data-map-now-all>Show all</button>}
      </h3>
      <div ref={fit.list} className="lmap-now-list">
        {rows.map(({ n, here, tone }, i) => {
          const mark = n.marks.find((m) => m.level !== "info");
          const oldest = n.now[0];
          // One line per node: its name, the count beside it, then the one fact worth reading ("Causes 3 · oldest 3d").
          const said = mark ? (mark.short ?? mark.words) : null;
          // A sentence-case mark reads mid-line after the dot; a name ("AgentWatch") keeps its case.
          const words = said ? (/^[A-Z][a-z]/.test(said) ? `${said[0].toLowerCase()}${said.slice(1)}` : said) : n.kind === "decide" && asks > 0 ? "waiting on your answer" : oldest ? `oldest ${ageShort(Math.max(0, now - oldest.at))}` : "";
          return (
            <button key={n.id} type="button" className="lmap-now-node" onClick={() => onSelectNode(n.id)} aria-pressed={selected === n.id} data-map-now-node={n.id} hidden={i >= fit.shown}>
              <span className="lmap-now-head">
                <span className="lmap-lamp" data-tone={tone} /><b>{n.label}</b><span className="lmap-now-count">{here}</span>
                {words && <span className="lmap-now-words" data-level={mark?.level} data-map-now-words>· {words}</span>}
              </span>
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
function useWholeRows(count: number) {
  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(count);
  // Item lines per card: fewer when even one row is taller than the room.
  const [items, setItems] = useState(NOW_ITEMS);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const sec = section.current;
    const grid = list.current;
    if (all || !sec || !grid || typeof ResizeObserver === "undefined") { setFit(count); setItems(NOW_ITEMS); return; }
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
      const tallest = firstRow.reduce((a, b) => (b.offsetHeight > a.offsetHeight ? b : a));
      // A title takes one or two lines, so an item is its card's average.
      const its = [...tallest.querySelectorAll<HTMLElement>(".lmap-now-item")];
      const line = its.length ? its.reduce((h, it) => h + it.offsetHeight, 0) / its.length : 0;
      if (!line) return;
      const base = rowH - its.length * line;
      setItems(Math.max(0, Math.min(NOW_ITEMS, Math.floor((room - base) / line))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sec);
    return () => ro.disconnect();
  }, [count, all]);
  const clamped = !all;
  return { section, list, shown: clamped ? fit : count, items: clamped ? items : NOW_ITEMS, all, showAll: () => setAll(true) };
}

/** The node the map opens on: the decide gate when a card waits on the
 *  viewer, else the worst trouble that holds work now, else the worst mark
 *  anywhere (a failure over a warning, the fuller one first), else the
 *  busiest. A warned queue holding work (80 causes, the oldest far past the
 *  norm) outranks a failure mark on a node with nothing in it now: the pile
 *  is what the viewer can act on. The legend reads the same pick, so the
 *  first screen and its words agree. Null when nothing holds work. */
export function openTarget(nodes: readonly MapNode[], asks: number): string | null {
  if (asks > 0) {
    const decide = nodes.find((n) => n.kind === "decide");
    if (decide) return decide.id;
  }
  const level = (n: MapNode) => (n.marks.some((m) => m.level === "fail") ? 2 : n.marks.some((m) => m.level === "warn") ? 1 : 0);
  let best: { n: MapNode; rank: number } | null = null;
  for (const n of nodes) {
    const lv = level(n);
    if (lv === 0 && n.now.length === 0) continue;
    // Trouble with work in it first, then trouble that is only history, then the busiest.
    const rank = lv > 0 && n.now.length > 0 ? 2 + lv : lv;
    if (!best || rank > best.rank || (rank === best.rank && n.now.length > best.n.now.length)) best = { n, rank };
  }
  return best?.n.id ?? null;
}

/** "Ask for a change" in the map's controls row (LX6), so the way to change
 *  the line shows before any node is chosen. It opens the composer, scoped to
 *  the node the keyboard is on, else the whole line; the popover names which.
 *  With a panel open, the panel's footer is the one entry, so this hides. */
function LineAsk({ projectId: own, node }: { projectId: string | null; node: MapNode | null }) {
  const [open, setOpen] = useState(false);
  // Work under no project runs the shipped line: the popover asks whose line to change first.
  const [picked, setPicked] = useState<string | null>(null);
  const projectId = own ?? picked;
  const pickedTitle = useProjectTitle(own ? null : picked);
  const target = node && node.id !== MORE_SOURCES ? node : null;
  const label = target?.label ?? WHOLE_LINE.label;
  return (
    <span className="lmap-line-ask" data-map-line-ask={target?.id ?? WHOLE_LINE.id}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text"
        title={own ? "An agent works the change through the line and brings it to you to decide" : "Pick the project whose line to change; work under no project runs the shipped line"}
        data-map-line-ask-open
      >
        <MessageSquarePlus className="w-3 h-3" />
        <span className="whitespace-nowrap">Ask for a change</span>
      </button>
      {open && (
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
            <span className="min-w-0 truncate">Ask for a change to {label}{pickedTitle ? ` on ${pickedTitle}'s line` : ""}</span>
            <button type="button" onClick={() => setOpen(false)} className="ml-auto text-sol-text-dim hover:text-sol-text" aria-label="Close the composer"><X className="w-3.5 h-3.5" /></button>
          </div>
          {!own && (
            <AskProjectPick className="mb-2 flex items-center gap-2 text-[12px] text-sol-text-muted" value={picked} onChange={setPicked} />
          )}
          {projectId && <ChangeComposer node={target ?? WHOLE_LINE} projectId={projectId} autoFocus />}
        </div>
      )}
    </span>
  );
}

const WINDOWS = Object.keys(LINE_MAP_WINDOWS) as LineMapWindow[];

/** How the line's quality is going over the map's window (lineMetrics, LM8):
 *  expectation breaks a day, the share of signals that joined a known cause,
 *  and the fixes that held, as one sentence under the bar. */
function LineMapQuality({ rows, now, windowMs, window: w }: { rows: LineMapRows; now: number; windowMs: number; window: LineMapWindow }) {
  const phrases = useMemo(() => lineMetricsPhrases(lineMetrics({
    signals: rows.signals, tasks: rows.tasks, runs: rows.runs, window: { from: now - windowMs, to: now }, now,
  })), [rows.signals, rows.tasks, rows.runs, now, windowMs]);
  const lead = windowWords(w);
  return (
    <p className="lmap-note lmap-quality" data-map-quality data-window={w}>
      <span className="lmap-quality-lead">In {lead}:</span>{" "}
      {phrases.map((p, i) => (
        <span key={p.key} data-map-quality-metric={p.key} data-empty={p.num === null ? "true" : undefined} title={p.tip}>
          {i > 0 && <span className="lmap-quality-sep" aria-hidden> · </span>}
          {p.num !== null && <b>{p.num}</b>}{p.text}
        </span>
      ))}
    </p>
  );
}
const KEY_DIR: Record<string, MapDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", h: "left", l: "right", k: "up", j: "down" };

// Every gate answer a run took, for the rounds of a loop the run row overwrote (lineMap runVisits).
const isGateDecision = (d: { workflow_run_id?: string; gate_node_id?: string }) => !!d.workflow_run_id && !!d.gate_node_id;
const gateSig = (d: SessionDecisionItem & { gate_node_id?: string }) => `${d.status}|${d.answer_index ?? ""}|${d.updated_at ?? 0}`;

export function LineMapView({ projectId, rows: allRows, flow, now, note, lineParam, barEnd, footEnd, admit }: {
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
  /** The page's own keys and links, right-aligned on the map's key row, so the hints take one line. */
  footEnd?: ReactNode;
  /** Whether the line may start its next cause, and its controls (useLineAdmission). */
  admit?: ReturnType<typeof useLineAdmission>;
}) {
  const { state, set } = useLineMapUrl(lineParam);
  const windowMs = LINE_MAP_WINDOWS[state.window];

  // The graphs this project's work actually runs (lineGraphs), each read off
  // its runs: codecast's line from the project's own copy, the repo's or the
  // shipped one; any other graph from the row its newest run ran, or, when
  // that row cannot be read, from the stations its runs recorded.
  const { graphs, graphKey, picked, ownLine, source, graph, unread } = useLineGraph(projectId, allRows.runs as MapRun[], allRows.signals, state.graph);
  // The runs drawn are the ones that ran the graph on show; the queue, the
  // signals and the cards stay the whole project's.
  const rows = useMemo(() => (graphs.length > 1 ? { ...allRows, runs: allRows.runs.filter((r) => graphKeyOf(r as MapRun) === graphKey) } : allRows), [allRows, graphs.length, graphKey]);
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
    signals: rows.signals as MapSignal[], tasks: rows.tasks, runs: rows.runs as MapRun[], decisions, now, windowMs, admission: admit?.admission,
  }), [graph, lp, rows, decisions, now, windowMs, admit?.admission]);
  const [sourcesOpen, setSourcesOpen] = useState<string | null>(null);

  // What each version of this project's line delivered, for a station's history (LX3).
  const versions = useMemo(() => (projectId ? projectLineVersions(rows) : undefined), [projectId, rows]);
  // A trace: any ref the line knows, drawn as a path.
  const traceRows: TraceRows = useMemo(() => ({ signals: allRows.signals as MapSignal[], tasks: allRows.tasks, runs: allRows.runs as MapRun[], decisions }), [allRows, decisions]);
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
  const lineKey = `${projectId ?? "none"}:${graphKey}`;
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
  const neverRun = useMemo(() => causesNeverRun(flow, rows.runs), [flow, rows.runs]);

  return (
    <div className="lmap-view" data-line-map-view data-window={state.window} data-map-graph={graphKey}>
      <div className="lmap-main">
        {projectId && graphs.length > 0 && (
          <GraphTabs graphs={graphs} selected={graphKey} onSelect={(key) => set({ graph: key === graphs[0]?.key ? null : key, node: null, edge: null, trace: null })} unread={unread} neverRun={neverRun} />
        )}
        <div className="lmap-bar">
          <div className="lmap-windows" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} type="button" aria-pressed={state.window === w} onClick={() => set({ window: w })} data-map-window={w} title={`What passed in the last ${w}`}>{w}</button>
            ))}
          </div>
          <span className="lmap-legend" aria-hidden>
            {/* The reading key, in the busiest node's real numbers: big is what sits there now, small what passed in the window. */}
            {legendNode && <span data-map-legend-nums data-map-legend-node={legendNode.id} title="A node's big number is what sits there now; the small words count what passed in the window">{legendNode.label}: <b className="lmap-legend-num">{legendNode.now.length}</b> here now, {throughWords(legendNode)} in {state.window}</span>}
            <span title="Wider for more work"><i />path work took</span>
            <span><i data-kind="loop" />sent back</span>
            <span><i data-kind="empty" />path not used yet</span>
          </span>
          {!open && <LineAsk projectId={projectId} node={cursor ? map.nodes.find((n) => n.id === cursor) ?? null : null} />}
          {projectId && (
            <button type="button" onClick={() => set({ node: settingsOpen ? null : LINE_SETTINGS_NODE })} aria-pressed={settingsOpen} className={cn("inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim hover:text-sol-text", open && "ml-auto")} data-map-settings title="Every setting of this line: its sources, checks and limits">
              <SlidersHorizontal className="w-3 h-3" />settings<KeyHint action="line.settings" />
            </button>
          )}
          {barEnd && <span>{barEnd}</span>}
        </div>
        {!empty && <LineMapQuality rows={rows} now={now} windowMs={windowMs} window={state.window} />}
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
          key={lineKey}
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
        <LineMapNow map={map} asks={asks} now={now} selected={node?.id ?? null} onSelectNode={selectNode} />
        <footer className="lmap-panel-foot" data-map-keys>
          <span><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap>nodes</span>
          <span><KeyCap size="xs">↵</KeyCap>open</span>
          {(open || state.trace) && <span><KeyCap size="xs">Esc</KeyCap>{open ? "close" : "stop tracing"}</span>}
          <span><KeyCap size="xs">w</KeyCap>window</span>
          {footEnd}
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
          admit={admit}
          versions={versions}
          stations={source ? { ...source, foreign: !ownLine } : null}
          graphTitle={picked?.title ?? null}
        />
      ) : null}
    </div>
  );
}

/** The graphs this project's work runs, one tab each, labeled by the work
 *  that goes through it (lineGraphs projectGraphs). `unread`: the graph's own
 *  row could not be read, so its stations come from what its runs recorded. */
function GraphTabs({ graphs, selected, onSelect, unread, neverRun }: { graphs: ProjectGraph[]; selected: string; onSelect: (key: string) => void; unread: boolean; neverRun: number }) {
  return (
    <div className="lmap-graphs" data-map-graphs>
      <span className="lmap-graphs-lead">{graphs.length > 1 ? `Work here runs through ${graphs.length} lines` : "Work here runs through"}</span>
      <div className="lmap-graphs-tabs" role="tablist" aria-label="Lines this project runs">
        {graphs.map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={g.key === selected} onClick={() => onSelect(g.key)} className="lmap-graph-tab" data-map-graph-tab={g.key}>
            <b>{g.title}</b>
            <span>{g.work}{g.live ? `, ${g.live} running now` : ""}</span>
          </button>
        ))}
      </div>
      {/* The tabs count causes their runs worked; the rest of the queue has not started on any line, said so the numbers add up. */}
      {neverRun > 0 && <span className="lmap-graphs-note" data-map-never-run>{neverRun} waiting {neverRun === 1 ? "cause has" : "causes have"} not run on any line yet</span>}
      {unread && <span className="lmap-graphs-note" data-map-graph-partial>Drawn from the steps its runs recorded; its full instructions are not shared with you.</span>}
    </div>
  );
}
