"use client";
// The flows app (doc "Signals to shipped: one pipeline"; line-journeys.md LJ4,
// LJ5; flows.md FL0): one app over every flow, its left nav the pipeline. For
// you (what waits on the viewer, read and answered there) heads it with its
// count; then Signals (every source and where it goes), Problems, Flows (the
// live flows' map) and Shipped on a rail, each one number and one state, each
// the way into its view (PipelineNav). Every view sits under one stage
// (pipeline.ts), so the nav marks where a person is whatever address they came
// by. The workspace switch heads the app; the project filter shows only on
// Problems, the one view a project narrows. Pages switch on G then D / S / P /
// F / H: the shell binds no digit, because an open decision answers on bare
// digits.
// The selection lives in the URL (useLineSelection), so any state is a link.
// `/flows` draws this over every project; `/flows/<owner>` draws it for one
// flow, pinned to a project of its own; a project's Flow tab draws it pinned
// to that project.
import { Fragment, memo, useCallback, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useStageScroll } from "./useStageScroll";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { lineFilterParam, useLineProjectId, useLineSelection, useLineWorkspace, useSyncLineHistory } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../store/inboxStore";
import { useTabActive } from "../../../hooks/usePagePresence";
import { useStageWide } from "../../../hooks/useStageWide";
import { hasOpenModal, useShortcutAction, useShortcutContext, withShortcut } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { graphKeyOf, newestRunByTask, processKeyOf, readLastProcess, rememberProcess, type GraphRun } from "../../../lib/line/lineGraphs";
import { useDecisionTask } from "../../../hooks/useFixDecision";
import { useSyncTrial, useTrialCards } from "../../../hooks/useSyncTrial";
import { useSyncWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { lineSelectionSearch, lineViewHome, readLineSelection, type LineSelection, type LineSelectionPatch } from "../../../lib/line/lineWorkspaceUrl";
import { pipelineFigures, pipelineHome, pipelineStageForGoKey, pipelineStageOf, type PipelineStage } from "../../../lib/line/pipeline";
import { useFlowMap } from "../../../hooks/useFlowMap";
import { useLiveFlow } from "../../../hooks/useLiveFlow";
import { PipelineNav } from "./PipelineNav";
import { NO_PROJECT, type RollupRow } from "../../../lib/lineFlow";
import { usePopover } from "./usePopover";
import { useLineSpaceKeys, type LineSpaceState } from "../../../hooks/useLineSpace";
import { TaskHrefProvider } from "../../../lib/taskHrefContext";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepPage } from "./step/StepPage";
import { LineDrawer, StageDrawer } from "./stages/LineDrawer";
import type { LineViewProps } from "./views/types";
import { ForYouView } from "./views/ForYouView";
import { FinderPage } from "./views/finder/FinderPage";
import { ProblemsView } from "./views/ProblemsView";
import { RunPage as RunPageView } from "./views/run/RunPage";
import { FlowsStage } from "./views/flows/FlowsStage";
import { SignalsView } from "./views/signals/SignalsView";
import { ShippedView } from "./views/shipped/ShippedView";
import { DeploysView } from "./views/deploys/DeploysView";
import { FlowsView } from "./views/flows/FlowsView";
import { TimelineView } from "./views/events/TimelineView";
import { LineSettingsStage } from "../settings/LineSettingsStage";
import "./workspace.css";

// Imported with the shell, so a nav press paints the page in the same frame: a
// lazy view would hold the switch on a fallback for React's 300ms reveal
// throttle even once loaded. A view's own heavy parts load lazily inside it.
// Each is memoized: the shell hosts the line's feeders, so it re-renders on
// every push, and a view re-renders only when the model, the workspace or the
// selection it reads moved.
const ForYou = memo(ForYouView);
const Problems = memo(ProblemsView);
const RunPage = memo(RunPageView);
const Finder = memo(FinderPage);
const Line = memo(FlowsStage);
const Signals = memo(SignalsView);
const Shipped = memo(ShippedView);
const Deploys = memo(DeploysView);
const Flows = memo(FlowsView);
const Timeline = memo(TimelineView);
// ROUTES: the page a selection opens. A run is read under its problem (view=problems + run); a finder is a step of
// the line (view=line + source). A builder whose page replaces one of these swaps its line here.
function pageFor(s: LineSelection): ComponentType<LineViewProps> {
  if (s.view === "foryou") return ForYou;
  if (s.view === "problems") return s.run ? RunPage : Problems;
  if (s.view === "deploys") return Deploys;
  if (s.view === "flows") return Flows;
  if (s.view === "timeline") return Timeline;
  if (s.view === "signals") return Signals;
  if (s.view === "shipped") return Shipped;
  return s.source ? Finder : Line;
}
/** How long after G the second key of the go chord still counts. */
const GO_MS = 1200;

/** Whether the document is on screen now (the page's entrance animates only then). */
const documentShown = () => typeof document === "undefined" || document.visibilityState === "visible";

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
  /** The workspace /line reads and the others that hold problems (useLineSpace): named and switched in the header. */
  space?: LineSpaceState;
  /** The stage holds the drawn flow's settings (/flows/settings), inside the app's nav and switchers. */
  settings?: boolean;
  /** One flow's page (/flows/<owner>): its name heads the app, and its projects are the only filter. */
  flow?: FlowFrame;
};

/** The flow a flow's page draws: its owner's handle and name, and the projects it takes from. */
export type FlowFrame = { owner: string; name: string; projects: ReadonlyArray<{ id: string; title: string }> };

type LineWorkspaceModel = ReturnType<typeof useLineWorkspace>;

export function LineWorkspace({ projectId: pinned = null, embedded, Frame, space, settings = false, flow }: LineWorkspaceProps) {
  // The address names a problem by its ref (ct-N); every view below reads its row id (caseRefs), and every write
  // through `select`/`href` names it by its ref again.
  const { selection: address, select: go, href: link } = useLineSelection();
  const asked = useLineProjectId(pinned ? null : address.project);
  const projectId = pinned ?? asked ?? null;
  // The case being read: the address's, else the open run's, so its runs and findings are fed whatever their age.
  const runCase = useInboxStore((st) => (address.run ? ((st as unknown as { workflowRuns?: Record<string, { task_id?: string }> }).workflowRuns?.[address.run]?.task_id ?? null) : null));
  // With no process in the address, the one the person last picked on this device (lineGraphs pickGraph).
  const [lastProcess, setLastProcess] = useState(readLastProcess);
  // The map draws the flow the address names, else the team's live flow, else the one last drawn on this device.
  const live = useLiveFlow(space?.key ?? null);
  const liveKey = live ? processKeyOf(live.flow.slug) : null;
  const ws = useLineWorkspace(projectId, address.graph ?? liveKey ?? lastProcess, address.case ?? runCase, { pinned: !!pinned, everySpace: true });
  const flowMap = useFlowMap(space?.key ?? null);
  const trialSpaces = useLineSpaceKeys();
  const { refs } = ws;
  const selection = useMemo(() => (address.case ? { ...address, case: refs.id(address.case) } : address), [address, refs]);
  const asRef = useCallback((patch: LineSelectionPatch): LineSelectionPatch => (patch.case ? { ...patch, case: refs.ref(patch.case) } : patch), [refs]);
  const select = useCallback<typeof go>((patch, caseOfRun, opts) => go(asRef(patch), caseOfRun ? refs.ref(caseOfRun) : caseOfRun, opts), [go, asRef, refs]);
  const href = useCallback<typeof link>((patch, caseOfRun) => link(asRef(patch), caseOfRun ? refs.ref(caseOfRun) : caseOfRun), [link, asRef, refs]);
  const { model, project, rollups, now } = ws;
  // A `?project=` the store cannot name yet: cold until the projects arrive, then dropped from the address so it and the filter agree.
  const unresolved = !pinned && !!selection.project && !asked;
  const projectsKnown = ws.projects.length > 0;
  useWatchEffect(() => { if (unresolved && projectsKnown) select({ project: null }, undefined, { replace: true }); }, [unresolved, projectsKnown, select]);
  const active = useTabActive();
  const param = project ? lineProjectParam(project) : null;

  // A run's page keeps its own step (the selected visit); only the Line page opens a step as its page.
  const runDetail = selection.view === "problems" && !!selection.run;
  const drawerView = selection.view === "line" && !selection.source;
  // The review stages (moments to dispatch) open as a drawer over Signals, the view whose sources feed them.
  const drawsStep = !drawerView;
  const drawerOpen = drawerView && !!(model && selection.step && model.steps[selection.step]);
  const drawerSelection = useMemo(() => (drawsStep ? { ...selection, step: null } : selection), [drawsStep, selection]);
  // On the Map, what opens slides in from the right with the graph still in view: a station's page, or a stage before
  // the runs (stages/). The Table's step stays a page of its own (LJ8.6).
  const onMap = drawerView && selection.mode === "map";
  const stepSlides = onMap && drawerOpen;
  const stageOpen = selection.view === "signals" && !!selection.stage;
  const slideOpen = stepSlides || stageOpen;

  const router = useRouter();
  const nav = useMemo<LineNav>(() => ({
    openStep: (id) => select({ step: id }),
    openRun: (runId, caseId) => select({ run: runId, view: "problems" }, caseId),
    stepHref: (id) => href({ step: id }),
    runHref: (runId, caseId) => href({ run: runId, view: "problems" }, caseId),
    openCase: (caseId) => select({ case: caseId, run: null, view: "problems" }),
    caseHref: (caseId) => href({ case: caseId, run: null, view: "problems" }),
    projectId: ws.home?._id,
    openPath: (path) => router.push(path),
    replacePath: (path) => router.replace(path),
  }), [select, href, ws.home?._id, router]);

  const search = useSearchParams();
  // A stage opens its home: nothing that was open elsewhere rides along (pipelineHome). From settings it leaves for
  // /flows, keeping the workspace's flow and project.
  const hasLive = !!live;
  const openStage = useCallback((stage: PipelineStage) => {
    if (!settings) return select(pipelineHome(stage, hasLive));
    const keep = new URLSearchParams();
    for (const k of ["project", "graph"]) { const x = search?.get(k); if (x) keep.set(k, x); }
    router.push(`/flows${lineSelectionSearch(keep, pipelineHome(stage, hasLive))}`);
  }, [select, settings, search, router, hasLive]);
  // An address that names a view or a mode by an earlier name (view=inbox, view=runs, mode=notebook) settles on the
  // name that holds its job now, in place: a link already sent opens where its job went, and Back is not spent on it.
  // Back and Forward return to where the page was scrolled (useStageScroll).
  const stageRef = useStageScroll();
  const rawView = search?.get("view") ?? null;
  const rawMode = search?.get("mode") ?? null;
  const stale = !settings && (!!rawView && rawView !== selection.view) || (!!rawMode && rawMode !== selection.mode) || rawView === "foryou" || (selection.view !== "line" && !!rawMode);
  useWatchEffect(() => { if (stale) select({ view: readLineSelection(search).view }, undefined, { replace: true }); }, [stale, select, search]);
  // A run link that names no problem (an old Runs link) takes its problem once the run's row is in the store.
  const runOnly = selection.run && !selection.case ? runCase : null;
  useWatchEffect(() => { if (runOnly && selection.run) select({ view: "problems", run: selection.run, case: runOnly, step: selection.step }, undefined, { replace: true }); }, [runOnly, selection.run, selection.step, select]);
  // Comma opens the settings of the line drawn here (its project, its process), the app's settings chord without the modifier.
  const drawnLine = model?.graphKey ?? null;
  const settingsAt = useCallback((patch: { project?: string | null; graph?: string | null }) => {
    const base = lineSettingsHref(patch.project ? { project: patch.project } : {});
    return patch.graph ? `${base}${base.includes("?") ? "&" : "?"}graph=${encodeURIComponent(patch.graph)}` : base;
  }, []);
  const settingsHref = settingsAt({ project: param, graph: drawnLine });
  useShortcutContext("line");
  useShortcutAction("line.settings", () => { if (!settings) router.push(settingsHref); return true; });

  // An address that names its case by row id (an older link, a run's own case) settles on the problem's ref in place.
  const caseId = selection.case;
  const caseRef = caseId ? refs.ref(caseId) : null;
  const caseByRef = caseRef && caseRef !== address.case ? caseRef : null;
  useWatchEffect(() => { if (caseByRef) select({ case: caseByRef, run: selection.run, ask: selection.ask ? "1" : null, decision: selection.decision }, undefined, { replace: true }); }, [caseByRef, select, selection.run, selection.ask, selection.decision]);
  // A card or a decision names its problem: a link that carries only one of them still opens on that problem's process.
  const trialCards = useTrialCards();
  const cardCase = useMemo(() => (selection.card ? trialCards.find((c) => c.short_id === selection.card || c._id === selection.card)?.task_id ?? null : null), [selection.card, trialCards]);
  const decisionCase = useDecisionTask(selection.decision) ?? (selection.decision ? trialCards.find((c) => c.decision && (c.decision.short_id === selection.decision || c.decision._id === selection.decision))?.task_id : null) ?? null;
  const subjectCase = caseId ?? decisionCase ?? cardCase;
  // A run, problem, card or decision of another process (an Inbox row, a finding's problem, a run's "Decide sd-N") opens on its own process, never on a stand-in from the one drawn.
  const ownGraph = useMemo(() => {
    // For you covers every process: nothing there waits on the one drawn.
    if (!model || selection.view === "foryou") return null;
    const runs = ws.rows.runs as unknown as GraphRun[];
    if (selection.run && !model.runs.some((r) => r.id === selection.run)) {
      const r = runs.find((x) => x._id === selection.run);
      return r ? graphKeyOf(r) : null;
    }
    if (subjectCase && !model.issues.some((i) => i.id === subjectCase)) {
      const r = newestRunByTask(runs.filter((x) => x.task_id === subjectCase)).get(subjectCase);
      // A problem no run has taken waits under its project's process (processIndex), as the model files it.
      return r ? graphKeyOf(r) : ws.process.task(subjectCase) ?? null;
    }
    return null;
  }, [model, ws.rows.runs, ws.process, selection.run, selection.view, subjectCase]);
  useWatchEffect(() => {
    if (ownGraph && model && ownGraph !== model.graphKey && model.graphs.some((g) => g.key === ownGraph)) select({ graph: ownGraph, run: selection.run, case: selection.case, step: selection.step, tab: selection.tab, ask: selection.ask ? "1" : null, card: selection.card, decision: selection.decision }, undefined, { replace: true });
  }, [ownGraph, model, select, selection.run, selection.case, selection.step, selection.tab, selection.ask, selection.card, selection.decision]);
  // The Line page's address names the line drawn, so a link says which line it shows: one that names none takes the
  // drawn line in place, and a line the address names becomes this device's pick. For you and Problems cover every
  // line (Problems narrows by its own `process`), so they name none.
  const drawnKey = model?.graphKey ?? null;
  // With no live flow the Flows stage is the library, so an address that names no flow is left naming none.
  const namesLine = !embedded && selection.view === "line" && ws.ready && !!drawnKey && !ownGraph && (!!liveKey || !!address.graph);
  const askedKey = address.graph ? processKeyOf(address.graph) : null;
  useWatchEffect(() => {
    if (!namesLine || !drawnKey) return;
    if (!address.graph) select({ graph: drawnKey, run: selection.run, case: selection.case, step: selection.step, tab: selection.tab, ask: selection.ask ? "1" : null, card: selection.card, decision: selection.decision }, undefined, { replace: true });
    else if (askedKey === drawnKey && drawnKey !== lastProcess) { rememberProcess(drawnKey); setLastProcess(drawnKey); }
  }, [namesLine, drawnKey, address.graph, askedKey, lastProcess, select, selection.run, selection.case, selection.step, selection.tab, selection.ask, selection.card, selection.decision]);
  const step = (dir: 1 | -1) => {
    if (!model || !selection.step) return;
    const i = model.order.indexOf(selection.step);
    const to = model.order[i + dir];
    if (to) select({ step: to }, undefined, { replace: true });
  };

  // Keys: G then F / P / S opens a page; with a step open, ← → walk steps and Esc closes it; with a run open, Esc
  // goes back to its problem; comma opens settings. No digit, X, T or Enter is bound here: an open decision answers
  // on those. keyBelongsElsewhere leaves alone a key typed in a field or inside a decision.
  const goAt = useRef(0);
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target) || (e.target as HTMLElement | null)?.closest?.(".ld, [data-line-decision-session]")) return;
      const chord = performance.now() - goAt.current < GO_MS;
      goAt.current = 0;
      if (chord) {
        const stage = pipelineStageForGoKey(e.key);
        if (stage) { e.preventDefault(); openStage(stage); return; }
      }
      if (e.key === "g" && !e.shiftKey) { goAt.current = performance.now(); return; }
      if (stageOpen) {
        if (e.key === "Escape") { e.preventDefault(); select({ stage: null }); }
        return;
      }
      if (drawerOpen) {
        if (e.key === "Escape") { e.preventDefault(); select({ step: null }); }
        else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        return;
      }
      // A problem's page takes Esc itself. A decision opened over a run closes first, back onto the run.
      if (e.key === "Escape" && runDetail && selection.decision) { e.preventDefault(); select({ decision: null }); }
      else if (e.key === "Escape" && runDetail) { e.preventDefault(); select({ run: null, step: null }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, openStage, drawerOpen, stageOpen, select, model, selection.step, runDetail, selection.decision]);

  // The line app takes its tab's width on every page: the session rail folds to a strip, so nothing unrelated to the
  // line sits beside it. Inside a project's page it claims the width only on For you, where a decision is read.
  useStageWide(!embedded || selection.view === "foryou");
  const { forYou, processes: picks } = ws;
  const View = pageFor(selection);
  const stage = settings ? null : pipelineStageOf(selection);
  const figures = useMemo(() => pipelineFigures(flowMap, forYou), [flowMap, forYou]);
  // Signals reads the flow map and Shipped what the store holds: neither waits on the line's feeds to answer.
  const ownFeeds = selection.view === "foryou" || selection.view === "signals" || selection.view === "shipped";
  // Every problem's ct-N link inside /line opens its problem page here, a shared component's included (taskHrefContext).
  const problemPlace = useCallback((ref: string) => (refs.id(ref) !== ref ? href({ view: "problems", case: ref, run: null, need: null, decision: null, card: null }) : null), [refs, href]);

  const app = (
    <LineNavProvider nav={nav}>
    <TaskHrefProvider place={problemPlace}>
      {!unresolved && ws.historyFeeds.map((f) => <HistoryFeed key={f.projectId} projectId={f.projectId} repositories={f.repositories} />)}
      {trialSpaces.map((key) => <TrialFeed key={key} workspace={key} />)}
      {ws.decisionRuns.map((id) => <RunFeed key={id} id={id} />)}
      <div className="lw lw-app" data-line-workspace={projectId ?? "all"} data-line-app data-view={selection.view}>
        <header className="lw-head">
          {!embedded && (flow
            ? <h1 className="lw-title lw-app-title" data-flow-title={flow.owner}><Link href="/flows" className="lw-title-up">Flows</Link><span aria-hidden className="lw-title-sep">/</span>{flow.name}</h1>
            : <h1 className="lw-title lw-app-title">Flows</h1>)}
          {/* The workspace every stage reads, switched in place. */}
          {!embedded && !flow && space && <SpaceSwitcher space={space} onPick={(k) => { space.pick(k); select({ ...lineViewHome(selection.view), project: null, graph: null, status: null }); }} />}
          {flow && flow.projects.length > 1 && (
            <div className="lw-seg" role="tablist" aria-label="Project" data-flow-projects>
              {flow.projects.map((p) => <button key={p.id} type="button" role="tab" aria-selected={p.id === projectId} onClick={() => select({ project: p.id })}>{p.title}</button>)}
            </div>
          )}
          {/* A project narrows Problems, and only Problems. */}
          {!embedded && !flow && stage === "problems" && <ProjectFilter selected={projectId} rollups={ws.allRollups} projects={ws.projects} byProject={ws.byProject} open={ws.open} onPick={(p) => select({ project: p })} />}
          <div className="lw-head-right">
            <Link href={settingsHref} className="lw-iconbtn" aria-label="Flow settings" aria-current={settings ? "page" : undefined} title={withShortcut("Settings", "line.settings")} data-line-settings-link><SlidersHorizontal className="w-4 h-4" /></Link>
          </div>
        </header>
        <div className="lw-app-body">
          {/* Until the feeds have answered, the counts are the cache's: shown dim, so a number about to move never reads as settled. */}
          <PipelineNav figures={figures} at={stage} open={openStage} settling={!(ws.ready && ws.complete)} />
          <div className="lw-body" data-drawer-open={slideOpen && model && !settings ? "" : undefined}>
            <main className="lw-stage" ref={stageRef}>
              {settings && model && !unresolved ? (
                <LineSettingsStage projectId={projectId} line={drawnLine} lines={picks} projects={ws.projects} rollups={ws.allRollups} processOf={ws.process.project} href={settingsAt} />
              ) : !model || unresolved || (!ws.complete && !ownFeeds) ? <Skeleton /> : (
                // The page rises in only while the tab is on screen: a hidden tab runs no frames, so an entrance never
                // finishes there, and Chrome keeps every page it replaced (and all that page read) until it would.
                <div className="lw-stage-in" data-enter={documentShown() ? "" : undefined} key={`${selection.view}:${selection.mode}:${selection.view === "foryou" ? "" : model.graphKey}:${projectId ?? "all"}`}>
                  {/* An open step is a page of its own (LJ8.6), in place of the view it was opened from. */}
                  {drawerOpen && !stepSlides
                    ? <StepPage model={model} workspace={ws} selection={drawerSelection} select={select} href={href} pinned={!!pinned} />
                    : <View model={model} workspace={ws} selection={selection} select={select} href={href} pinned={!!pinned} drawerOpen={slideOpen} space={space?.key ?? null} />}
                </div>
              )}
            </main>
            {!settings && model && !unresolved && stepSlides && (
              <LineDrawer key={`step:${selection.step}`} label={model.steps[selection.step!]?.label ?? "Step"} onClose={() => select({ step: null })} nav={<StationWalk order={model.order} at={selection.step!} labelOf={(id) => model.steps[id]?.label ?? id} go={(id) => select({ step: id }, undefined, { replace: true })} />}>
                <StepPage model={model} workspace={ws} selection={drawerSelection} select={select} href={href} pinned={!!pinned} />
              </LineDrawer>
            )}
            {!settings && model && !unresolved && stageOpen && !stepSlides && (
              <StageDrawer key={`stage:${selection.stage}`} stage={selection.stage!} projectId={ws.project?._id ?? ws.home?._id ?? null} model={model} workspace={ws} selection={selection} select={select} href={href} pinned={!!pinned} />
            )}
          </div>
        </div>
      </div>
    </TaskHrefProvider>
    </LineNavProvider>
  );
  return Frame ? <Frame app={app} ws={ws} /> : app;
}

/** A station's drawer head: where it sits in the line, and the stations either side (← → walk them too). */
function StationWalk({ order, at, labelOf, go }: { order: readonly string[]; at: string; labelOf: (id: string) => string; go: (id: string) => void }) {
  const i = order.indexOf(at);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  return (
    <nav className="sd-flow sd-walk" aria-label="Stations">
      <button type="button" className="lw-iconbtn" disabled={!prev} onClick={() => prev && go(prev)} title={prev ? `${labelOf(prev)} (←)` : undefined} aria-label="Previous station">‹</button>
      <span className="sd-walk-at"><span className="lw-num">{i + 1}</span> of <span className="lw-num">{order.length}</span> stations</span>
      <button type="button" className="lw-iconbtn" disabled={!next} onClick={() => next && go(next)} title={next ? `${labelOf(next)} (→)` : undefined} aria-label="Next station">›</button>
      {next && <span className="sd-dim sd-walk-next">next: {labelOf(next)}</span>}
    </nav>
  );
}

/** The workspace /line reads, by name; a menu of the others that hold problems, each with its open problems. One
 *  workspace with problems: its name, no menu. */
function SpaceSwitcher({ space, onPick }: { space: LineSpaceState; onPick: (key: string) => void }) {
  const { open, setOpen, ref } = usePopover();
  const current = space.spaces.find((x) => x.key === space.key) ?? null;
  const name = current?.name ?? "Personal";
  if (space.spaces.length < 2) return <span className="lw-chip lw-space" data-line-space={space.key ?? ""}><span className="lw-chip-t">{name}</span></span>;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip lw-filter lw-space" aria-haspopup="listbox" aria-expanded={open} aria-label={`Workspace: ${name}`} onClick={() => setOpen(!open)} data-line-space={space.key ?? ""}>
        <span className="lw-chip-t">{name}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Workspace">
          <div className="lw-pop-h"><span className="lw-filter-check" /><span className="lw-filter-name">Workspace</span><span>Open problems</span></div>
          {space.spaces.map((x) => (
            <button key={x.key} type="button" role="option" aria-selected={x.key === space.key} data-empty={x.open ? undefined : ""} onClick={() => { if (x.key !== space.key) onPick(x.key); setOpen(false); }} data-line-space-option={x.key}>
              <span className="lw-filter-check">{x.key === space.key && <Check className="w-3.5 h-3.5" />}</span>
              <span className="lw-filter-name">{x.name}</span>
              <span className="lw-num">{x.open || "–"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One workspace's trial cards, fed so For you lists every workspace's (useLineWorkspace everySpace). */
function TrialFeed({ workspace }: { workspace: string }) {
  useSyncTrial(workspace);
  return null;
}

/** One run an open decision names, fed by id whatever its age. */
function RunFeed({ id }: { id: string }) {
  useSyncWorkflowRun(id);
  return null;
}

/** One project's history, fed while the line shows every project. */
function HistoryFeed({ projectId, repositories }: { projectId: string; repositories: string }) {
  useSyncLineHistory(projectId, repositories);
  return null;
}

/** The project filter: every project by default; a dropdown of the projects with work on the line, each with its problems not yet done. */
function ProjectFilter({ selected, rollups, projects, byProject, open: openCount, onPick }: { selected: string | null; rollups: RollupRow[]; projects: ReturnType<typeof useLineWorkspace>["projects"]; byProject: ReturnType<typeof useLineWorkspace>["byProject"]; open: number; onPick: (param: string | null) => void }) {
  const { open, setOpen, ref } = usePopover();
  const has = (k: string) => (byProject.get(k)?.open ? 0 : 1);
  const rows = rollups.filter((r) => r.key !== NO_PROJECT).sort((a, b) => has(a.key) - has(b.key) || a.title.localeCompare(b.title));
  const current = selected ? projects.find((p) => p._id === selected) ?? null : null;
  // Over every project the row reads the page's own count; filtered, the projects' sum.
  const all = selected ? rows.reduce((n, r) => n + (byProject.get(r.key)?.open ?? 0), 0) : openCount;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip lw-filter" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} data-line-project-filter={current ? lineFilterParam(current, projects) : "all"}>
        <span className="lw-chip-t">{current?.title ?? "All projects"}</span>
        <ChevronDown className="w-3.5 h-3.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-filter-pop" role="listbox" aria-label="Project">
          <div className="lw-pop-h"><span className="lw-filter-check" /><span className="lw-filter-name">Project</span><span title="Problems not done, in this process">Open</span></div>
          <button type="button" role="option" aria-selected={!selected} onClick={() => { onPick(null); setOpen(false); }} data-line-project-option="all">
            <span className="lw-filter-check">{!selected && <Check className="w-3.5 h-3.5" />}</span>
            <span className="lw-filter-name">All projects</span>
            <span className="lw-num">{all}</span>
          </button>
          {rows.map((r, i) => {
            const p = projects.find((x) => x._id === r.key);
            const on = r.key === selected;
            const n = byProject.get(r.key)?.open ?? 0;
            // Projects with nothing in this process sit below a rule, dimmed: still a filter, never the headline.
            const firstEmpty = !n && (i === 0 || !!byProject.get(rows[i - 1].key)?.open);
            return (
              <Fragment key={r.key}>
                {firstEmpty && <div className="lw-filter-rule" role="separator" />}
                <button type="button" role="option" aria-selected={on} data-empty={n ? undefined : ""} onClick={() => { onPick(p ? lineFilterParam(p, projects) : r.short_id ?? r.key); setOpen(false); }} data-line-project-option={r.short_id ?? r.key} >
                  <span className="lw-filter-check">{on && <Check className="w-3.5 h-3.5" />}</span>
                  <span className="lw-filter-name">{r.title}</span>
                  <span className="lw-num">{n || "–"}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
