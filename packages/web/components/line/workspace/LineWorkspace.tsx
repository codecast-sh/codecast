"use client";
// A project's line workspace (docs/architecture/line-workspace.md LW1): one
// header (the project, which graph when it runs several, whether the line
// starts work on its own, what waits on you), five views over one model
// (Graph, Notebook, Replay, Chat, Timeline; keys 1 to 5) and the step drawer
// every view opens. The selection lives in the URL (useLineSelection), so any
// state is a link and every view reads the same one. `/line/<project>` and the
// project's Line tab both draw this.
import { useCallback, useMemo, type ComponentType } from "react";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { useLineSelection, useLineWorkspace } from "../../../hooks/useLineWorkspace";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useTabActive } from "../../../hooks/usePagePresence";
import { hasOpenModal } from "../../../shortcuts";
import { keyBelongsElsewhere } from "../../../shortcuts/keyOwnership";
import { lineSettingsHref } from "../../../lib/lineSettings";
import { lineProjectParam } from "../../../lib/line/lineStations";
import { LINE_VIEWS, LINE_VIEW_LABELS, lineViewForKey, type LineView } from "../../../lib/line/lineWorkspaceUrl";
import type { LineModel } from "../../../lib/line/lineModel";
import { KeyCap } from "../../KeyCap";
import { overviewWords } from "../LineProjects";
import { useLineAdmission } from "../map/useLineAdmission";
import { LineNavProvider, type LineNav } from "../widgets";
import { StepDrawer } from "./StepDrawer";
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
const VIEWS: Record<LineView, ComponentType<LineViewProps>> = { graph: GraphView, notebook: NotebookView, replay: ReplayView, chat: ChatView, timeline: TimelineView };

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
  const drawerOpen = !!(model && selection.step && model.steps[selection.step]);

  const nav = useMemo<LineNav>(() => ({
    openStep: (id) => select({ step: id }),
    openRun: (runId, caseId) => select({ run: runId, view: "replay" }, caseId),
    stepHref: (id) => href({ step: id }),
    runHref: (runId, caseId) => href({ run: runId, view: "replay" }, caseId),
  }), [select, href]);

  const setView = useCallback((v: LineView) => select({ view: v }), [select]);
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
                <button key={g.key} type="button" role="tab" aria-selected={g.key === model.graphKey} onClick={() => select({ graph: g.key })} title={g.work} data-line-graph-pick={g.key}>
                  {g.title}
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
            {a?.role && (
              <button
                type="button"
                role="switch"
                aria-checked={a.on}
                className="lw-chip"
                onClick={() => admit.setOn(!a.on)}
                title={a.role.paused ? `@${a.role.handle} is paused; nothing starts until it resumes` : undefined}
                data-line-start={a.on ? "on" : "off"}
              >
                <span className="lw-switch" aria-hidden />
                Starts problems on its own
              </button>
            )}
            {waits > 0 && (
              toWait
                ? <button type="button" className="lw-chip" data-tone="ask" onClick={() => select({ step: toWait })} data-line-waits={waits}><span className="lw-dot" />{waits} {waits === 1 ? "waits" : "wait"} for you</button>
                : <Link href="/questions" className="lw-chip" data-tone="ask" data-line-waits={waits}><span className="lw-dot" />{waits} {waits === 1 ? "waits" : "wait"} for you</Link>
            )}
            {stuck && <span className="lw-chip" data-tone="warn" style={{ cursor: "default" }} title={stuck} data-line-stuck><span className="lw-dot" />Stuck</span>}
            <Link href={lineSettingsHref({ project: param })} className="lw-iconbtn" aria-label="This line's settings" title="Settings"><SlidersHorizontal className="w-4 h-4" /></Link>
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
          <StepDrawer model={model} selection={selection} select={select} />
        </div>
      </div>
    </LineNavProvider>
  );
}
