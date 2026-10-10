"use client";
// A project's line workspace (docs/architecture/line-workspace.md LW1): one
// header (the project, which graph when it runs several, whether the line
// starts work on its own, what waits on you), five views over one model
// (Graph, Notebook, Replay, Chat, Timeline; keys 1 to 5) and the step drawer
// every view opens. The selection lives in the URL (useLineSelection), so any
// state is a link and every view reads the same one. `/line/<project>` and the
// project's Line tab both draw this.
import { memo, useCallback, useMemo, type ComponentType } from "react";
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
import { overviewWords } from "../LineProjects";
import { useLineAdmission } from "../map/useLineAdmission";
import { LineStartSwitch, type NotReady } from "../map/LineStartSwitch";
import { usePopover } from "./usePopover";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepDrawer } from "./StepDrawer";
import { hasJudges } from "./FindBand";
import { startJudgingSetup } from "../../../lib/line/setupJudging";
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
  // The Notebook draws the open step as its page, so the drawer stays shut there.
  const drawsStep = selection.view === "notebook";
  const drawerOpen = !drawsStep && !!(model && selection.step && model.steps[selection.step]);
  const drawerSelection = useMemo(() => (drawsStep ? { ...selection, step: null } : selection), [drawsStep, selection]);

  const nav = useMemo<LineNav>(() => ({
    openStep: (id) => select({ step: id }),
    openRun: (runId, caseId) => select({ run: runId, view: "replay" }, caseId),
    stepHref: (id) => href({ step: id }),
    runHref: (runId, caseId) => href({ run: runId, view: "replay" }, caseId),
    openCase: (caseId) => select({ case: caseId, run: null, view: "timeline" }),
    caseHref: (caseId) => href({ case: caseId, run: null, view: "timeline" }),
    projectId,
  }), [select, href, projectId]);

  const setView = useCallback((v: LineView) => select({ view: v }), [select]);
  // Comma opens this line's settings, the app's settings chord without the modifier.
  const router = useRouter();
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
  const tabTitle = (g: { key: string; title: string }) => {
    const place = graphPlaceTitle(g.key, product);
    return places.filter((p) => p === place).length > 1 ? `${place}: ${g.title}` : place;
  };
  const waits = rollup?.awaiting ?? 0;
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
            <div className="lw-seg" role="tablist" aria-label="Which graph">
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
              <button key={v} type="button" role="tab" aria-selected={selection.view === v} onClick={() => setView(v)} data-line-view-tab={v}>
                {LINE_VIEW_LABELS[v]}
                <span className="lw-seg-key"><KeyCap size="xs">{i + 1}</KeyCap></span>
              </button>
            ))}
          </div>

          <div className="lw-head-right">
            {a?.role && <StartChip admit={admit} waiting={rollup?.causes ?? null} notReady={rollup?.notReady} notReadyHref={`${lineWorkspaceHref(param, { view: "timeline" })}&show=notready`} />}
            {/* No judge yet: the loop's first step is setting one up (learning-loop.md LL4). */}
            {ws.loop && !hasJudges(ws.loop) && (
              <button type="button" className="lw-chip" data-tone="ask" onClick={() => startJudgingSetup(projectId)} title="A session drafts what this project should be judged on, tries it on recent data and brings you one card" data-line-setup-judging="head">
                Set up judging
              </button>
            )}
            {waits > 0 && (
              toWait
                ? <button type="button" className="lw-chip" data-tone="ask" onClick={() => select({ step: toWait })} data-line-waits={waits}><span className="lw-dot" />{waits} {waits === 1 ? "waits" : "wait"} for you</button>
                : <Link href="/questions" className="lw-chip" data-tone="ask" data-line-waits={waits}><span className="lw-dot" />{waits} {waits === 1 ? "waits" : "wait"} for you</Link>
            )}
            {stuck && <span className="lw-chip" data-tone="warn" style={{ cursor: "default", maxWidth: "34ch" }} title={stuck} data-line-stuck><span className="lw-dot" /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{stuck}</span></span>}
            <Link href={settingsHref} className="lw-iconbtn" aria-label="This line's settings" title="Settings (,)"><SlidersHorizontal className="w-4 h-4" /></Link>
          </div>
        </header>

        <div className="lw-body" data-drawer-open={drawerOpen ? "" : undefined}>
          <main className="lw-stage">
            {!model ? <Skeleton /> : (
              <div className="lw-stage-in" key={`${selection.view}:${model.graphKey}`}>
                <View model={model} workspace={ws} selection={selection} select={select} href={href} />
              </div>
            )}
          </main>
          <StepDrawer model={model} selection={drawerSelection} select={select} />
        </div>
      </div>
    </LineNavProvider>
  );
}

/** Whether the line starts problems on its own: the chip says it at a glance,
 *  and opens the switch with its slots and what turning it on would start. */
function StartChip({ admit, waiting, notReady, notReadyHref }: { admit: ReturnType<typeof useLineAdmission>; waiting: number | null; notReady?: NotReady; notReadyHref: string }) {
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
        title={a.role?.paused ? `@${a.role.handle} is paused; nothing starts until it resumes` : undefined}
        data-line-start-chip={a.on ? "on" : "off"}
      >
        <span className="lw-switch" aria-hidden />
        {a.on ? "Starts problems itself" : "Starts nothing itself"}
      </button>
      {open && (
        <div className="lw-pop lw-start-pop" role="dialog" aria-label="Starting problems">
          <LineStartSwitch admit={admit} waiting={waiting} notReady={notReady} notReadyHref={notReadyHref} />
        </div>
      )}
    </div>
  );
}
