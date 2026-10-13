"use client";
// The step page (line-journeys.md LJ8.6): one step of the line, full width,
// with one job by its kind. A person's step is where its decisions are
// answered: the page opens on what waits there, the first one open as the real
// decision. An agent's or a script's step is where a failure's cause is found
// and fixed: its work under Waiting, Failed and Passed, failures grouped by
// cause, each cause one press from the instructions with its runs as the test
// set. The head is the step's name, its one line of purpose and three counts
// that are the page's only filters; each count is the rows it opens.
//   ?step=<id>&show=waiting|failed|passed&steptab=work|instructions
import { memo, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { factsFor, runFactsByStep } from "../../../../lib/line/stepTable";
import { STEP_SHOWS, defaultShow, isStepShow, showLabels, stepWork, type StepShow } from "../../../../lib/line/stepWork";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { KindTag } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { StepInstructions } from "./StepInstructions";
import { StepWorkList } from "./StepWork";
import "./stepPage.css";

type PageTab = "work" | "instructions";
/** The tab an address names, the drawer's old names included. */
const tabOf = (v: string | null): PageTab | null => (v === "work" || v === "decisions" ? "work" : v === "instructions" || v === "prompt" || v === "try" || v === "ask" ? "instructions" : null);

export const StepPage = memo(function StepPage({ model, workspace: ws, selection, select, href }: LineViewProps) {
  const step = selection.step ? model.steps[selection.step] ?? null : null;
  const stepId = step?.id ?? null;

  // Why each run that failed at this step failed, and which of them only stopped needing a person's yes (a need, never a failure).
  const facts = useMemo(() => runFactsByStep(ws.rows.runs as unknown as Parameters<typeof runFactsByStep>[0]), [ws.rows.runs]);
  const { causes, stopped } = factsFor(facts, stepId);
  const work = useMemo(() => (step ? stepWork(step, { causes, stopped }) : null), [step, causes, stopped]);

  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<"test" | "ask" | null>(selection.tab === "ask" ? "ask" : selection.tab === "try" ? "test" : null);
  const [testRuns, setTestRuns] = useState<string[] | null>(null);
  const [asked, setAsked] = useState<PageTab | null>(null);
  /** The row the person opened (null: they shut it); undefined until they pick. */
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  // Another step starts clean: no edit mode, panel or test set carried over.
  const [shownStep, setShownStep] = useState(stepId);
  if (stepId !== shownStep) {
    setShownStep(stepId);
    setEditing(false);
    setPanel(null);
    setTestRuns(null);
    setAsked(null);
    setOpened(undefined);
  }

  const hasInstructions = !!step && step.kind !== "end" && (!!step.prompt || step.kind === "person" || step.kind === "agent");
  const tab: PageTab = hasInstructions ? asked ?? tabOf(selection.tab) ?? "work" : "work";
  const show: StepShow | null = isStepShow(selection.show) ? selection.show : null;
  // A person's step with something waiting opens on it: the address says so, so the count clicked and the rows agree.
  const wanted = step && work && !selection.show && tab === "work" ? defaultShow(step.kind, work.counts) : null;
  useWatchEffect(() => { if (wanted) select({ show: wanted }, undefined, { replace: true }); }, [wanted, select]);

  // The open row: the person's pick; until they pick, the run the address names, else the first that waits on a person.
  const firstWaiting = work?.waiting.find((r) => r.state !== "running")?.key ?? null;
  const runRow = useMemo(() => {
    if (!selection.run || !step) return null;
    const d = step.decisions.find((x) => x.runId === selection.run);
    return d ? d.caseId ?? `run:${d.runId}` : null;
  }, [selection.run, step]);
  const auto = runRow ?? (step?.kind === "person" || show === "waiting" ? firstWaiting : null);
  // An answered row leaves Waiting: when the person's open row was a waiting one and is gone, the next one opens.
  const [wasWaiting, setWasWaiting] = useState(false);
  const openIsWaiting = !!opened && !!work?.waiting.some((r) => r.key === opened);
  if (openIsWaiting !== wasWaiting && opened) setWasWaiting(openIsWaiting);
  const openKey = opened === undefined ? auto : opened && wasWaiting && !openIsWaiting && show === "waiting" ? firstWaiting : opened;

  if (!step || !work) return null;
  const labels = showLabels(step.kind);
  const setShow = (k: StepShow) => { setOpened(undefined); select({ show: show === k ? null : k, tab: tab === "work" ? undefined : "work" }, undefined, { replace: true }); if (tab !== "work") setAsked("work"); };
  const setTab = (t: PageTab) => { setAsked(t); select({ tab: t === "work" ? null : t }, undefined, { replace: true }); };
  const editFor = (runs: string[]) => { setTestRuns(runs); setEditing(true); setPanel(null); setTab("instructions"); };
  const who = step.kind === "agent" ? `Agent${step.model ? ` · ${step.model}` : ""}` : undefined;

  return (
    <div className="sp" data-line-step-page={step.id} data-kind={step.kind} data-tab={tab}>
      <header className="sp-head">
        <nav className="sp-crumb" aria-label="Where this is">
          <a href={href({ step: null, tab: null, show: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); select({ step: null, tab: null, show: null }); }} data-line-step-back>Line</a>
          <ChevronRight aria-hidden />
          <span aria-current="page">{step.label}</span>
        </nav>
        <div className="sp-title">
          <h1>{step.label}</h1>
          <KindTag kind={step.kind}>{who}</KindTag>
        </div>
        {step.purpose && <p className="sp-purpose">{step.purpose}</p>}
        <div className="sp-bar">
          <div className="sp-counts" role="group" aria-label="Show">
            {STEP_SHOWS.map((k) => (
              <button key={k} type="button" className="sp-count" data-show={k} data-zero={work.counts[k] ? undefined : ""} aria-pressed={tab === "work" && show === k} disabled={!work.counts[k]} onClick={() => setShow(k)} data-line-step-count={work.counts[k]}>
                <b className="lw-num">{work.counts[k]}</b>
                <span>{labels[k]}</span>
              </button>
            ))}
          </div>
          {hasInstructions && (
            <div className="lw-seg sp-tabs" role="tablist" aria-label={step.label}>
              <button type="button" role="tab" aria-selected={tab === "work"} onClick={() => setTab("work")} data-line-step-tab="work">Work</button>
              <button type="button" role="tab" aria-selected={tab === "instructions"} onClick={() => setTab("instructions")} data-line-step-tab="instructions">{step.kind === "person" ? "Question" : step.kind === "script" ? "Command" : "Instructions"}</button>
            </div>
          )}
        </div>
      </header>

      <div className="sp-body" role="tabpanel">
        {tab === "work" ? (
          <StepWorkList step={step} model={model} work={work} show={show} labels={labels} needs={ws.needs} openKey={openKey} onOpen={setOpened} onEditFor={hasInstructions ? editFor : undefined} now={ws.now} />
        ) : (
          <StepInstructions model={model} step={step} editing={editing} onEditing={setEditing} testRuns={testRuns} panel={panel} onPanel={setPanel} projects={ws.project ? [ws.project] : ws.projects} />
        )}
      </div>
    </div>
  );
});
