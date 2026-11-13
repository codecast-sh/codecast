"use client";
// A step's runs (line-workspace.md LW3): one row per problem, its newest run
// on top and the earlier runs one click under it. A row names the problem and
// where it came from, then what the step put out, its outcome, where the run
// went next and how long it took. Opening a row shows the step's own words,
// the fields it reported and the links to the run, the problem and the session.
import { memo, useMemo, useState } from "react";
import { ArrowRight, ChevronRight, CornerDownRight } from "lucide-react";
import type { CaseDecisions, LineModel, LineStep, StepDecision, StepKind } from "../../../lib/line/lineModel";
import { closeBackWords, decisionKey, tallyDecisions, tallyKey } from "../../../lib/line/lineModel";
import { ageShort } from "../../../lib/lineFlow";
import { endArrivals, runNext, sourceChipWords, stepRunGroups, type ProblemSource } from "../../../lib/line/stepRuns";
import { decisionOutput, isAnswerKey, visitOutputWords } from "../../../lib/line/visitOutput";
import { LINE_ACTIONS } from "./actionSlots";
import { ResultFields } from "./DecisionCard";
import { VisitOutputView } from "./VisitOutput";
import { DecisionTag, NavLink, durationWords, outcomeWords, useLineNav } from "./parts";
import "./stepRuns.css";

export type StepRunsProps = {
  step: LineStep;
  decisions?: ReadonlyArray<StepDecision>;
  /** Each problem's source, by task id; rows show none without it. */
  sources?: ReadonlyMap<string, ProblemSource> | null;
  /** The run the workspace has selected: its row is open and marked. */
  selectedRun?: string | null;
  outcome?: string | null;
  limit?: number | null;
  now?: number;
  /** The model the step is in: an end step's rows read the decision that sent each run there. */
  model?: Pick<LineModel, "steps"> | null;
};

export function StepRuns({ step, decisions = step.decisions, sources, selectedRun, outcome, limit, now = Date.now(), model }: StepRunsProps) {
  const [filter, setFilter] = useState<string | null>(outcome ?? null);
  const [openId, setOpenId] = useState<string | null>(() => (selectedRun ? decisions.find((d) => d.runId === selectedRun)?.id ?? null : null));
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const tally = useMemo(() => (decisions === step.decisions ? step.tally : tallyDecisions(decisions)), [decisions, step]);
  const all = useMemo(() => stepRunGroups(decisions, filter), [decisions, filter]);
  const groups = limit ? all.slice(0, limit) : all;
  const arrivals = useMemo(() => (model ? endArrivals(step, model.steps) : null), [model, step]);
  // An end step's rows show what the step that sent the run there produced, read as that step's kind.
  const kindOf = useMemo(() => (model ? (id: string | null) => (id ? (model.steps[id] as { kind?: StepKind } | undefined)?.kind ?? null : null) : null), [model]);

  if (!decisions.length) return <div className="lw-empty" data-line-decisions-empty><b>No runs yet</b>Nothing has reached {step.label}.</div>;
  const toggle = (id: string) => setOpenId((o) => (o === id ? null : id));
  const unfold = (key: string) => setUnfolded((u) => {
    const next = new Set(u);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <div className="sr" data-line-widget="decisions">
      {tally.rows.length > 1 && (
        <div className="sr-filters" role="group" aria-label="Narrow by outcome">
          <button type="button" className="lw-filter" aria-pressed={!filter} onClick={() => setFilter(null)}>All<span>{decisions.length}</span></button>
          {tally.rows.map((r) => (
            <button key={r.key} type="button" className="lw-filter" aria-pressed={filter === r.key} onClick={() => setFilter(filter === r.key ? null : r.key)}>{filterWords(r.key, decisions)}<span>{r.n}</span></button>
          ))}
        </div>
      )}
      {all.length > 0 && all.length < decisions.length && <div className="sr-sum lw-num">{filter ? tally.rows.find((r) => r.key === filter)?.n ?? decisions.length : decisions.length} runs · {all.length} problems</div>}
      <div className="sr-list" data-line-runs={groups.length} onKeyDown={moveFocus}>
        {groups.map((g) => {
          const shown = unfolded.has(g.key) || (!!selectedRun && g.earlier.some((d) => d.runId === selectedRun));
          return (
            <StepRunGroup
              key={g.key}
              g={g}
              step={step}
              source={g.latest.caseId ? sources?.get(g.latest.caseId) ?? null : null}
              openId={openId}
              onToggle={toggle}
              unfolded={shown}
              onUnfold={() => unfold(g.key)}
              selectedRun={selectedRun ?? null}
              now={now}
              arrivals={arrivals}
              kindOf={kindOf}
            />
          );
        })}
      </div>
      {limit && all.length > groups.length && <div className="sr-more">{all.length - groups.length} more problems</div>}
    </div>
  );
}

/** An outcome filter's name: a gate's answer key reads as the choice its runs took. */
function filterWords(key: string, decisions: ReadonlyArray<StepDecision>): string {
  if (!isAnswerKey(key)) return outcomeWords(key);
  return decisions.find((d) => tallyKey(d) === key && d.decided.toWords)?.decided.toWords ?? key;
}

/** Up and down move between run rows. */
function moveFocus(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(".sr-line")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

/** One problem: its title, source and newest run, then its earlier runs when unfolded. */
const StepRunGroup = memo(function StepRunGroup({ g, step, source, openId, onToggle, unfolded, onUnfold, selectedRun, now, arrivals, kindOf }: {
  g: CaseDecisions; step: LineStep; source: ProblemSource | null; openId: string | null; onToggle: (id: string) => void;
  unfolded: boolean; onUnfold: () => void; selectedRun: string | null; now: number; arrivals: ReadonlyMap<string, StepDecision> | null;
  kindOf: ((id: string | null) => StepKind | null) | null;
}) {
  const d = g.latest;
  const nav = useLineNav();
  const n = g.earlier.length + 1;
  return (
    <div className="sr-group" data-line-case={g.key} data-hl={selectedRun && [d, ...g.earlier].some((x) => x.runId === selectedRun) ? "" : undefined}>
      <div className="sr-prob">
        {d.caseRef && (nav.openCase && d.caseId
          ? <NavLink className="sr-ref" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)} title="Open the problem">{d.caseRef}</NavLink>
          : <span className="sr-ref">{d.caseRef}</span>)}
        <span className="sr-title" title={d.caseTitle}>{d.caseTitle}</span>
        {source && (
          <span className="sr-src" title={`${source.findings} ${source.findings === 1 ? "finding" : "findings"}${source.others ? `, ${source.others} more ${source.others === 1 ? "source" : "sources"}` : ""}`}>
            {sourceChipWords(source)}{source.others > 0 && <small>+{source.others}</small>}
          </span>
        )}
        {n > 1 ? (
          <button type="button" className="sr-count" aria-expanded={unfolded} onClick={onUnfold} title={`${n} runs on this problem`}>
            <ChevronRight aria-hidden />{n} runs{g.earlierBack > 0 && <i title={`${g.earlierBack} earlier ${g.earlierBack === 1 ? "close" : "closes"} came back`} />}
          </button>
        ) : <span className="sr-count" data-one="" aria-hidden />}
      </div>
      <StepRunRow d={d} step={step} open={openId === d.id} onToggle={() => onToggle(d.id)} hl={d.runId === selectedRun} now={now} arrival={arrivals?.get(d.id) ?? null} kindOf={kindOf} />
      {unfolded && g.earlier.map((e) => (
        <StepRunRow key={e.id} d={e} step={step} open={openId === e.id} onToggle={() => onToggle(e.id)} hl={e.runId === selectedRun} now={now} earlier arrival={arrivals?.get(e.id) ?? null} kindOf={kindOf} />
      ))}
    </div>
  );
});

/** One run at this step: outcome, what it put out, where it went next, how long, when. */
export const StepRunRow = memo(function StepRunRow({ d, step, open, onToggle, hl, now = Date.now(), earlier, arrival, kindOf }: {
  d: StepDecision; step: LineStep; open: boolean; onToggle?: () => void; hl?: boolean; now?: number; earlier?: boolean;
  /** At an end step, the decision that sent the run here: the row shows its outcome and what it produced. */
  arrival?: StepDecision | null;
  /** A step's kind by id, so an arrival's output reads as the step that produced it. */
  kindOf?: ((id: string | null) => StepKind | null) | null;
}) {
  const Label = LINE_ACTIONS.Label;
  // At an end, the run's conclusion is the step before's: its outcome, what it produced, how long it took.
  const shown = arrival ?? d;
  const out = decisionOutput(arrival ? kindOf?.(d.received.from) ?? "script" : step.kind, shown);
  const next = arrival ? null : runNext(d);
  const took = durationWords(shown.durationMs);
  const key = decisionKey(d);
  // A step that decided nothing of its own shows no outcome word: what it produced and where the run went say it.
  const shownKey = decisionKey(shown);
  const tagged = (shownKey !== "handed on" && !(isAnswerKey(shownKey) && out?.kind === "choice")) || !!shown.closed;
  // Chips ride the first line; a step's own words take the row's full width under it, unless nothing else is on the first line.
  const inline = !!out && (out.kind !== "text" || !tagged);
  const labelable = !!Label && key !== "cut off";
  const back = shown.closed && !shown.closed.held ? shown.closed : null;
  // Where it went: the next step; a run that stopped here ended, unless it was cut off or failed.
  const stopped = d.status === "failed" || key === "cut off";
  return (
    <div className="sr-run" data-open={open ? "" : undefined} data-hl={hl ? "" : undefined} data-earlier={earlier ? "" : undefined} data-label-host="" data-line-decision={d.id}>
      <div
        className="sr-line"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle?.(); } }}
      >
        <span className="sr-tag">
          {earlier && <CornerDownRight className="sr-earlier" aria-hidden />}
          {tagged && <DecisionTag d={shown} backTag={false} />}
          {inline && <VisitOutputView out={out} className="sr-vo" />}
          {back && <span className="sr-back" title={`${closeBackWords(back)}: the close was likely wrong`}>came back {back.count}x</span>}
          {!back && shown.closed?.foldInto && <span className="sr-fold" title={shown.closed.folded ?? undefined}>folded into {shown.closed.foldInto}</span>}
        </span>
        <span className="sr-out" data-none={out && !inline ? undefined : ""}>{out && !inline && <VisitOutputView out={out} />}</span>
        <span className="sr-next" data-end={next ? undefined : ""} title={arrival ? `Sent here by ${d.received.fromLabel ?? "the step before"}` : next ? `Then ${next}${d.decided.toWords && d.decided.toWords !== "next" ? ` (${d.decided.toWords})` : ""}` : undefined}>{arrival ? <span>from {d.received.fromLabel ?? "before"}</span> : next ? <><ArrowRight aria-hidden /><span>{next}</span></> : d.status === "live" || d.status === "waiting" ? "" : stopped ? "failed" : "ended"}</span>
        <span className="sr-num sr-dur">{took ?? ""}</span>
        <span className="sr-num sr-age">{d.at ? ageShort(now - d.at) : ""}</span>
        <span className="sr-lab">{labelable && <Label step={step} decision={d} />}</span>
      </div>
      {open && <StepRunDetail d={shown} shown={visitOutputWords(out)} />}
    </div>
  );
});

/** An open run: what it was given, its own words, its fields, and where to go from here. */
function StepRunDetail({ d, shown }: { d: StepDecision; shown: string | null }) {
  const nav = useLineNav();
  return (
    <div className="sr-detail">
      {d.received.said && (
        <div className="sr-kv"><span>From {d.received.fromLabel ?? "the step before"}</span><p>{d.received.fromLabel ? d.received.summary.replace(`${d.received.fromLabel}: `, "") : d.received.summary}</p></div>
      )}
      {d.reasoning && d.reasoning.trim() !== shown && <div className="sr-kv"><span>It said</span><p className="sr-prose">{d.reasoning}</p></div>}
      <ResultFields result={d.decided.result} />
      {d.label?.note && <div className="sr-kv" data-verdict={d.label.verdict}><span>{d.label.mine ? "Your note" : `${d.label.byName ?? "Note"}`}</span><p>{d.label.note}</p></div>}
      <div className="sr-links">
        <NavLink className="lw-act" href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Open the run</NavLink>
        {d.caseId && nav.openCase && <NavLink className="lw-act" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>The problem</NavLink>}
        {d.received.href && <a className="lw-act" href={d.received.href}>Its session</a>}
      </div>
    </div>
  );
}
