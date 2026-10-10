"use client";
// One decision a step made (line-workspace.md LW3), ported from Studio's
// decision card: what it was handed on the left, an arrow, what it decided on
// the right; opening it shows its reasoning in its own words, the fields it
// reported and where the run went next. DecisionList is a step's decisions,
// one card per case (its newest run, "and 2 earlier runs" under it), filtered
// by outcome; compact, it is the chat's one-line rows.
import { memo, useMemo, useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { LineStep, StepDecision } from "../../../lib/line/lineModel";
import { LINE_ACTIONS } from "./actionSlots";
import { decisionKey, decisionSaid, decisionsByCase, tallyDecisions, type CaseDecisions } from "../../../lib/line/lineModel";
import { DecisionTag, NavLink, dayWords, durationWords, outcomeWords, useLineNav } from "./parts";

/** A reported field's value in words. */
function fieldText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x).map(fieldText).join(" · ") : fieldText(x))).join(", ");
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${fieldText(x)}`).join("; ");
}

/** The fields a step reported, minus the outcome its tag already says. */
export function ResultFields({ result, cap = 600 }: { result: Record<string, unknown> | null; cap?: number }) {
  const rows = useMemo(() => Object.entries(result ?? {})
    .filter(([k, v]) => k !== "outcome" && k !== "summary" && v !== "" && v != null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => {
      const t = fieldText(v);
      return [k.replace(/_/g, " "), t.length > cap ? `${t.slice(0, cap)}…` : t] as const;
    }), [result, cap]);
  if (!rows.length) return null;
  return <dl className="lw-fields">{rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export type DecisionCardProps = {
  decision: StepDecision;
  step: LineStep;
  open?: boolean;
  onToggle?: () => void;
  /** The run the workspace has selected: its card is marked. */
  highlighted?: boolean;
};

export const DecisionCard = memo(function DecisionCard({ decision: d, step, open, onToggle, highlighted }: DecisionCardProps) {
  const nav = useLineNav();
  const Label = LINE_ACTIONS.Label;
  const took = durationWords(d.durationMs);
  return (
    <div className="lw-dcard" data-hl={highlighted ? "" : undefined} data-line-decision={d.id} data-open={open ? "" : undefined}>
      <div className="lw-dcard-in" onClick={onToggle}>
        <div className="lw-lbl">Handed{d.received.fromLabel ? ` by ${d.received.fromLabel}` : " the problem"}{d.caseRef ? ` · ${d.caseRef}` : ""}</div>
        <div className="lw-dcard-case">{d.caseTitle}</div>
        {d.received.said && <div className="lw-dcard-got">{d.received.summary}</div>}
      </div>
      <div className="lw-dcard-arr" aria-hidden onClick={onToggle}><ArrowRight className="w-3.5 h-3.5" /></div>
      <div
        className="lw-dcard-out"
        role="button"
        tabIndex={0}
        aria-expanded={!!open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle?.(); } }}
      >
        <div className="lw-lbl"><DecisionTag d={d} />{took && <span>{took}</span>}</div>
        <div className="lw-dcard-said">{decisionSaid(d)}</div>
      </div>
      {open && (
        <div className="lw-dcard-more">
          {d.reasoning && <p className="lw-reason">{d.reasoning}</p>}
          <ResultFields result={d.decided.result} />
          <div className="lw-dfoot">
            {d.decided.toLabel && (
              <span>Then <b style={{ color: "var(--lw-ink-2)" }}>{d.decided.toLabel}</b>{d.decided.toWords ? ` (${d.decided.toWords})` : ""}</span>
            )}
            <NavLink href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Open the run</NavLink>
            {d.received.href && <a href={d.received.href}>Its session</a>}
            <span className="lw-spacer" />
            {d.at && <span>{dayWords(d.at)}</span>}
          </div>
        </div>
      )}
      {(d.label || (Label && decisionKey(d) !== "cut off")) && (
        <div className="lw-dfoot" style={{ gridColumn: "1 / -1", margin: 0, padding: "6px 14px 8px", borderTop: "1px solid var(--lw-rule-2)" }}>
          {d.label && (
            <span className="lw-labelmark" data-verdict={d.label.verdict} title={d.label.note ?? undefined}>
              {d.label.verdict === "right" ? "Right" : "Wrong"}{d.label.byName && !d.label.mine ? `, says ${d.label.byName}` : ""}
            </span>
          )}
          {d.label?.note && <span style={{ fontStyle: "italic", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label.note}</span>}
          <span className="lw-spacer" />
          {Label && decisionKey(d) !== "cut off" && <Label step={step} decision={d} />}
        </div>
      )}
    </div>
  );
});

export type DecisionListProps = {
  step: LineStep;
  decisions?: ReadonlyArray<StepDecision>;
  /** Rows instead of cards: one line each, a click opens the decision. */
  compact?: boolean;
  limit?: number | null;
  /** Only this outcome. */
  outcome?: string | null;
  /** The run the workspace has selected. */
  selectedRun?: string | null;
  /** Compact rows: what a click on a row does. */
  onOpen?: (d: StepDecision) => void;
};

/** A step's decisions, newest first, with a chip per outcome to narrow them. */
export function DecisionList({ step, decisions = step.decisions, compact, limit, outcome, selectedRun, onOpen }: DecisionListProps) {
  const [filter, setFilter] = useState<string | null>(outcome ?? null);
  const [openId, setOpenId] = useState<string | null>(() => (selectedRun ? decisions.find((d) => d.runId === selectedRun)?.id ?? null : null));
  // The step's own tally when it lists all of them; a subset is counted the same way.
  const tally = useMemo(() => (decisions === step.decisions ? step.tally : tallyDecisions(decisions)), [decisions, step]);
  const cases = useMemo(() => {
    const all = decisionsByCase(decisions.filter((d) => !filter || decisionKey(d) === filter));
    return limit ? all.slice(0, limit) : all;
  }, [decisions, filter, limit]);
  const caseCount = useMemo(() => (limit ? decisionsByCase(decisions).length : cases.length), [decisions, limit, cases]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const unfold = (key: string) => setUnfolded((u) => {
    const next = new Set(u);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  if (!decisions.length) {
    return <div className="lw-empty" data-line-decisions-empty><b>No decisions yet</b>No run has reached {step.label} on this graph.</div>;
  }
  if (compact) {
    return (
      <div className="lw-drows" data-line-widget="decisions">
        {cases.map(({ key, latest: d, earlier }) => (
          <button key={key} type="button" className="lw-drow" onClick={() => onOpen?.(d)} data-line-decision={d.id}>
            <span><DecisionTag d={d} /></span>
            <span className="lw-drow-t">{decisionSaid(d)}</span>
            <span className="lw-drow-m">{d.caseRef ?? dayWords(d.at)}{earlier.length > 0 && <small title={`${earlier.length} earlier ${earlier.length === 1 ? "run" : "runs"} on this case`}> +{earlier.length}</small>}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div data-line-widget="decisions">
      {tally.rows.length > 1 && (
        <div className="lw-filters" role="group" aria-label="Narrow by outcome">
          <button type="button" className="lw-filter" aria-pressed={!filter} onClick={() => setFilter(null)}>All<span>{decisions.length}</span></button>
          {tally.rows.map((r) => (
            <button key={r.key} type="button" className="lw-filter" aria-pressed={filter === r.key} onClick={() => setFilter(filter === r.key ? null : r.key)}>{outcomeWords(r.key)}<span>{r.n}</span></button>
          ))}
        </div>
      )}
      {cases.map((c) => (
        <CaseCards
          key={c.key}
          c={c}
          step={step}
          openId={openId}
          setOpenId={setOpenId}
          selectedRun={selectedRun ?? null}
          unfolded={unfolded.has(c.key) || (!!selectedRun && c.earlier.some((d) => d.runId === selectedRun))}
          onUnfold={() => unfold(c.key)}
        />
      ))}
      {limit && caseCount > cases.length && !filter && <p className="lw-dfoot">{caseCount - cases.length} older cases not shown.</p>}
    </div>
  );
}

/** One case: its newest decision as a card, and its earlier runs one click away. */
function CaseCards({ c, step, openId, setOpenId, selectedRun, unfolded, onUnfold }: {
  c: CaseDecisions;
  step: DecisionListProps["step"];
  openId: string | null;
  setOpenId: (id: string | null) => void;
  selectedRun: string | null;
  unfolded: boolean;
  onUnfold: () => void;
}) {
  const card = (d: CaseDecisions["latest"]) => (
    <DecisionCard key={d.id} decision={d} step={step} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} highlighted={!!selectedRun && d.runId === selectedRun} />
  );
  return (
    <div className="lw-dcase" data-line-case={c.key}>
      {card(c.latest)}
      {c.earlier.length > 0 && (
        <>
          <button type="button" className="lw-disclose lw-dcase-more" aria-expanded={unfolded} onClick={onUnfold}>
            <ChevronRight className="lw-disclose-chev" aria-hidden />
            {c.earlier.length} earlier {c.earlier.length === 1 ? "run" : "runs"} on this case
          </button>
          {unfolded && <div className="lw-dcase-earlier">{c.earlier.map(card)}</div>}
        </>
      )}
    </div>
  );
}
