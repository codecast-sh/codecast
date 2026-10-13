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
import { ChevronRight } from "lucide-react";
import type { LineModel, LineStep, StepDecision } from "../../../../lib/line/lineModel";
import { decisionSaid } from "../../../../lib/line/lineModel";
import type { LineNeed } from "../../../../lib/line/lineNeeds";
import { concludedText, plainOutcome, reportRows, visitDecision, type FailGroup, type StepShow, type StepWork, type WorkRow } from "../../../../lib/line/stepWork";
import { decisionOutput, visitOutputWords } from "../../../../lib/line/visitOutput";
import { ageShort } from "../../../../lib/lineFlow";
import { useStationInput } from "../../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../../store/inboxStore";
import { MarkdownRenderer } from "../../../tools/MarkdownRenderer";
import { LineDecision } from "../../widgets/LineDecision";
import { WaitingItem } from "../../widgets/WaitingItem";
import { NavLink, dayWords, durationWords, useLineNav } from "../../widgets/parts";
import { StartAgain } from "../views/run/StartAgain";

type Card = { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number; resolved_at?: number; options?: Array<{ label: string }>; answer_index?: number; answer_text?: string };

/** The rows a list paints before "Show all": a long Passed list is not what a person came for. */
const PAGE = 40;

export type StepWorkListProps = {
  step: LineStep;
  model: LineModel;
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

export function StepWorkList({ step, model, work, show, labels, needs, openKey, onOpen, onEditFor, now }: StepWorkListProps) {
  const shows = (k: StepShow) => !show || show === k;
  const row = (r: WorkRow) => <Row key={r.key} r={r} step={step} model={model} needs={needs} open={openKey === r.key} onToggle={() => onOpen(openKey === r.key ? null : r.key)} now={now} />;
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
  const editable = !!step.prompt && step.kind !== "end" && !!onEditFor;
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
    const choice = out?.kind === "choice" ? out.choice : d.decided.toWords ?? d.decided.words;
    return { tag: choice ? plainOutcome(choice) : null, tone: "person", text: out?.kind === "choice" ? out.note : out?.kind === "text" ? out.text : null };
  }
  if (r.state === "failed") return { tag: null, text: visitOutputWords(out) };
  const own = d.decided.outcome ?? d.decided.toWords;
  return { tag: own ? plainOutcome(own) : null, text: out?.kind === "text" ? out.text : decisionSaid(d) === d.decided.words ? null : decisionSaid(d) };
}

const Row = memo(function Row({ r, step, model, needs, open, onToggle, now }: { r: WorkRow; step: LineStep; model: LineModel; needs: ReadonlyArray<LineNeed>; open: boolean; onToggle: () => void; now: number }) {
  const d = r.d;
  const line = rowLine(r, step);
  const since = d.at ? ageShort(now - d.at) : null;
  return (
    <article className="sp-row" data-open={open ? "" : undefined} data-state={r.state} data-line-step-row={r.key} data-run={d.runId}>
      <button type="button" className="sp-row-h" aria-expanded={open} onClick={onToggle}>
        <ChevronRight className="sp-row-caret" aria-hidden />
        <span className="sp-row-main">
          <span className="sp-row-title">{d.caseTitle}</span>
          {(line.tag || line.text) && (
            <span className="sp-row-said">
              {line.tag && <span className="sp-tag" data-tone={line.tone}>{line.tag}</span>}
              {line.text && <span>{line.text}</span>}
            </span>
          )}
        </span>
        <span className="sp-row-meta lw-num">
          {d.caseRef && <span className="sp-row-ref">{d.caseRef}</span>}
          {since && <span title={d.at ? new Date(d.at).toLocaleString() : undefined}>{r.state === "waiting" ? `waiting ${since}` : since}</span>}
        </span>
      </button>
      {open && <div className="sp-row-b">{step.kind === "person" || r.state === "stopped" ? <Thing r={r} step={step} model={model} needs={needs} now={now} /> : <Detail r={r} step={step} model={model} />}</div>}
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
function Thing({ r, step, model, needs, now }: { r: WorkRow; step: LineStep; model: LineModel; needs: ReadonlyArray<LineNeed>; now: number }) {
  const nav = useLineNav();
  const d = r.d;
  const waits = r.state === "waiting" || r.state === "stopped";
  const need = waits ? needs.find((n) => n.runId === d.runId) ?? needs.find((n) => !!d.caseId && n.caseId === d.caseId) ?? null : null;
  const card = useVisitCard(d.runId, step.id, waits ? "pending" : "any");
  const toProblem = (id: string) => nav.openCase?.(id);
  const toRun = (runId: string, caseId: string | null) => nav.openRun(runId, caseId);
  if (need) return <div className="sp-thing" data-line-step-thing="need"><WaitingItem need={need} now={now} /></div>;
  if (card) return <div className="sp-thing" data-line-step-thing="decision"><LineDecision id={card.short_id ?? card._id} onProblem={toProblem} onRun={toRun} /></div>;
  // An agent's step that stopped with nothing asked of anyone yet: what it concluded is the thing.
  if (step.kind !== "person") return <Detail r={r} step={step} model={model} />;
  // No decision reached this visit: say so, and where its run is.
  return (
    <div className="sp-detail" data-line-step-thing="none">
      <dl className="sp-kv">
        <dt>{waits ? "Waiting" : "Answer"}</dt>
        <dd>{waits ? "This run reached the step, and no decision was presented for it." : d.reasoning?.trim() || plainOutcome(d.decided.toWords ?? d.decided.words) || "No answer was recorded."}</dd>
      </dl>
      <Foot d={d} />
    </div>
  );
}

/** An open row at an agent's or a script's step: given, concluded, reported; then its one act. */
function Detail({ r, step, model }: { r: WorkRow; step: LineStep; model: LineModel }) {
  const d = r.d;
  const nav = useLineNav();
  const said = concludedText(d.reasoning);
  const rows = useMemo(() => reportRows(d.decided.result), [d.decided.result]);
  const out = visitOutputWords(decisionOutput(step.kind, d));
  const projectId = useInboxStore((s) => (d.caseId ? (s.tasks as Record<string, { project_id?: string | null }> | undefined)?.[d.caseId]?.project_id ?? null : null));
  const from = d.received.from ? model.steps[d.received.from] : null;
  const given = d.received.said ? (d.received.fromLabel ? d.received.summary.replace(`${d.received.fromLabel}: `, "") : d.received.summary) : null;
  // A failure the step left no words for: the step before it is where to look.
  const silent = r.state === "failed" && !said && !out && !rows.length;
  const took = durationWords(d.durationMs);
  return (
    <div className="sp-detail" data-line-step-detail={d.id}>
      <dl className="sp-kv">
        <dt>Given</dt>
        <dd>
          {given ? <p>{d.received.fromLabel ? <>From {d.received.fromLabel}: </> : null}{given}</p> : <p>{d.received.fromLabel ? `The run, passed on by ${d.received.fromLabel}` : "The problem as it was filed"}</p>}
          {d.received.sessionId && <Brief sessionId={d.received.sessionId} runId={d.runId} />}
        </dd>
        {r.state === "failed" && (
          <>
            <dt>Why it failed</dt>
            <dd data-tone="bad">
              {silent && from ? (
                <p>{step.label} recorded no reason. <NavLink className="lw-link" href={nav.stepHref(from.id)} onOpen={() => nav.openStep(from.id)}>Open {from.label}, the step before it</NavLink></p>
              ) : <p>{r.cause?.label}{out && out !== r.cause?.label ? `: ${out}` : ""}</p>}
            </dd>
          </>
        )}
        {said ? (
          <>
            <dt>Concluded</dt>
            <dd><MarkdownRenderer content={said} className="sp-md" /></dd>
          </>
        ) : r.state !== "failed" && out ? (
          <>
            <dt>Concluded</dt>
            <dd><p>{out}</p></dd>
          </>
        ) : null}
        {rows.map((f) => (
          <div key={f.name} style={{ display: "contents" }}>
            <dt>{f.name}</dt>
            <dd data-mono={f.mono ? "" : undefined}>{f.value}</dd>
          </div>
        ))}
        {d.label?.note && (<><dt>{d.label.mine ? "Your note" : d.label.byName ?? "Note"}</dt><dd><p>{d.label.note}</p></dd></>)}
      </dl>
      <Foot d={d} took={took} earlier={r.earlier}>
        {r.state === "failed" && d.caseId && <StartAgain taskId={d.caseId} problem={d.caseRef ? `${d.caseRef} · ${d.caseTitle}` : d.caseTitle} projectId={projectId} />}
        {r.state === "passed" && <Mark step={step} d={d} />}
      </Foot>
    </div>
  );
}

/** The whole brief the step was handed, read only when asked for. */
function Brief({ sessionId, runId }: { sessionId: string; runId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="lw-link" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-line-step-brief>{open ? "Hide the whole brief" : "Read the whole brief"}</button>
      {open && <BriefText sessionId={sessionId} runId={runId} />}
    </>
  );
}

function BriefText({ sessionId, runId }: { sessionId: string; runId: string }) {
  const input = useStationInput(sessionId, runId);
  if (input === undefined) return <p className="sp-quiet" aria-busy>Reading the brief</p>;
  if (!input?.found || !input.text) return <p className="sp-quiet">Its session kept no brief.</p>;
  return <pre className="sp-brief">{input.text}</pre>;
}

/** An open row's foot: its one act, then where else to read (the run, the session, earlier runs of the same problem here). */
function Foot({ d, took, earlier, children }: { d: StepDecision; took?: string | null; earlier?: StepDecision[]; children?: ReactNode }) {
  const nav = useLineNav();
  const [more, setMore] = useState(false);
  return (
    <footer className="sp-foot">
      <div className="sp-foot-act">{children}</div>
      <div className="sp-foot-links">
        {took && <span className="sp-quiet lw-num">took {took}</span>}
        <NavLink className="lw-link" href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Open the run</NavLink>
        {d.caseId && nav.openCase && <NavLink className="lw-link" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>Open the problem</NavLink>}
        {d.received.href && <a className="lw-link" href={d.received.href}>Open its session</a>}
        {earlier && earlier.length > 0 && <button type="button" className="lw-link" aria-expanded={more} onClick={() => setMore((v) => !v)}>{earlier.length} earlier {earlier.length === 1 ? "run" : "runs"} of this problem</button>}
      </div>
      {more && earlier && (
        <ul className="sp-earlier">
          {earlier.map((e) => (
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
