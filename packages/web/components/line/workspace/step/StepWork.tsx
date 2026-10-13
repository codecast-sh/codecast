"use client";
// A step's work (line-journeys.md LJ8.6): one row per problem under Waiting,
// Failed (grouped by cause, the cause its heading) or Passed. A row is the
// problem's whole title; open, it is the real thing. At a person's step a
// waiting row is the decision itself, answered there (WaitingItem), and an
// answered one the decision with its answer. At an agent's or a script's step
// an open row says what the step was given, what it concluded and what it
// reported, in words a person uses, with the brief and the session on demand.
// One act by state: a failed row starts the problem again (through its
// review), a passed one is marked right or wrong.
import { memo, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { LineModel, LineStep, StepDecision } from "../../../../lib/line/lineModel";
import { decisionSaid } from "../../../../lib/line/lineModel";
import type { LineNeed } from "../../../../lib/line/lineNeeds";
import { plainOutcome, visitDecision, type FailGroup, type StepShow, type StepWork, type WorkRow } from "../../../../lib/line/stepWork";
import { decisionOutput, visitOutputWords } from "../../../../lib/line/visitOutput";
import { ageShort } from "../../../../lib/lineFlow";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../../store/inboxStore";
import { LineDecision } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { NavLink, dayWords, useLineNav } from "../../widgets/parts";
import { StartRunAct } from "../../widgets/StartRunAct";
import { StepVisit } from "./StepVisit";

type Card = { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number; resolved_at?: number; options?: Array<{ label: string }>; answer_index?: number; answer_text?: string };

/** The rows a list paints before "Show all": a long Passed list is not what a person came for. */
const PAGE = 40;

export type StepWorkListProps = {
  step: LineStep;
  model: LineModel;
  /** The rows and names an opened visit reads (the run row, its task, who answered). */
  ws: Pick<LineWorkspace, "rows" | "names">;
  work: StepWork;
  show: StepShow | null;
  labels: Record<StepShow, string>;
  needs: ReadonlyArray<LineNeed>;
  /** The open row (a problem's key), and how to open another. */
  openKey: string | null;
  onOpen: (key: string | null) => void;
  /** Open Instructions with these runs as the test set (a cause heading's act). */
  onEditFor?: (runs: string[]) => void;
  now: number;
};

export function StepWorkList({ step, model, ws, work, show, labels, needs, openKey, onOpen, onEditFor, now }: StepWorkListProps) {
  const shows = (k: StepShow) => !show || show === k;
  const row = (r: WorkRow) => <Row key={r.key} r={r} step={step} model={model} ws={ws} needs={needs} open={openKey === r.key} onToggle={() => onOpen(openKey === r.key ? null : r.key)} now={now} />;
  const total = work.counts.waiting + work.counts.failed + work.counts.passed + work.replaced.length;
  if (!total) return <div className="sp-none" data-line-step-empty>Nothing has reached {step.label} yet.</div>;
  if (show && !work.counts[show]) return <div className="sp-none" data-line-step-empty>None {labels[show].toLowerCase()}.</div>;
  return (
    <div className="sp-work" data-line-step-work={step.id}>
      {shows("waiting") && work.waiting.length > 0 && (
        <Section name={labels.waiting} n={work.waiting.length} kind="waiting">{work.waiting.map(row)}</Section>
      )}
      {shows("failed") && work.failed.map((g) => <FailSection key={g.key} g={g} step={step} row={row} onEditFor={onEditFor} />)}
      {shows("passed") && work.passed.length > 0 && <Paged name={labels.passed} kind="passed" rows={work.passed} row={row} openKey={openKey} />}
      {!show && work.replaced.length > 0 && <Paged name="Replaced by a newer run" kind="replaced" rows={work.replaced} row={row} openKey={openKey} folded />}
    </div>
  );
}

function Section({ name, n, kind, children, act }: { name: string; n: number; kind: string; children: ReactNode; act?: ReactNode }) {
  return (
    <section className="sp-sec" data-line-step-group={kind} data-count={n}>
      <header className="sp-sec-h">
        <h3><span className="lw-num">{n}</span> {name}</h3>
        {act}
      </header>
      <div className="sp-rows">{children}</div>
    </section>
  );
}

/** One cause of failure: how many problems it stopped, in plain words, with the act that fixes the cause. */
function FailSection({ g, step, row, onEditFor }: { g: FailGroup; step: LineStep; row: (r: WorkRow) => ReactNode; onEditFor?: (runs: string[]) => void }) {
  // An unanswered question is fixed by answering or asking it again, never by editing its prompt.
  const editable = !!step.prompt && step.kind !== "end" && step.kind !== "person" && !!onEditFor;
  return (
    <Section name={g.label} n={g.rows.length} kind="failed" act={editable ? (
      <button type="button" className="lw-act" onClick={() => onEditFor!(g.rows.map((r) => r.d.runId))} data-line-step-fix={g.key}>Edit instructions</button>
    ) : undefined}>
      {g.rows.map(row)}
    </Section>
  );
}

/** A long list, a page at a time; the open row is always among those shown. */
function Paged({ name, kind, rows, row, openKey, folded }: { name: string; kind: string; rows: WorkRow[]; row: (r: WorkRow) => ReactNode; openKey: string | null; folded?: boolean }) {
  const [all, setAll] = useState(false);
  const [shut, setShut] = useState(!!folded);
  const at = openKey ? rows.findIndex((r) => r.key === openKey) : -1;
  const shown = all ? rows : rows.slice(0, Math.max(PAGE, at + 1));
  if (folded && shut && at < 0) {
    return (
      <section className="sp-sec" data-line-step-group={kind} data-count={rows.length}>
        <button type="button" className="sp-sec-fold" onClick={() => setShut(false)} aria-expanded={false}><ChevronRight aria-hidden /><span className="lw-num">{rows.length}</span> {name.toLowerCase()}</button>
      </section>
    );
  }
  return (
    <Section name={name} n={rows.length} kind={kind}>
      {shown.map(row)}
      {shown.length < rows.length && <button type="button" className="sp-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </Section>
  );
}

const STATE_WORDS: Partial<Record<WorkRow["state"], string>> = { running: "Running now", stopped: "Stopped here, needs a yes" };

/** What a closed row says under its title: what the step concluded, in a line. */
function rowLine(r: WorkRow, step: LineStep): { tag: string | null; tone?: string; text: string | null } {
  const d = r.d;
  if (r.state === "waiting") return { tag: null, text: null };
  if (r.state === "running" || r.state === "stopped") return { tag: STATE_WORDS[r.state]!, tone: r.state === "running" ? "live" : "person", text: null };
  if (r.state === "replaced") return { tag: null, text: null };
  const out = decisionOutput(step.kind, d);
  if (step.kind === "person") {
    // A no-answer row sits under its state's own heading (Lapsed, Withdrawn): its line says why, when the run said.
    if (d.answer && d.answer.state !== "answered") return { tag: null, text: d.answer.why };
    const tag = d.answer ? d.answer.words : plainOutcome(out?.kind === "choice" ? out.choice : d.decided.toWords ?? d.decided.words);
    return { tag: tag || null, tone: "person", text: out?.kind === "choice" ? out.note : out?.kind === "text" ? out.text : null };
  }
  // The group's heading says the cause: the line under a failed row says only what the heading does not.
  if (r.state === "failed") { const t = visitOutputWords(out); return { tag: null, text: t && r.cause && restates(t, r.cause.label) ? null : t }; }
  const own = d.decided.outcome ?? d.decided.toWords;
  return { tag: own ? plainOutcome(own) : null, text: out?.kind === "text" ? out.text : decisionSaid(d) === d.decided.words ? null : decisionSaid(d) };
}

/** Whether a line only says its heading again ("Ran out of time after 30m and was killed" under "Out of time, 30m"). */
function restates(text: string, heading: string): boolean {
  const words = (x: string) => new Set(x.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const head = words(heading);
  if (!head.size) return false;
  const said = words(text);
  let shared = 0;
  for (const w of head) if (said.has(w)) shared++;
  return shared / head.size >= 0.6 && said.size <= head.size * 3;
}

const Row = memo(function Row({ r, step, model, ws, needs, open, onToggle, now }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"]; needs: ReadonlyArray<LineNeed>; open: boolean; onToggle: () => void; now: number }) {
  const d = r.d;
  const nav = useLineNav();
  const line = rowLine(r, step);
  const since = d.at ? ageShort(now - d.at) : null;
  const times = (r.again?.length ?? 0) + 1;
  return (
    <article className="sp-row" data-open={open ? "" : undefined} data-state={r.state} data-line-step-row={r.key} data-run={d.runId}>
      <div className="sp-row-h">
        <button type="button" className="sp-row-tog" aria-expanded={open} onClick={onToggle}>
          <ChevronRight className="sp-row-caret" aria-hidden />
          <span className="sp-row-main">
            <span className="sp-row-title">{d.caseTitle}</span>
            {(line.tag || line.text || times > 1) && (
              <span className="sp-row-said">
                {line.tag && <span className="sp-tag" data-tone={line.tone}>{line.tag}</span>}
                {times > 1 && <span className="sp-tag" data-tone="bad">{times} times</span>}
                {line.text && <span>{line.text}</span>}
              </span>
            )}
          </span>
        </button>
        <span className="sp-row-meta lw-num">
          {/* The ref is the problem's own link: the row's title stays the problem, open or shut. */}
          {d.caseRef && (d.caseId && nav.openCase
            ? <NavLink className="sp-row-ref" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>{d.caseRef}</NavLink>
            : <span className="sp-row-ref">{d.caseRef}</span>)}
          {since && <span title={d.at ? new Date(d.at).toLocaleString() : undefined}>{r.state === "waiting" ? `waiting ${since}` : since}</span>}
        </span>
      </div>
      {open && <div className="sp-row-b">{step.kind === "person" || r.state === "stopped" ? <Thing r={r} step={step} model={model} ws={ws} needs={needs} now={now} /> : <Visit r={r} step={step} model={model} ws={ws} />}</div>}
    </article>
  );
});

/** The decision of one visit to a person's step, any status: its ref, and how it was answered. */
function useVisitCard(runId: string, stepId: string, status: "pending" | "any"): Card | null {
  const sig = useInboxStore((s) => {
    const st = s as unknown as { lineCards?: Record<string, Card>; sessionDecisions?: Record<string, Card> };
    const c = visitDecision([...Object.values(st.sessionDecisions ?? {}), ...Object.values(st.lineCards ?? {})], runId, stepId, status);
    return c ? JSON.stringify({ _id: c._id, short_id: c.short_id, status: c.status, created_at: c.created_at, resolved_at: c.resolved_at, answer_index: c.answer_index, answer_text: c.answer_text, options: c.options?.map((o) => ({ label: o.label })) }) : "";
  });
  return useMemo(() => (sig ? (JSON.parse(sig) as Card) : null), [sig]);
}

/** A waiting or answered row at a person's step, and a run that stopped needing a yes: the thing itself, in a box of its own height. */
function Thing({ r, step, model, ws, needs, now }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"]; needs: ReadonlyArray<LineNeed>; now: number }) {
  const nav = useLineNav();
  const d = r.d;
  const waits = r.state === "waiting" || r.state === "stopped";
  const need = waits ? needs.find((n) => n.runId === d.runId) ?? needs.find((n) => !!d.caseId && n.caseId === d.caseId) ?? null : null;
  const card = useVisitCard(d.runId, step.id, waits ? "pending" : "any");
  const problem = useProblemState(d.caseId);
  const toProblem = (id: string) => nav.openCase?.(id);
  const toRun = (runId: string, caseId: string | null) => nav.openRun(runId, caseId);
  // The row's head already names the problem, its ref and how long it has waited: the decision opens on its question,
  // in the page's flow, its answers docked at the viewport's foot.
  if (need) {
    const flow = need.kind === "decision" || need.kind === "lapsed";
    return <div className="sp-thing" data-flow={flow ? "" : undefined} data-line-step-thing="need"><WaitingItem need={need} now={now} head={false} inline={flow} /></div>;
  }
  // Lapsed or withdrawn: the question as it was asked, closed, and the one act that can still get it answered.
  const unanswered = r.state === "failed" && !!d.answer && d.answer.state !== "answered";
  const again = unanswered && problem && !problem.closed ? <StartRunAct label="Ask again" icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden />} taskId={d.caseId!} problem={d.caseRef ? `${d.caseRef} · ${d.caseTitle}` : d.caseTitle} projectId={problem.projectId} branch={d.answer?.state === "lapsed"} /> : null;
  if (card) {
    return (
      <>
        <div className="sp-thing" data-flow="" data-line-step-thing="decision"><LineDecision id={card.short_id ?? card._id} onProblem={toProblem} onRun={toRun} head={false} inline act={!unanswered} /></div>
        {unanswered && <div className="sp-detail sp-detail-foot"><Foot d={d}>{again}</Foot></div>}
      </>
    );
  }
  // An agent's step that stopped with nothing asked of anyone yet: what it concluded is the thing.
  if (step.kind !== "person") return <Visit r={r} step={step} model={model} ws={ws} />;
  // No decision reached this visit: say so, why when the run said, and where its run is.
  return (
    <div className="sp-detail" data-line-step-thing="none">
      <p className="sp-said">{waits ? "This run reached the step, and no decision was presented for it."
        : problem?.closed ? `Nothing was asked before the run ended, and the problem is ${problem.status}: there is nothing to ask again.`
        : "Nothing was asked before the run ended."}</p>
      <Foot d={d}>{again}</Foot>
    </div>
  );
}

/** A problem's status and project, read from the store: a closed problem has nothing to ask again. */
function useProblemState(caseId: string | null): { status: string; closed: boolean; projectId: string | null } | null {
  const sig = useInboxStore((s) => { const t = caseId ? (s.tasks as Record<string, { status?: string; project_id?: string | null }> | undefined)?.[caseId] : null; return t ? `${t.status ?? ""}\u0000${t.project_id ?? ""}` : null; });
  return useMemo(() => {
    if (!sig) return null;
    const [status, projectId] = sig.split("\u0000");
    return { status, closed: /^(dropped|closed|done|cancell?ed|wontfix)$/.test(status), projectId: projectId || null };
  }, [sig]);
}

/** An open row at an agent's or a script's step: the visit as the run page shows it, its one act in its head, then where else to read. */
function Visit({ r, step, model, ws }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"] }) {
  const d = r.d;
  const projectId = useInboxStore((s) => (d.caseId ? (s.tasks as Record<string, { project_id?: string | null }> | undefined)?.[d.caseId]?.project_id ?? null : null));
  const act = (r.state === "failed" || r.state === "stopped") && d.caseId
    ? <StartRunAct icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden />} taskId={d.caseId} problem={d.caseRef ? `${d.caseRef} · ${d.caseTitle}` : d.caseTitle} projectId={projectId} />
    : r.state === "passed" ? <Mark step={step} d={d} /> : null;
  return (
    <>
      <StepVisit model={model} ws={ws} d={d} act={act} fallback={<div className="sp-detail"><Foot d={d} earlier={r.earlier} again={r.again}>{act}</Foot></div>} />
      {model.runs.some((x) => x.id === d.runId) && <div className="sp-detail sp-detail-foot"><Foot d={d} earlier={r.earlier} again={r.again} /></div>}
    </>
  );
}

/** An open row's foot: its one act, then where else to read (the run, the session, earlier runs of the same problem here). */
function Foot({ d, took, earlier, again, children }: { d: StepDecision; took?: string | null; earlier?: StepDecision[]; again?: StepDecision[]; children?: ReactNode }) {
  const nav = useLineNav();
  const [more, setMore] = useState(false);
  // The earlier runs of this problem here, and those this row stands for (it failed the same way before): each its own link.
  const older = [...(again ?? []), ...(earlier ?? [])].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  return (
    <footer className="sp-foot">
      <div className="sp-foot-act">{children}</div>
      <div className="sp-foot-links">
        {took && <span className="sp-quiet lw-num">took {took}</span>}
        <NavLink className="lw-link" href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Open the run</NavLink>
        {d.caseId && nav.openCase && <NavLink className="lw-link" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>Open the problem</NavLink>}
        {d.received.href && <a className="lw-link" href={d.received.href}>Open its session</a>}
        {older.length > 0 && <button type="button" className="lw-link" aria-expanded={more} onClick={() => setMore((v) => !v)}>{older.length} earlier {older.length === 1 ? "run" : "runs"} of this problem</button>}
      </div>
      {more && older.length > 0 && (
        <ul className="sp-earlier">
          {older.map((e) => (
            <li key={e.id}>
              <NavLink className="lw-link" href={nav.runHref(e.runId, e.caseId)} onOpen={() => nav.openRun(e.runId, e.caseId)}>{dayWords(e.at) ?? "Earlier"}</NavLink>
              <span>{plainOutcome(e.status === "failed" && !e.decided.outcome ? "failed" : e.decided.outcome ?? e.decided.toWords ?? e.decided.words)}</span>
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

/** Right or wrong on a passed visit, one two-way control: the step's test set, and what an agent asked to change it is shown. */
function Mark({ step, d }: { step: LineStep; d: StepDecision }) {
  const mine = d.labels.find((l) => l.mine) ?? null;
  const [note, setNote] = useState(mine?.note ?? "");
  const label = (verdict: "right" | "wrong" | null, text?: string | null) => { void useInboxStore.getState().labelDecision(d.runId, step.id, verdict, text ?? null); };
  const press = (verdict: "right" | "wrong") => () => label(mine?.verdict === verdict ? null : verdict, verdict === "wrong" ? note || null : null);
  return (
    <span className="sp-mark" data-line-step-mark={mine?.verdict ?? "none"}>
      <span className="lw-seg" role="group" aria-label="Was this right?">
        <button type="button" aria-pressed={mine?.verdict === "right"} onClick={press("right")}>Mark right</button>
        <button type="button" aria-pressed={mine?.verdict === "wrong"} onClick={press("wrong")}>Mark wrong</button>
      </span>
      {mine?.verdict === "wrong" && (
        <input
          className="sp-mark-note"
          value={note}
          placeholder="What should it have concluded?"
          aria-label="What should it have concluded?"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if ((mine.note ?? "") !== note) label("wrong", note || null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        />
      )}
    </span>
  );
}
