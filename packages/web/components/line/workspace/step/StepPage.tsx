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
import { factsFor, needSpread, needSteps, waitOwner } from "../../../../lib/line/stepTable";
import { lineProblemsAt } from "../../../../lib/line/problemTable";
import { useStepFacts } from "./useStepFacts";
import { STEP_SHOWS, defaultShow, readShow, showLabels, showParam, stepWork, visitDecision, type StepShow, type StepWork, type WorkRow } from "../../../../lib/line/stepWork";
import type { LineStep } from "../../../../lib/line/lineModel";
import type { LineNeed } from "../../../../lib/line/lineNeeds";
import { useInboxStore } from "../../../../store/inboxStore";
import { useDecisionDetail, useSyncDecisionDetail } from "../../../../hooks/useSyncDecisionDetail";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { KindTag } from "../../widgets";
import type { LineViewProps } from "../views/types";
import { StepInstructions } from "./StepInstructions";
import { StepWorkList } from "./StepWork";
import "./stepPage.css";

type PageTab = "work" | "instructions";
/** The tab an address names, the drawer's old names included. */
const tabOf = (v: string | null): PageTab | null => (v === "work" || v === "decisions" ? "work" : v === "instructions" || v === "prompt" || v === "try" || v === "ask" ? "instructions" : null);

/** Who decides at a person's step, by the same reading as the Steps table (waitOwner): "You decide" only when something
 *  waiting is the viewer's own; when all of it is held by others, the person who holds it, named from its decision. */
function Decider({ step, work, needs }: { step: LineStep; work: StepWork; needs: ReadonlyArray<LineNeed> }) {
  const owners = work.waiting.map((r) => [r, waitOwner(r, step.kind, needs)] as const);
  const held = owners.find(([, o]) => o === "others")?.[0] ?? null;
  const mine = owners.some(([, o]) => o === "you");
  if (mine) return <KindTag kind="person">You decide</KindTag>;
  if (held) return <HeldBy row={held} stepId={step.id} />;
  return <KindTag kind="person">A person decides</KindTag>;
}

function HeldBy({ row, stepId }: { row: WorkRow; stepId: string }) {
  const ref = useInboxStore((s) => {
    const st = s as unknown as { lineCards?: Record<string, { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number }>; sessionDecisions?: Record<string, { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number }> };
    const c = visitDecision([...Object.values(st.sessionDecisions ?? {}), ...Object.values(st.lineCards ?? {})], row.d.runId, stepId);
    return c ? c.short_id ?? c._id : undefined;
  });
  useSyncDecisionDetail(ref);
  const detail = useDecisionDetail(ref);
  // A role holds it under a grant, else the people it asks.
  const names = (detail ? (detail.decision.holder?.kind === "role" ? [detail.holder_role?.name ?? ""] : detail.asked_users.map((u) => u.name)) : []).filter(Boolean);
  return <KindTag kind="person">{names.length ? `${names.join(", ")} decides` : "Someone else decides"}</KindTag>;
}

/** A person's step with nothing waiting on it: where the viewer's waits are instead, each one press from its rows, so
 *  "Decide" with nothing to decide still leads to what is. The same split as the Steps table's head (needSpread). */
function WaitingElsewhere({ model, ws, here, href }: { model: LineViewProps["model"]; ws: LineViewProps["workspace"]; here: string; href: LineViewProps["href"] }) {
  const spread = useMemo(() => needSpread(ws.needs, model.runs, model.graphKey), [ws.needs, model.runs, model.graphKey]);
  const steps = model.order.filter((id) => id !== here && spread.byStep.get(id)).map((id) => ({ id, n: spread.byStep.get(id)!, label: model.steps[id]?.label ?? id }));
  const lines = [...spread.lines].map(([key, n]) => ({ key, n, title: ws.processes.find((p) => p.key === key)?.title ?? key }));
  if (!steps.length && !lines.length && !spread.before) return null;
  return (
    <nav className="sp-else" aria-label="Waiting on you elsewhere" data-line-step-elsewhere="">
      <span className="sp-else-k">Waiting on you</span>
      {steps.map((s) => <a key={s.id} href={href({ step: s.id, show: "waiting", tab: null })} data-line-else-step={s.id}><b className="lw-num">{s.n}</b> {s.label}</a>)}
      {lines.map((l) => <a key={l.key} href={href({ graph: l.key, step: null, show: null, tab: null })} data-line-else-line={l.key}><b className="lw-num">{l.n}</b> {l.title}</a>)}
      {spread.before > 0 && <a href={href({ view: "foryou", step: null, show: null, tab: null })} data-line-else-before=""><b className="lw-num">{spread.before}</b> before a run</a>}
    </nav>
  );
}

export const StepPage = memo(function StepPage({ model, workspace: ws, selection, select, href }: LineViewProps) {
  const step = selection.step ? model.steps[selection.step] ?? null : null;
  const stepId = step?.id ?? null;

  // Why each run that failed at this step failed, and which of them only stopped needing a person's yes (a need, never a failure).
  const { facts, closed, newest, standing, problems } = useStepFacts(model, ws);
  // Open problems with the line about this step: a run that failed here fails the same way until that fix lands.
  const holders = useMemo(() => (stepId ? lineProblemsAt(problems, new Set([stepId])) : []), [problems, stepId]);
  const { causes, stopped, ends, review, cleared } = factsFor(facts, stepId);
  // Each For you item waits at one step: the one the Steps table counts it at.
  const asks = useMemo(() => needSteps(ws.needs, model.runs).at, [ws.needs, model.runs]);
  const work = useMemo(() => (step ? stepWork(step, { causes, stopped, closed, ends, newest, review, cleared, standing, asks }) : null), [step, causes, stopped, closed, ends, newest, review, cleared, standing, asks]);

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

  // The page head stays on top as the page scrolls: an open row's title pins under it, and a row brought into view
  // lands below it (stepPage.css --sp-head-h), never behind it.
  const [head, setHead] = useState<HTMLElement | null>(null);
  useWatchEffect(() => {
    const page = head?.parentElement;
    if (!head || !page || typeof ResizeObserver === "undefined") return;
    const set = () => page.style.setProperty("--sp-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(head);
    return () => ro.disconnect();
  }, [head]);

  const hasInstructions = !!step && step.kind !== "end" && (!!step.prompt || step.kind === "person" || step.kind === "agent");
  const tab: PageTab = hasInstructions ? asked ?? tabOf(selection.tab) ?? "work" : "work";
  const show: StepShow | null = readShow(selection.show);
  // A step with something waiting on the viewer opens on it, from whichever press reached it (node, name, badge): the
  // address says so, so the count clicked and the rows agree.
  const mine = useMemo(() => (step && work ? work.waiting.filter((r) => waitOwner(r, step.kind, ws.needs) === "you") : []), [step, work, ws.needs]);
  const wanted = step && work && !selection.show && tab === "work" ? defaultShow(step.kind, work.counts, mine.length) : null;
  useWatchEffect(() => { if (wanted) select({ show: wanted }, undefined, { replace: true }); }, [wanted, select]);

  // The open row: the person's pick; until they pick, the run the address names, else the first that waits on a person.
  const firstWaiting = mine[0]?.key ?? work?.waiting.find((r) => r.state !== "running")?.key ?? null;
  const runRow = useMemo(() => {
    if (!selection.run || !step) return null;
    const d = step.decisions.find((x) => x.runId === selection.run);
    return d ? d.caseId ?? `run:${d.runId}` : null;
  }, [selection.run, step]);
  // A person's step opens on its first decision: answering it is the page's job. Elsewhere rows start shut, each saying
  // its state and act in its line, and open on a press.
  // Any step that holds something on the viewer (a finished step's yes, a fix to close) opens on the first of those too.
  const onMine = step?.kind === "person" || (mine.length > 0 && (!show || show === "waiting"));
  const auto = runRow ?? (onMine ? firstWaiting : null);
  // An answered row leaves Waiting: when the person's open row was a waiting one and is gone, the next one opens.
  const [wasWaiting, setWasWaiting] = useState(false);
  const openIsWaiting = !!opened && !!work?.waiting.some((r) => r.key === opened);
  if (openIsWaiting !== wasWaiting && opened) setWasWaiting(openIsWaiting);
  const openKey = opened === undefined ? auto : opened && wasWaiting && !openIsWaiting && show === "waiting" && onMine ? firstWaiting : opened;

  if (!step || !work) return null;
  const labels = showLabels(step.kind);
  const setShow = (k: StepShow) => { setOpened(undefined); select({ show: show === k ? null : showParam(step.kind, k), tab: tab === "work" ? undefined : "work" }, undefined, { replace: true }); if (tab !== "work") setAsked("work"); };
  const setTab = (t: PageTab) => { setAsked(t); select({ tab: t === "work" ? null : t }, undefined, { replace: true }); };
  const editFor = (runs: string[]) => { setTestRuns(runs); setEditing(true); setPanel(null); setTab("instructions"); };
  const who = step.kind === "agent" ? `Agent${step.model ? ` · ${step.model}` : ""}` : undefined;

  return (
    <div className="sp" data-line-step-page={step.id} data-kind={step.kind} data-tab={tab}>
      <header className="sp-head" ref={setHead}>
        <nav className="sp-crumb" aria-label="Where this is">
          <a href={href({ step: null, tab: null, show: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); select({ step: null, tab: null, show: null }); }} data-line-step-back>Steps</a>
          <ChevronRight aria-hidden />
          <span aria-current="page">{step.label}</span>
        </nav>
        <div className="sp-title">
          <h1>{step.label}</h1>
          {step.kind === "person" ? <Decider step={step} work={work} needs={ws.needs} /> : <KindTag kind={step.kind}>{who}</KindTag>}
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
        {tab === "work" && step.kind === "person" && !work.counts.waiting && (!show || show === "waiting") && <WaitingElsewhere model={model} ws={ws} here={step.id} href={href} />}
        {tab === "work" ? (
          <StepWorkList step={step} model={model} ws={ws} work={work} show={show} labels={labels} needs={ws.needs} openKey={openKey} onOpen={setOpened} onEditFor={hasInstructions ? editFor : undefined} holders={holders} problems={problems} now={ws.now} />
        ) : (
          <StepInstructions model={model} step={step} editing={editing} onEditing={setEditing} testRuns={testRuns} panel={panel} onPanel={setPanel} projects={ws.project ? [ws.project] : ws.projects} />
        )}
      </div>
    </div>
  );
});
