"use client";
// The line app (docs/architecture/line-workspace.md LW1): one app over the
// process, a project only a filter on it. The header picks the process (the
// graphs that exist), the project filter, the auto-start switch and what waits
// for you; the left nav opens Inbox, Sources, Problems, Runs, Process (Graph
// and Notebook) and Chat on keys 1 to 6; the step drawer opens over any view.
// The selection lives in the URL (useLineSelection), so any state is a link.
// `/line` draws this over every project; a project's Line tab draws it pinned
// to that project.
import { memo, useCallback, useMemo, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Check, ChevronDown, Inbox, MessagesSquare, Radio, SlidersHorizontal, Workflow, AlertCircle, type LucideIcon } from "lucide-react";
import { useLineProjectId, useLineSelection, useLineWorkspace, useSyncLineHistory } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { hasOpenModal, useShortcutAction, useShortcutContext } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { graphTitle } from "../../../lib/line/lineGraphs";
import { buildLineInbox, inboxCount } from "../../../lib/line/lineInbox";
import { LINE_MODES, LINE_MODE_LABELS, LINE_VIEWS, LINE_VIEW_LABELS, lineViewForKey, type LineView } from "../../../lib/line/lineWorkspaceUrl";
import { NO_PROJECT, type RollupRow } from "../../../lib/lineFlow";
import { KeyCap } from "../../KeyCap";
import { useLineAdmission } from "../map/useLineAdmission";
import { LineStartSwitch } from "../map/LineStartSwitch";
import { usePopover } from "./usePopover";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepDrawer } from "./StepDrawer";
import { useDrawerRequest } from "./stepDrafts";
import type { LineViewProps } from "./views/types";
import { InboxView } from "./views/InboxView";
import { SourcesView } from "./views/SourcesView";
import { ProblemsView } from "./views/ProblemsView";
import { RunsView } from "./views/RunsView";
import { ProcessView } from "./views/ProcessView";
import { ChatView } from "./views/ChatView";
import "./workspace.css";

// Imported with the shell, so a press on 1 to 6 paints the view in the same
// frame: a lazy view would hold the switch on a fallback for React's 300ms
// reveal throttle even once loaded. A view's own heavy parts load lazily inside it.
// Each is memoized: the shell hosts the line's feeders, so it re-renders on
// every push, and a view re-renders only when the model, the workspace or the
// selection it reads moved.
const VIEWS: Record<LineView, ComponentType<LineViewProps>> = { inbox: memo(InboxView), sources: memo(SourcesView), problems: memo(ProblemsView), runs: memo(RunsView), process: memo(ProcessView), chat: memo(ChatView) };
const ICONS: Record<LineView, LucideIcon> = { inbox: Inbox, sources: Radio, problems: AlertCircle, runs: Bot, process: Workflow, chat: MessagesSquare };

function Skeleton() {
  return <div className="lw-skeleton" aria-busy>{[70, 92, 54, 80].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
}

export type LineWorkspaceProps = {
  /** Pins the app to one project (its Line tab). Absent: the URL's `?project=` filters, else every project. */
  projectId?: string | null;
  /** Inside the project's page, which already names the project: no title, no project filter. */
  embedded?: boolean;
};

const SOURCE_WINDOW_MS = 7 * 86_400_000;

export function LineWorkspace({ projectId: pinned = null, embedded }: LineWorkspaceProps) {
  const { selection, select, href } = useLineSelection();
  const asked = useLineProjectId(pinned ? null : selection.project);
  const projectId = pinned ?? asked ?? null;
  const ws = useLineWorkspace(projectId, selection.graph, selection.case);
  const { model, project, rollups, now } = ws;
  const active = useTabActive();
  const param = project ? lineProjectParam(project) : null;

  // In the Notebook the open step is the page, so the drawer stays shut there. In a run's detail (Replay) a step moves
  // the playhead and the center card shows it; the drawer opens there only when asked for (Edit, Ask an agent, the whole prompt).
  const runDetail = selection.view === "runs" && !!selection.run;
  const drawerAsk = useDrawerRequest();
  const askSeen = useRef(drawerAsk?.n ?? 0);
  const [replayDrawer, setReplayDrawer] = useState(false);
  useWatchEffect(() => {
    if (!drawerAsk || drawerAsk.n <= askSeen.current) return;
    askSeen.current = drawerAsk.n;
    if (runDetail) setReplayDrawer(true);
  }, [drawerAsk, runDetail]);
  useWatchEffect(() => { if (!selection.step || !runDetail) setReplayDrawer(false); }, [selection.step, runDetail]);
  const drawsStep = (selection.view === "process" && selection.mode === "notebook") || (runDetail && !replayDrawer);
  const drawerOpen = !drawsStep && !!(model && selection.step && model.steps[selection.step]);
  const drawerSelection = useMemo(() => (drawsStep ? { ...selection, step: null } : selection), [drawsStep, selection]);

  const router = useRouter();
  const nav = useMemo<LineNav>(() => ({
    openStep: (id) => select({ step: id }),
    openRun: (runId, caseId) => select({ run: runId, view: "runs" }, caseId),
    stepHref: (id) => href({ step: id }),
    runHref: (runId, caseId) => href({ run: runId, view: "runs" }, caseId),
    openCase: (caseId) => select({ case: caseId, run: null, view: "problems" }),
    caseHref: (caseId) => href({ case: caseId, run: null, view: "problems" }),
    projectId: ws.home?._id,
    openPath: (path) => router.push(path),
  }), [select, href, ws.home?._id, router]);

  const setView = useCallback((v: LineView) => select({ view: v }), [select]);
  // Comma opens the line's settings, the app's settings chord without the modifier.
  const settingsHref = lineSettingsHref(param ? { project: param } : {});
  useShortcutContext("line");
  useShortcutAction("line.settings", () => { router.push(settingsHref); return true; });

  // A link may name its case by the problem's short ref (ct-N): the address settles on the row id every view reads.
  const caseByRef = selection.case && model && !model.issues.some((i) => i.id === selection.case) ? model.issues.find((i) => i.ref === selection.case)?.id ?? null : null;
  useWatchEffect(() => { if (caseByRef) select({ case: caseByRef }); }, [caseByRef, select]);
  const step = (dir: 1 | -1) => {
    if (!model || !selection.step) return;
    const i = model.order.indexOf(selection.step);
    const to = model.order[i + dir];
    if (to) select({ step: to });
  };

  // Keys: 1 to 6 open the nav's views; with a step open, ← → walk steps and Esc closes it;
  // with a run open, Esc goes back to the runs; comma opens settings.
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const v = lineViewForKey(e.key);
      if (v) { e.preventDefault(); setView(v); return; }
      if (drawerOpen) {
        if (e.key === "Escape") { e.preventDefault(); select({ step: null }); }
        else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        return;
      }
      // A problem's timeline takes Esc itself (TimelineView).
      if (e.key === "Escape" && selection.view === "runs" && selection.run) { e.preventDefault(); select({ run: null, step: null }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, setView, drawerOpen, select, model, selection.step, selection.view, selection.run]);

  const inbox = useMemo(() => buildLineInbox({ ...ws.rows, projects: ws.projects, rollups, admissions: ws.admissions, now }), [ws.rows, ws.projects, rollups, ws.admissions, now]);
  const forYou = inboxCount(inbox);
  const counts = useMemo<Partial<Record<LineView, number>>>(() => {
    const since = now - SOURCE_WINDOW_MS;
    return {
      inbox: forYou,
      sources: new Set(ws.rows.signals.filter((s) => s.created_at >= since).map((s) => s.source)).size,
      problems: model?.issues.filter((i) => i.status !== "done" && i.status !== "dropped").length ?? 0,
      runs: model?.runs.length ?? 0,
    };
  }, [forYou, ws.rows.signals, model, now]);
  const live = model?.runs.filter((r) => r.live).length ?? 0;
  const View = VIEWS[selection.view];

  return (
    <LineNavProvider nav={nav}>
      {ws.historyFeeds.map((f) => <HistoryFeed key={f.projectId} projectId={f.projectId} repositories={f.repositories} />)}
      <div className="lw lw-app" data-line-workspace={projectId ?? "all"} data-line-app data-view={selection.view}>
        <header className="lw-head">
          {!embedded && <h1 className="lw-title lw-app-title">Line</h1>}
          {model && model.graphs.length > 0 && (
            <div className="lw-seg lw-graph-pick" role="tablist" aria-label="Process">
              {model.graphs.map((g) => (
                <button key={g.key} type="button" role="tab" aria-selected={g.key === model.graphKey} onClick={() => select({ graph: g.key })} title={g.work} data-line-graph-pick={g.key}>
                  {graphTitle(g.key, g.title)}
                  <span className="lw-num">{g.runs}</span>
                  {g.live > 0 && <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-label={`${g.live} running`} />}
                </button>
              ))}
            </div>
          )}
          {!embedded && <ProjectFilter selected={projectId} rollups={ws.allRollups} projects={ws.projects} onPick={(p) => select({ project: p })} />}

          <div className="lw-head-right">
            {projectId ? <StartChip projectId={projectId} rollup={ws.rollup} /> : <AutoStartAll rollups={rollups} admissions={ws.admissions} />}
            <button type="button" className="lw-chip" data-tone={forYou > 0 ? "ask" : undefined} onClick={() => setView("inbox")} data-line-waits={forYou}>
              {forYou > 0 && <span className="lw-dot" />}<span className="lw-chip-t"><span className="lw-num">{forYou}</span> for you</span>
            </button>
            <Link href={settingsHref} className="lw-iconbtn" aria-label="Line settings" title="Settings (,)"><SlidersHorizontal className="w-4 h-4" /></Link>
          </div>
        </header>

        <div className="lw-app-body">
          <nav className="lw-nav" aria-label="Line" data-line-nav>
            {LINE_VIEWS.map((v, i) => {
              const Icon = ICONS[v];
              const n = counts[v];
              return (
                <div key={v} className="lw-nav-group">
                  <button type="button" className="lw-nav-item" aria-current={selection.view === v ? "page" : undefined} aria-keyshortcuts={String(i + 1)} onClick={() => setView(v)} data-line-view-tab={v}>
                    <Icon className="lw-nav-icon" aria-hidden />
                    <span className="lw-nav-label">{LINE_VIEW_LABELS[v]}</span>
                    {v === "runs" && live > 0 && <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-label={`${live} running`} />}
                    {n != null && n > 0 && <span className="lw-nav-count" data-tone={v === "inbox" ? "ask" : undefined}>{n}</span>}
                    <span className="lw-nav-key" aria-hidden><KeyCap size="xs">{i + 1}</KeyCap></span>
                  </button>
                  {v === "process" && (
                    <div className="lw-nav-sub" role="group" aria-label="Process mode">
                      {LINE_MODES.map((m) => (
                        <button key={m} type="button" className="lw-nav-item lw-nav-subitem" aria-current={selection.view === "process" && selection.mode === m ? "page" : undefined} onClick={() => select({ view: "process", mode: m })} data-line-mode-tab={m}>
                          <span className="lw-nav-label">{LINE_MODE_LABELS[m]}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          <div className="lw-body" data-drawer-open={drawerOpen ? "" : undefined}>
            <main className="lw-stage">
              {!model ? <Skeleton /> : (
                <div className="lw-stage-in" key={`${selection.view}:${selection.mode}:${model.graphKey}:${projectId ?? "all"}`}>
                  <View model={model} workspace={ws} selection={selection} select={select} href={href} drawerOpen={drawerOpen} />
                </div>
              )}
            </main>
            <StepDrawer model={model} selection={drawerSelection} select={select} signals={ws.rows.signals} now={ws.now} />
          </div>
        </div>
      </div>
    </LineNavProvider>
  );
}

/** One project's history, fed while the line shows every project. */
function HistoryFeed({ projectId, repositories }: { projectId: string; repositories: string }) {
  useSyncLineHistory(projectId, repositories);
  return null;
}

/** The project filter: every project by default; a dropdown of the projects with work on the line, each with what waits there. */
function ProjectFilter({ selected, rollups, projects, onPick }: { selected: string | null; rollups: RollupRow[]; projects: ReturnType<typeof useLineWorkspace>["projects"]; onPick: (param: string | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  const rows = rollups.filter((r) => r.key !== NO_PROJECT).sort((a, b) => a.title.localeCompare(b.title));
  const current = selected ? projects.find((p) => p._id === selected) ?? null : null;
  const total = rows.reduce((n, r) => n + r.causes, 0);
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip lw-filter" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-line-project-filter={current ? lineProjectParam(current) : "all"}>
        <span className="lw-chip-t">{current?.title ?? "All projects"}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Project">
          <button type="button" role="option" aria-selected={!selected} onClick={() => { onPick(null); setOpen(false); }} data-line-project-option="all">
            <span className="lw-filter-check">{!selected && <Check className="w-3.5 h-3.5" />}</span>
            <span className="lw-filter-name">All projects</span>
            <span className="lw-num">{total}</span>
          </button>
          {rows.map((r) => {
            const p = projects.find((x) => x._id === r.key);
            const on = r.key === selected;
            return (
              <button key={r.key} type="button" role="option" aria-selected={on} onClick={() => { onPick(p ? lineProjectParam(p) : r.short_id ?? r.key); setOpen(false); }} data-line-project-option={r.short_id ?? r.key} title={`${r.causes} waiting`}>
                <span className="lw-filter-check">{on && <Check className="w-3.5 h-3.5" />}</span>
                <span className="lw-filter-name">{r.title}</span>
                {r.awaiting > 0 && <span className="lw-num lw-tone-ask">{r.awaiting}</span>}
                <span className="lw-num">{r.causes}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** One project's auto-start: the chip shows on or off, and opens its switch with its slots and what it would start. */
function StartChip({ projectId, rollup }: { projectId: string; rollup: RollupRow | null }) {
  const admit = useLineAdmission(projectId);
  const { open, setOpen, ref } = usePopover();
  const a = admit.admission;
  if (!a?.role) return null;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip" data-on={a.on ? "" : undefined} aria-expanded={open} onClick={() => setOpen(!open)}
        title={a.role.paused ? `@${a.role.handle} is paused` : a.on ? "Starts waiting problems itself" : "Starts nothing itself"} data-line-start-chip={a.on ? "on" : "off"}>
        <span className="lw-switch" aria-hidden />
        <span className="lw-chip-t">Auto-start</span>
      </button>
      {open && (
        <div className="lw-pop lw-start-pop" role="dialog" aria-label="Auto-start" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          <LineStartSwitch admit={admit} waiting={rollup?.causes ?? null} notReady={rollup?.notReady} ready={rollup?.ready ?? null} />
        </div>
      )}
    </div>
  );
}

/** Auto-start over every project: how many lines start work on their own, and a switch per project. */
function AutoStartAll({ rollups, admissions }: { rollups: RollupRow[]; admissions: ReturnType<typeof useLineWorkspace>["admissions"] }) {
  const { open, setOpen, ref } = usePopover();
  const rows = rollups.filter((r) => r.key !== NO_PROJECT);
  const on = rows.filter((r) => admissions.get(r.key)?.on).length;
  if (rows.length === 0) return null;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip" data-on={on > 0 ? "" : undefined} aria-expanded={open} onClick={() => setOpen(!open)} data-line-start-chip={`${on}/${rows.length}`}>
        <span className="lw-switch" aria-hidden />
        <span className="lw-chip-t">Auto-start <span className="lw-num">{on}/{rows.length}</span></span>
      </button>
      {open && (
        <div className="lw-pop lw-autostart-pop" role="dialog" aria-label="Auto-start by project">
          {rows.map((r) => <AutoStartRow key={r.key} row={r} />)}
        </div>
      )}
    </div>
  );
}

/** One project's start switch in the list: its name, what waits there, and the switch (or why there is none). */
export function AutoStartRow({ row }: { row: RollupRow }) {
  const admit = useLineAdmission(row.key);
  const a = admit.admission;
  return (
    <div className="lw-autostart-row" data-line-autostart={row.short_id ?? row.key}>
      <span className="lw-filter-name">{row.title}</span>
      <span className="lw-num" title={`${row.causes} waiting`}>{row.causes}</span>
      {a?.role ? (
        <button type="button" role="switch" aria-checked={a.on} aria-label={`Auto-start ${row.title}`} className="lw-chip lw-switch-btn" data-on={a.on ? "" : undefined} onClick={() => admit.setOn(!a.on)} title={a.role.paused ? `@${a.role.handle} is paused` : `@${a.role.handle}`}>
          <span className="lw-switch" aria-hidden />
        </button>
      ) : (
        <Link href={lineSettingsHref({ project: row.short_id ?? row.key })} className="lw-autostart-none">No lead</Link>
      )}
    </div>
  );
}
