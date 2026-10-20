"use client";
// The line app (docs/architecture/line-journeys.md LJ4, LJ5): one app over the
// process, a project only a filter on it. Three places, in the left nav: For
// you (the landing page: what waits on the viewer, read and answered there),
// Problems and Line. Only For you carries a number, the one count of what the
// viewer can answer now. The header holds the process picker and the project
// filter where they scope the page (Problems, Line); For you covers every
// process, so it has neither. Pages switch on G then F / P / L: the shell binds
// no digit, because an open decision answers on bare digits.
// The selection lives in the URL (useLineSelection), so any state is a link.
// `/line` draws this over every project; a project's Line tab draws it pinned
// to that project.
import { Fragment, memo, useCallback, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useStageScroll } from "./useStageScroll";
import { Check, ChevronDown, Inbox, SlidersHorizontal, Workflow, AlertCircle, Rocket, type LucideIcon } from "lucide-react";
import { lineFilterParam, useLineProjectId, useLineSelection, useLineWorkspace, useSyncLineHistory } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../store/inboxStore";
import { useTabActive } from "../../../hooks/usePagePresence";
import { useStageWide } from "../../../hooks/useStageWide";
import { hasOpenModal, useShortcutAction, useShortcutContext, withShortcut } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { graphKeyOf, newestRunByTask, processKeyOf, processName, readLastProcess, rememberProcess, type GraphRun, type ProjectGraph } from "../../../lib/line/lineGraphs";
import { useDecisionTask } from "../../../hooks/useFixDecision";
import { useSyncTrial, useTrialCards } from "../../../hooks/useSyncTrial";
import { LINE_VIEWS, LINE_VIEW_KEYS, LINE_VIEW_LABELS, lineSelectionSearch, lineViewForGoKey, lineViewHome, readLineSelection, type LineSelection, type LineSelectionPatch, type LineView } from "../../../lib/line/lineWorkspaceUrl";
import { NO_PROJECT, type RollupRow } from "../../../lib/lineFlow";
import { KeyCap } from "../../KeyCap";
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
import { ProcessView } from "./views/ProcessView";
import { DeploysView } from "./views/deploys/DeploysView";
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
const Line = memo(ProcessView);
const Deploys = memo(DeploysView);
// ROUTES: the page a selection opens. A run is read under its problem (view=problems + run); a finder is a step of
// the line (view=line + source). A builder whose page replaces one of these swaps its line here.
function pageFor(s: LineSelection): ComponentType<LineViewProps> {
  if (s.view === "foryou") return ForYou;
  if (s.view === "problems") return s.run ? RunPage : Problems;
  if (s.view === "deploys") return Deploys;
  return s.source ? Finder : Line;
}
const ICONS: Record<LineView, LucideIcon> = { foryou: Inbox, problems: AlertCircle, line: Workflow, deploys: Rocket };
/** How long after G the second key of the go chord still counts. */
const GO_MS = 1200;

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
  /** The stage holds the drawn line's settings (/line/settings), inside the app's nav and switchers. */
  settings?: boolean;
};

type LineWorkspaceModel = ReturnType<typeof useLineWorkspace>;

export function LineWorkspace({ projectId: pinned = null, embedded, Frame, space, settings = false }: LineWorkspaceProps) {
  // The address names a problem by its ref (ct-N); every view below reads its row id (caseRefs), and every write
  // through `select`/`href` names it by its ref again.
  const { selection: address, select: go, href: link } = useLineSelection();
  const asked = useLineProjectId(pinned ? null : address.project);
  const projectId = pinned ?? asked ?? null;
  // The case being read: the address's, else the open run's, so its runs and findings are fed whatever their age.
  const runCase = useInboxStore((st) => (address.run ? ((st as unknown as { workflowRuns?: Record<string, { task_id?: string }> }).workflowRuns?.[address.run]?.task_id ?? null) : null));
  // With no process in the address, the one the person last picked on this device (lineGraphs pickGraph).
  const [lastProcess, setLastProcess] = useState(readLastProcess);
  // A line the picked project has no runs in clears the project rather than refusing the pick: the line is what was asked for.
  const pickProcess = useCallback((key: string, clearProject = false) => { rememberProcess(key); setLastProcess(key); go(clearProject ? { graph: key, project: null } : { graph: key }); }, [go]);
  const ws = useLineWorkspace(projectId, address.graph ?? lastProcess, address.case ?? runCase, { pinned: !!pinned, everySpace: true });
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
  const drawsStep = !drawerView;
  const drawerOpen = drawerView && !!(model && selection.step && model.steps[selection.step]);
  const drawerSelection = useMemo(() => (drawsStep ? { ...selection, step: null } : selection), [drawsStep, selection]);
  // On the Map, what opens slides in from the right with the graph still in view: a station's page, or a stage before
  // the runs (stages/). The Table's step stays a page of its own (LJ8.6).
  const onMap = drawerView && selection.mode === "map";
  const stepSlides = onMap && drawerOpen;
  const stageOpen = drawerView && !!selection.stage;
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
  // The nav opens a view's home: nothing that was open elsewhere rides along (lineViewHome). From settings it leaves
  // for /line, keeping the workspace's line and project.
  const setView = useCallback((v: LineView) => {
    if (!settings) return select(lineViewHome(v));
    const keep = new URLSearchParams();
    for (const k of ["project", "graph"]) { const x = search?.get(k); if (x) keep.set(k, x); }
    router.push(`/line${lineSelectionSearch(keep, lineViewHome(v))}`);
  }, [select, settings, search, router]);
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
  const namesLine = !embedded && selection.view === "line" && ws.ready && !!drawnKey && !ownGraph;
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
        const v = lineViewForGoKey(e.key);
        if (v) { e.preventDefault(); setView(v); return; }
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
  }, [active, setView, drawerOpen, stageOpen, select, model, selection.step, runDetail, selection.decision]);

  // The line app takes its tab's width on every page: the session rail folds to a strip, so nothing unrelated to the
  // line sits beside it. Inside a project's page it claims the width only on For you, where a decision is read.
  useStageWide(!embedded || selection.view === "foryou");
  const { forYou, processes: picks } = ws;
  const here = useMemo(() => new Set(model?.graphs.map((g) => g.key) ?? []), [model]);
  const View = pageFor(selection);
  // For you covers every process and names each row's own, so the picker scopes only Problems and Line.
  const scoped = settings || selection.view !== "foryou";
  // Problems' list covers every process too, as For you does: there the picker narrows the list (`process`), with All
  // first. An open problem or run is read in its own process (`graph`), which the picker then names.
  const listing = !settings && selection.view === "problems" && !selection.case && !selection.run;
  // Every problem's ct-N link inside /line opens its problem page here, a shared component's included (taskHrefContext).
  const problemPlace = useCallback((ref: string) => (refs.id(ref) !== ref ? href({ view: "problems", case: ref, run: null, need: null, decision: null, card: null }) : null), [refs, href]);
  const listed = useMemo(() => new Set(ws.problems.map((i) => i.process)), [ws.problems]);

  const app = (
    <LineNavProvider nav={nav}>
    <TaskHrefProvider place={problemPlace}>
      {!unresolved && ws.historyFeeds.map((f) => <HistoryFeed key={f.projectId} projectId={f.projectId} repositories={f.repositories} />)}
      {trialSpaces.map((key) => <TrialFeed key={key} workspace={key} />)}
      <div className="lw lw-app" data-line-workspace={projectId ?? "all"} data-line-app data-view={selection.view}>
        <header className="lw-head">
          {!embedded && <h1 className="lw-title lw-app-title">Line</h1>}
          {/* The workspace Problems and Line read, switched in place. For you lists decisions from every workspace, so
              it names none (each row's product says where it is from). */}
          {!embedded && space && scoped && <SpaceSwitcher space={space} onPick={(k) => { space.pick(k); select({ ...lineViewHome(selection.view), project: null, graph: null, status: null }); }} />}
          {scoped && model && picks.length > 0 && (listing
            ? <ProcessPicker all picks={picks} drawn={listed.has(selection.process ?? "") ? selection.process! : null} here={listed} projectTitle={project?.title ?? null} onPick={(k) => select({ process: k })} />
            : <ProcessPicker picks={picks} drawn={model.graphKey} here={here} projectTitle={project?.title ?? null} onPick={(k) => k && pickProcess(k, !!projectId && !pinned && !here.has(k))} />)}
          {!embedded && scoped && <ProjectFilter selected={projectId} rollups={ws.allRollups} projects={ws.projects} byProject={ws.byProject} open={ws.open} onPick={(p) => select({ project: p })} />}
          <div className="lw-head-right">
            <Link href={settingsHref} className="lw-iconbtn" aria-label="Line settings" aria-current={settings ? "page" : undefined} title={withShortcut("Settings", "line.settings")} data-line-settings-link><SlidersHorizontal className="w-4 h-4" /></Link>
          </div>
        </header>

        <div className="lw-app-body">
          {/* Until the feeds have answered, the count is the cache's: shown dim, so a number that is about to move never reads as settled. */}
          <nav className="lw-nav" aria-label="Line" data-line-nav data-settling={ws.ready ? undefined : ""}>
            {LINE_VIEWS.map((v) => {
              const Icon = ICONS[v];
              return (
                <button key={v} type="button" className="lw-nav-item" aria-current={!settings && selection.view === v ? "page" : undefined} aria-keyshortcuts={`G ${LINE_VIEW_KEYS[v].toUpperCase()}`} onClick={() => setView(v)} data-line-view-tab={v}>
                  <Icon className="lw-nav-icon" aria-hidden />
                  <span className="lw-nav-label">{LINE_VIEW_LABELS[v]}</span>
                  {/* The one count: what the viewer can answer now, over every process. Each is a row of For you. */}
                  {v === "foryou" && forYou > 0 && <span className="lw-nav-count" data-tone="ask" data-line-waits={forYou} aria-label={`${forYou} open decisions`}>{forYou}</span>}
                  <span className="lw-nav-key" aria-hidden><KeyCap size="xs">G</KeyCap><KeyCap size="xs">{LINE_VIEW_KEYS[v].toUpperCase()}</KeyCap></span>
                </button>
              );
            })}
          </nav>

          <div className="lw-body" data-drawer-open={slideOpen && model && !settings ? "" : undefined}>
            <main className="lw-stage" ref={stageRef}>
              {settings && model && !unresolved ? (
                <LineSettingsStage projectId={projectId} line={drawnLine} lines={picks} projects={ws.projects} rollups={ws.allRollups} processOf={ws.process.project} href={settingsAt} />
              ) : !model || unresolved ? <Skeleton /> : (
                <div className="lw-stage-in" key={scoped ? `${selection.view}:${selection.mode}:${model.graphKey}:${projectId ?? "all"}` : `foryou:${projectId ?? "all"}`}>
                  {/* An open step is a page of its own (LJ8.6), in place of the view it was opened from. */}
                  {drawerOpen && !stepSlides
                    ? <StepPage model={model} workspace={ws} selection={drawerSelection} select={select} href={href} pinned={!!pinned} />
                    : <View model={model} workspace={ws} selection={selection} select={select} href={href} pinned={!!pinned} drawerOpen={slideOpen} />}
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

/**
 * The process picker: one chip per process the owner works, each named by what it fixes (processName, in its
 * tooltip). Our own tooling for a product's process (AgentWatch's judges) is not a process the owner works: it folds
 * into its product's chip, behind a caret that lists the product and its tooling, and the chip names it when drawn.
 * It carries no count of what waits: that is one number, on the For you nav entry.
 */
function ProcessPicker({ picks, drawn, here, projectTitle, onPick, all = false }: { picks: ProjectGraph[]; /** Problems' list: All first, and `drawn` null is every process. */ all?: boolean; drawn: string | null; here: ReadonlySet<string>; projectTitle: string | null; onPick: (key: string | null) => void }) {
  const named = useMemo(() => picks.map((g) => ({ g, ...processName(g.key, g.title) })), [picks]);
  const tops = named.filter((x) => !x.parent || !named.some((y) => y.g.key === x.parent));
  const under = (key: string) => named.filter((x) => x.parent === key);
  return (
    <div className="lw-seg lw-graph-pick" role="tablist" aria-label="Process">
      {all && <button type="button" role="tab" aria-selected={drawn === null} onClick={() => onPick(null)} title="Every process" data-line-graph-pick="all">All</button>}
      {tops.map((top) => {
        const subs = under(top.g.key);
        const family = [top, ...subs];
        const on = family.find((x) => x.g.key === drawn) ?? null;
        const shown = on ?? top;
        const live = family.reduce((n, x) => n + x.g.live, 0);
        // A line with no runs in the picked project stays pickable (picking it shows every project), drawn quieter.
        const none = !family.some((x) => here.has(x.g.key)) && !on;
        const chip = (
          <button type="button" role="tab" aria-selected={!!on} data-elsewhere={none ? "" : undefined} onClick={() => onPick(on?.g.key ?? top.g.key)}
            title={none ? `No runs in ${projectTitle ?? "this project"}: opens it over every project` : shown.fixes ? `${shown.title}: fixes ${shown.fixes}` : shown.title} data-line-graph-pick={top.g.key}>
            {top.title}
            {on && on !== top && <span className="lw-pick-sub">{on.title}</span>}
            {/* The selected process says what it fixes in place, unless its name already says it ("Codecast's line"). */}
            {on && fixesWords(on) && <span className="lw-pick-fixes" data-line-graph-fixes>{fixesWords(on)}</span>}
            {live > 0 && <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-label={`${live} running`} />}
          </button>
        );
        if (!subs.length) return <Fragment key={top.g.key}>{chip}</Fragment>;
        return <ProcessFamily key={top.g.key} chip={chip} family={family} drawn={drawn} here={here} onPick={onPick} />;
      })}
    </div>
  );
}

/** What a process fixes, as its chip says it, or null when its name already says it ("Codecast's line" fixes codecast). */
const fixesWords = (x: { title: string; fixes: string | null }) => (x.fixes && !x.title.toLowerCase().includes(x.fixes.toLowerCase()) ? `fixes ${x.fixes}` : null);

/** A product's chip with its tooling folded behind a caret: the menu lists the product and each tool, with what it fixes. */
function ProcessFamily({ chip, family, drawn, here, onPick }: { chip: ReactNode; family: Array<{ g: ProjectGraph; title: string; fixes: string | null }>; drawn: string | null; here: ReadonlySet<string>; onPick: (key: string) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="lw-pop-host lw-pick-family" ref={ref}>
      {chip}
      <button type="button" className="lw-pick-caret" aria-haspopup="menu" aria-expanded={open} aria-label={`${family[0].title} and its tooling`} title="Also in this process" onClick={() => setOpen(!open)} data-line-graph-family={family[0].g.key}>
        <ChevronDown className="w-3.5 h-3.5" aria-hidden />
      </button>
      {open && (
        <div className="lw-pop lw-pick-pop" role="menu">
          {family.map((x, i) => (
            <button key={x.g.key} type="button" role="menuitemradio" aria-checked={x.g.key === drawn} data-elsewhere={!here.has(x.g.key) && x.g.key !== drawn ? "" : undefined} data-sub={i > 0 ? "" : undefined}
              onClick={() => { onPick(x.g.key); setOpen(false); }} data-line-graph-option={x.g.key}>
              <span className="lw-filter-check">{x.g.key === drawn && <Check className="w-3.5 h-3.5" />}</span>
              <span className="lw-pick-name"><b>{x.title}</b>{fixesWords(x) && <small>{fixesWords(x)}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
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
