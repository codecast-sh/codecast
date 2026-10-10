"use client";
// A project's line workspace (docs/architecture/line-workspace.md LW1): one
// header (the project, which graph when it runs several, whether the line
// starts work on its own, what waits on you), five views over one model
// (Graph, Notebook, Replay, Chat, Timeline; keys 1 to 5) and the step drawer
// every view opens. The selection lives in the URL (useLineSelection), so any
// state is a link and every view reads the same one. `/line/<project>` and the
// project's Line tab both draw this.
import { memo, useCallback, useMemo, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { useLineSelection, useLineWorkspace } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { hasOpenModal, useShortcutAction, useShortcutContext } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { graphPlaceTitle } from "../../../lib/line/lineGraphs";
import { LINE_VIEWS, LINE_VIEW_LABELS, lineViewForKey, lineWorkspaceHref, type LineView } from "../../../lib/line/lineWorkspaceUrl";
import type { LineModel } from "../../../lib/line/lineModel";
import { KeyCap } from "../../KeyCap";
import { overviewWords, waitPartHref, waitsOnYou, waitsOnYouParts, type WaitsOnYou } from "../LineProjects";
import { useLineAdmission } from "../map/useLineAdmission";
import { LineStartSwitch, type NotReady } from "../map/LineStartSwitch";
import { usePopover } from "./usePopover";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepDrawer } from "./StepDrawer";
import { useDrawerRequest } from "./stepDrafts";
import { hasJudges } from "./FindBand";
import { startJudgingSetup } from "../../../lib/line/setupJudging";
import { StartSessionButton, SETUP_JUDGING_WHAT } from "./StartSessionButton";
import type { LineViewProps } from "./views/types";
import { GraphView } from "./views/GraphView";
import { NotebookView } from "./views/NotebookView";
import { ReplayView } from "./views/ReplayView";
import { ChatView } from "./views/ChatView";
import { TimelineView } from "./views/TimelineView";
import "./workspace.css";

// Imported with the shell, so a press on 1 to 5 paints the view in the same
// frame: a lazy view would hold the switch on a fallback for React's 300ms
// reveal throttle even once loaded. A view's own heavy parts load lazily inside it.
// Each is memoized: the shell hosts the line's feeders, so it re-renders on
// every push, and a view re-renders only when the model, the workspace or the
// selection it reads moved.
const VIEWS: Record<LineView, ComponentType<LineViewProps>> = { graph: memo(GraphView), notebook: memo(NotebookView), replay: memo(ReplayView), chat: memo(ChatView), timeline: memo(TimelineView) };

/** The step a "waits for you" press opens: a person's step holding a waiting
 *  decision, else the card gate, else the first person's step. */
export function waitingStep(model: LineModel | null): string | null {
  if (!model) return null;
  const people = model.order.filter((id) => model.steps[id]?.kind === "person");
  return people.find((id) => model.steps[id].decisions.some((d) => d.status === "waiting"))
    ?? (model.steps[CARD_GATE_NODE_ID] ? CARD_GATE_NODE_ID : null)
    ?? people[0]
    ?? null;
}

function Skeleton() {
  return <div className="lw-skeleton" aria-busy>{[70, 92, 54, 80].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
}

export type LineWorkspaceProps = {
  projectId: string;
  /** Inside the project's page, which already names the project: no crumb or title. */
  embedded?: boolean;
};

export function LineWorkspace({ projectId, embedded }: LineWorkspaceProps) {
  const { selection, select, href } = useLineSelection();
  const ws = useLineWorkspace(projectId, selection.graph, selection.case);
  const { model, project, rollup } = ws;
  const admit = useLineAdmission(projectId);
  const active = useTabActive();
  const param = project ? lineProjectParam(project) : projectId;
  // The Notebook draws the open step as its page, so the drawer stays shut there. In Replay a step moves the
  // playhead and the center card shows it; the drawer opens there only when asked for (Edit, Ask an agent, the whole prompt).
  const drawerAsk = useDrawerRequest();
  const askSeen = useRef(drawerAsk?.n ?? 0);
  const [replayDrawer, setReplayDrawer] = useState(false);
  useWatchEffect(() => {
    if (!drawerAsk || drawerAsk.n <= askSeen.current) return;
    askSeen.current = drawerAsk.n;
    if (selection.view === "replay") setReplayDrawer(true);
  }, [drawerAsk, selection.view]);
  useWatchEffect(() => { if (!selection.step || selection.view !== "replay") setReplayDrawer(false); }, [selection.step, selection.view]);
  const drawsStep = selection.view === "notebook" || (selection.view === "replay" && !replayDrawer);
  const drawerOpen = !drawsStep && !!(model && selection.step && model.steps[selection.step]);
  const drawerSelection = useMemo(() => (drawsStep ? { ...selection, step: null } : selection), [drawsStep, selection]);

  const router = useRouter();
  const nav = useMemo<LineNav>(() => ({
    openStep: (id) => select({ step: id }),
    openRun: (runId, caseId) => select({ run: runId, view: "replay" }, caseId),
    stepHref: (id) => href({ step: id }),
    runHref: (runId, caseId) => href({ run: runId, view: "replay" }, caseId),
    openCase: (caseId) => select({ case: caseId, run: null, view: "timeline" }),
    caseHref: (caseId) => href({ case: caseId, run: null, view: "timeline" }),
    projectId,
    openPath: (path) => router.push(path),
  }), [select, href, projectId, router]);

  const setView = useCallback((v: LineView) => select({ view: v }), [select]);
  // Comma opens this line's settings, the app's settings chord without the modifier.
  const settingsHref = lineSettingsHref({ project: param });
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

  // Keys: 1 to 5 switch views; with a step open, ← → walk steps and Esc closes it; comma opens settings.
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const v = lineViewForKey(e.key);
      if (v) { e.preventDefault(); setView(v); return; }
      if (!drawerOpen) return;
      if (e.key === "Escape") { e.preventDefault(); select({ step: null }); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, setView, drawerOpen, select, model, selection.step]);

  const a = admit.admission;
  const product = ws.product;
  // Two graphs in one place keep their own names beside it.
  const places = (model?.graphs ?? []).map((g) => graphPlaceTitle(g.key, product));
  // The switch is labelled "Fix line", so each tab says only where: "In Union", "Here".
  const tabTitle = (g: { key: string; title: string }) => {
    const place = graphPlaceTitle(g.key, product);
    const where = place.replace(/^Fixes (\w)/, (_, c: string) => c.toUpperCase());
    return places.filter((p) => p === place).length > 1 ? `${where}: ${g.title}` : where;
  };
  // What waits on you here, the same rollup the /line overview card reads (waitsOnYou).
  const waits = rollup ? waitsOnYou(rollup) : { decisions: 0, unapproved: 0, reviews: 0, questions: 0, total: 0 };
  const stuck = rollup ? overviewWords(rollup).stuck : null;
  const toWait = waitingStep(model);
  const View = VIEWS[selection.view];

  return (
    <LineNavProvider nav={nav}>
      <div className="lw" data-line-workspace={projectId} data-view={selection.view}>
        <header className="lw-head">
          {!embedded && (
            <div className="lw-id">
              <Link href="/line" className="lw-crumb">Line</Link>
              <span className="lw-crumb-sep" aria-hidden>/</span>
              <h1 className="lw-title" title={project?.title ?? undefined}>{project?.title ?? "Project"}</h1>
            </div>
          )}
          {model && model.graphs.length > 1 && (
            <div className="lw-seg lw-graph-pick" role="tablist" aria-label="Fix line">
              <span className="lw-seg-lead" aria-hidden>Fix line</span>
              {model.graphs.map((g) => (
                <button key={g.key} type="button" role="tab" aria-selected={g.key === model.graphKey} onClick={() => select({ graph: g.key })} title={`${g.title}: ${g.work}`} data-line-graph-pick={g.key}>
                  {tabTitle(g)}
                  {g.live > 0 && <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-label={`${g.live} running`} />}
                </button>
              ))}
            </div>
          )}

          <div className="lw-seg" role="tablist" aria-label="View" data-line-views>
            {LINE_VIEWS.map((v, i) => (
              // The key is the tab's shortcut, not part of its name: "Timeline", so a search by name finds the tab.
              <button key={v} type="button" role="tab" aria-selected={selection.view === v} aria-keyshortcuts={String(i + 1)} onClick={() => setView(v)} data-line-view-tab={v}>
                {LINE_VIEW_LABELS[v]}
                <span className="lw-seg-key" aria-hidden><KeyCap size="xs">{i + 1}</KeyCap></span>
              </button>
            ))}
          </div>

          <div className="lw-head-right">
            {a?.role && <StartChip admit={admit} waiting={rollup?.causes ?? null} notReady={rollup?.notReady} ready={rollup?.ready ?? null} notReadyHref={`${lineWorkspaceHref(param, { view: "timeline" })}&show=notready`} />}
            {/* No judge yet: the loop's first step is setting one up (learning-loop.md LL4). */}
            {ws.loop && !hasJudges(ws.loop) && (
              <StartSessionButton className="lw-chip" what={SETUP_JUDGING_WHAT} start={() => startJudgingSetup(projectId)} data={{ "data-line-setup-judging": "head" }}>
                Set up judging
              </StartSessionButton>
            )}
            {waits.total > 0 && <WaitsChip waits={waits} project={param} openDecisions={toWait ? () => select({ step: toWait }) : null} />}
            {stuck && <span className="lw-chip" data-tone="warn" style={{ cursor: "default" }} title={rollup?.hold ? `${stuck} to start: ${rollup.hold}` : stuck} data-line-stuck><span className="lw-dot" /><span className="lw-chip-t">{stuck}</span></span>}
            <Link href={settingsHref} className="lw-iconbtn" aria-label="This line's settings" title="Settings (,)"><SlidersHorizontal className="w-4 h-4" /></Link>
          </div>
        </header>

        <div className="lw-body" data-drawer-open={drawerOpen ? "" : undefined}>
          <main className="lw-stage">
            {!model ? <Skeleton /> : (
              <div className="lw-stage-in" key={`${selection.view}:${model.graphKey}`}>
                <View model={model} workspace={ws} selection={selection} select={select} href={href} drawerOpen={drawerOpen} />
              </div>
            )}
          </main>
          <StepDrawer model={model} selection={drawerSelection} select={select} />
        </div>
      </div>
    </LineNavProvider>
  );
}

/** What waits on you in this line, counted as the /line overview counts it:
 *  the chip says the total, and opens each part where it is answered. */
function WaitsChip({ waits, project, openDecisions }: { waits: WaitsOnYou; project: string; openDecisions: (() => void) | null }) {
  const { open, setOpen, ref } = usePopover();
  const parts = waitsOnYouParts(waits);
  return (
    <div className="lw-pop-host" ref={ref}>
      <button type="button" className="lw-chip" data-tone="ask" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} data-line-waits={waits.total} title={`${waits.total} ${waits.total === 1 ? "waits" : "wait"} for you: ${waitsOnYouParts(waits).map((p) => p.words).join(", ")}`}>
        <span className="lw-dot" /><span className="lw-chip-t">{waits.total} for you</span>
      </button>
      {open && (
        <div className="lw-pop lw-waits-pop" role="dialog" aria-label="What waits for you" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a, button")) setOpen(false); }}>
          {parts.map((p) => p.kind === "decisions" && openDecisions
            ? <button key={p.kind} type="button" onClick={openDecisions} data-line-wait={p.kind}>{p.words}<small>Open the card</small></button>
            : <Link key={p.kind} href={waitPartHref(project, p.kind)} data-line-wait={p.kind}>{p.words}<small>{WAIT_WHERE[p.kind]}</small></Link>)}
        </div>
      )}
    </div>
  );
}

const WAIT_WHERE: Record<keyof Omit<WaitsOnYou, "total">, string> = { decisions: "On the Timeline", unapproved: "Review what shipped", reviews: "Problems in review", questions: "Problems with a question" };

/** Whether the line starts problems on its own: the chip says it at a glance,
 *  and opens the switch with its slots and what turning it on would start. */
function StartChip({ admit, waiting, notReady, ready, notReadyHref }: { admit: ReturnType<typeof useLineAdmission>; waiting: number | null; notReady?: NotReady; ready: number | null; notReadyHref: string }) {
  const { open, setOpen, ref } = usePopover();
  const a = admit.admission!;
  return (
    <div className="lw-pop-host" ref={ref}>
      <button
        type="button"
        className="lw-chip"
        data-on={a.on ? "" : undefined}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label={a.on ? "Auto-start is on: the line starts waiting problems itself" : "Auto-start is off: the line starts nothing itself"}
        title={a.role?.paused ? `@${a.role.handle} is paused; nothing starts until it resumes` : a.on ? "On: the line starts waiting problems itself" : "Off: the line starts nothing itself; you start each problem"}
        data-line-start-chip={a.on ? "on" : "off"}
      >
        <span className="lw-switch" aria-hidden />
        <span className="lw-chip-t">Auto-start</span>
      </button>
      {open && (
        // Following a link out of the popover (the Timeline's "Waiting on you or another run") closes it.
        <div className="lw-pop lw-start-pop" role="dialog" aria-label="Starting problems" onClickCapture={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          <LineStartSwitch admit={admit} waiting={waiting} notReady={notReady} ready={ready} notReadyHref={notReadyHref} />
        </div>
      )}
    </div>
  );
}
