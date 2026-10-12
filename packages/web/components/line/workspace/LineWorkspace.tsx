"use client";
// The line app (docs/architecture/line-workspace.md LW1): one app over the
// process, a project only a filter on it. The header picks the process (the
// graphs that exist), the project filter, the auto-start switch and what waits
// for you; the left nav opens Inbox, Sources, Problems, Runs, Process (Graph
// and Notebook) and Chat on keys 1 to 6; the step drawer opens over any view.
// The selection lives in the URL (useLineSelection), so any state is a link.
// `/line` draws this over every project; a project's Line tab draws it pinned
// to that project.
import { Fragment, memo, useCallback, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, Check, ChevronDown, Inbox, MessagesSquare, Radio, SlidersHorizontal, Workflow, AlertCircle, type LucideIcon } from "lucide-react";
import { lineFilterParam, useLineProjectId, useLineSelection, useLineWorkspace, useSyncLineHistory } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../store/inboxStore";
import { useTabActive } from "../../../hooks/usePagePresence";
import { hasOpenModal, useShortcutAction, useShortcutContext } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { graphKeyOf, newestRunByTask, type GraphRun } from "../../../lib/line/lineGraphs";
import { LINE_MODES, LINE_MODE_LABELS, LINE_VIEWS, LINE_VIEW_LABELS, lineViewForKey, type LineView } from "../../../lib/line/lineWorkspaceUrl";
import { NO_PROJECT, type LineAdmission, type RollupRow } from "../../../lib/lineFlow";
import { KeyCap } from "../../KeyCap";
import { setLineOn, useLineAdmission } from "../map/useLineAdmission";
import { LineStartSwitch } from "../map/LineStartSwitch";
import { usePopover } from "./usePopover";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepDrawer } from "./StepDrawer";
import { useDrawerRequest } from "./stepDrafts";
import type { LineViewProps } from "./views/types";
import { InboxView } from "./views/InboxView";
import { SourcesView } from "./views/SourcesView";
import { filedSources } from "../../../lib/line/sourcesView";
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
  /** Draws the app inside a host's own frame, reading the same workspace (the project's Line tab), so the floor is derived once. */
  Frame?: ComponentType<{ app: ReactNode; ws: LineWorkspaceModel }>;
};

type LineWorkspaceModel = ReturnType<typeof useLineWorkspace>;

export function LineWorkspace({ projectId: pinned = null, embedded, Frame }: LineWorkspaceProps) {
  const { selection, select, href } = useLineSelection();
  const asked = useLineProjectId(pinned ? null : selection.project);
  const projectId = pinned ?? asked ?? null;
  // The case being read: the address's, else the open run's, so its runs and findings are fed whatever their age.
  const runCase = useInboxStore((st) => (selection.run ? ((st as unknown as { workflowRuns?: Record<string, { task_id?: string }> }).workflowRuns?.[selection.run]?.task_id ?? null) : null));
  const ws = useLineWorkspace(projectId, selection.graph, selection.case ?? runCase);
  const { model, project, rollups, now } = ws;
  // A `?project=` the store cannot name yet: cold until the projects arrive, then dropped from the address so it and the filter agree.
  const unresolved = !pinned && !!selection.project && !asked;
  const projectsKnown = ws.projects.length > 0;
  useWatchEffect(() => { if (unresolved && projectsKnown) select({ project: null }); }, [unresolved, projectsKnown, select]);
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
  // The drawer belongs to the Graph, and to a run's detail when asked for; no other view has one.
  const drawerView = (selection.view === "process" && selection.mode === "graph") || (runDetail && replayDrawer);
  const drawsStep = !drawerView;
  const drawerOpen = drawerView && !!(model && selection.step && model.steps[selection.step]);
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

  // A link may name its case by the problem's short ref (ct-N): the address settles on the row id every view reads,
  // read off every problem in view, so a ref on another process resolves too.
  const caseId = useMemo(() => (selection.case ? (ws.rows.tasks as Array<{ _id: string; short_id?: string }>).find((t) => t._id === selection.case || t.short_id === selection.case)?._id ?? selection.case : null), [selection.case, ws.rows.tasks]);
  const caseByRef = caseId && caseId !== selection.case ? caseId : null;
  useWatchEffect(() => { if (caseByRef) select({ case: caseByRef, run: selection.run, ask: selection.ask ? "1" : null }); }, [caseByRef, select, selection.run, selection.ask]);
  // A run or problem of another process (an Inbox row, a finding's problem) opens on its own process, never on a stand-in from the one drawn.
  const ownGraph = useMemo(() => {
    if (!model) return null;
    const runs = ws.rows.runs as unknown as GraphRun[];
    if (selection.run && !model.runs.some((r) => r.id === selection.run)) {
      const r = runs.find((x) => x._id === selection.run);
      return r ? graphKeyOf(r) : null;
    }
    if (caseId && !model.issues.some((i) => i.id === caseId)) {
      const r = newestRunByTask(runs.filter((x) => x.task_id === caseId)).get(caseId);
      // A problem no run has taken waits under its project's process (processIndex), as the model files it.
      return r ? graphKeyOf(r) : ws.process.task(caseId) ?? null;
    }
    return null;
  }, [model, ws.rows.runs, ws.process, selection.run, caseId]);
  useWatchEffect(() => {
    if (ownGraph && model && ownGraph !== model.graphKey && model.graphs.some((g) => g.key === ownGraph)) select({ graph: ownGraph, run: selection.run, case: selection.case, step: selection.step, tab: selection.tab, ask: selection.ask ? "1" : null });
  }, [ownGraph, model, select, selection.run, selection.case, selection.step, selection.tab, selection.ask]);
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

  const { forYou, forYouByGraph, processes: picks } = ws;
  const here = useMemo(() => new Set(model?.graphs.map((g) => g.key) ?? []), [model]);
  const counts = useMemo<Partial<Record<LineView, number>>>(() => {
    return {
      inbox: forYou,
      // The sources that filed into this process in the window, the same set the Sources view lists as filed.
      sources: filedSources(ws.rows.signals, ws.now, ws.process, model?.graphKey).size,
      problems: ws.open,
      runs: model?.runs.length ?? 0,
    };
  }, [forYou, ws.rows.signals, ws.process, ws.now, model, ws.open]);
  const live = model?.runs.filter((r) => r.live).length ?? 0;
  const View = VIEWS[selection.view];

  const app = (
    <LineNavProvider nav={nav}>
      {!unresolved && ws.historyFeeds.map((f) => <HistoryFeed key={f.projectId} projectId={f.projectId} repositories={f.repositories} />)}
      <div className="lw lw-app" data-line-workspace={projectId ?? "all"} data-line-app data-view={selection.view}>
        <header className="lw-head">
          {!embedded && <h1 className="lw-title lw-app-title">Line</h1>}
          {model && picks.length > 0 && (
            <div className="lw-seg lw-graph-pick" role="tablist" aria-label="Process">
              {picks.map((g) => {
                const mine = forYouByGraph.get(g.key) ?? 0;
                const none = !here.has(g.key) && g.key !== model.graphKey;
                return (
                  <button key={g.key} type="button" role="tab" aria-selected={g.key === model.graphKey} disabled={none} onClick={() => select({ graph: g.key })}
                    title={none ? `No runs in ${project?.title ?? "this project"}` : [`${mine} for you`, g.versions.length > 1 ? `Versions: ${g.versions.map((v) => `${v.key} (${v.runs})`).join(", ")}` : null].filter(Boolean).join("\n")} data-line-graph-pick={g.key}>
                    {g.title}
                    {g.live > 0 && <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-label={`${g.live} running`} />}
                    {mine > 0 && <span className="lw-pick-you" aria-label={`${mine} for you`}><span className="lw-dot" aria-hidden /><span className="lw-num">{mine}</span></span>}
                  </button>
                );
              })}
            </div>
          )}
          {!embedded && <ProjectFilter selected={projectId} rollups={ws.allRollups} projects={ws.projects} byProject={ws.byProject} total={{ forYou, open: ws.open }} onPick={(p) => select({ project: p })} />}

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
              {!model || unresolved ? <Skeleton /> : (
                <div className="lw-stage-in" key={`${selection.view}:${selection.mode}:${model.graphKey}:${projectId ?? "all"}`}>
                  <View model={model} workspace={ws} selection={selection} select={select} href={href} drawerOpen={drawerOpen} pinned={!!pinned} />
                </div>
              )}
            </main>
            <StepDrawer model={model} selection={drawerSelection} select={select} sources={ws.sources} now={ws.now} />
          </div>
        </div>
      </div>
    </LineNavProvider>
  );
  return Frame ? <Frame app={app} ws={ws} /> : app;
}

/** One project's history, fed while the line shows every project. */
function HistoryFeed({ projectId, repositories }: { projectId: string; repositories: string }) {
  useSyncLineHistory(projectId, repositories);
  return null;
}

/** The project filter: every project by default; a dropdown of the projects with work on the line, each with what waits there. */
function ProjectFilter({ selected, rollups, projects, byProject, total, onPick }: { selected: string | null; rollups: RollupRow[]; projects: ReturnType<typeof useLineWorkspace>["projects"]; byProject: ReturnType<typeof useLineWorkspace>["byProject"]; total: { forYou: number; open: number }; onPick: (param: string | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  const has = (k: string) => { const n = byProject.get(k); return n?.forYou || n?.open ? 0 : 1; };
  const rows = rollups.filter((r) => r.key !== NO_PROJECT).sort((a, b) => has(a.key) - has(b.key) || a.title.localeCompare(b.title));
  const current = selected ? projects.find((p) => p._id === selected) ?? null : null;
  // Over every project the row reads the nav's own counts; filtered, the projects' sum.
  const sum = (k: "forYou" | "open") => (selected ? rows.reduce((n, r) => n + (byProject.get(r.key)?.[k] ?? 0), 0) : total[k]);
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip lw-filter" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-line-project-filter={current ? lineFilterParam(current, projects) : "all"}>
        <span className="lw-chip-t">{current?.title ?? "All projects"}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Project">
          <div className="lw-pop-h"><span className="lw-filter-check" /><span className="lw-filter-name">Project</span><span title="Waiting on you, in this process">You</span><span title="Problems not done, in this process">Open</span></div>
          <button type="button" role="option" aria-selected={!selected} onClick={() => { onPick(null); setOpen(false); }} data-line-project-option="all">
            <span className="lw-filter-check">{!selected && <Check className="w-3.5 h-3.5" />}</span>
            <span className="lw-filter-name">All projects</span>
            <span className="lw-num lw-tone-ask">{sum("forYou") || "–"}</span>
            <span className="lw-num">{sum("open")}</span>
          </button>
          {rows.map((r, i) => {
            const p = projects.find((x) => x._id === r.key);
            const on = r.key === selected;
            const n = byProject.get(r.key);
            const empty = !n?.forYou && !n?.open;
            // Projects with nothing in this process sit below a rule, dimmed: still a filter, never the headline.
            const firstEmpty = empty && (i === 0 || (() => { const m = byProject.get(rows[i - 1].key); return !!(m?.forYou || m?.open); })());
            return (
              <Fragment key={r.key}>
                {firstEmpty && <div className="lw-filter-rule" role="separator" />}
                <button type="button" role="option" aria-selected={on} data-empty={empty ? "" : undefined} onClick={() => { onPick(p ? lineFilterParam(p, projects) : r.short_id ?? r.key); setOpen(false); }} data-line-project-option={r.short_id ?? r.key} >
                  <span className="lw-filter-check">{on && <Check className="w-3.5 h-3.5" />}</span>
                  <span className="lw-filter-name">{r.title}</span>
                  <span className="lw-num lw-tone-ask">{n?.forYou || "–"}</span>
                  <span className="lw-num">{n?.open || "–"}</span>
                </button>
              </Fragment>
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
        <span className="lw-chip-t">Auto-start <span className="lw-num">{a.on ? `${a.busy ?? 0}/${a.slots}` : "off"}</span></span>
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
      <button type="button" className="lw-chip" data-on={on > 0 ? "" : undefined} aria-expanded={open} onClick={() => setOpen(!open)} data-line-start-chip={`${on}/${rows.length}`} title={`${on} of ${rows.length} projects start work on their own`}>
        <span className="lw-switch" aria-hidden />
        <span className="lw-chip-t">Auto-start <span className="lw-num">{on}/{rows.length}</span></span>
      </button>
      {open && (
        <div className="lw-pop lw-autostart-pop" role="dialog" aria-label="Auto-start by project">
          <div className="lw-pop-h lw-autostart-h"><span className="lw-filter-name">Project</span><span>Waiting</span><span>Auto</span></div>
          {rows.map((r) => <AutoStartRow key={r.key} row={r} admission={admissions.get(r.key)} />)}
        </div>
      )}
    </div>
  );
}

/** One project's start switch in the list: its name, what waits there, and the switch (or why there is none). */
export function AutoStartRow({ row, admission: a }: { row: RollupRow; admission: LineAdmission | undefined }) {
  return (
    <div className="lw-autostart-row" data-line-autostart={row.short_id ?? row.key}>
      <span className="lw-filter-name">{row.title}</span>
      <span className="lw-num" title={`${row.causes} waiting`}>{row.causes}</span>
      {a?.role ? (
        <button type="button" role="switch" aria-checked={a.on} aria-label={`Auto-start ${row.title}`} className="lw-chip lw-switch-btn" data-on={a.on ? "" : undefined} onClick={() => setLineOn(a.role!.id, !a.on)} title={a.role.paused ? `@${a.role.handle} is paused` : `@${a.role.handle}`}>
          <span className="lw-switch" aria-hidden />
        </button>
      ) : (
        <Link href={lineSettingsHref({ project: row.short_id ?? row.key })} className="lw-autostart-none">No lead</Link>
      )}
    </div>
  );
}
