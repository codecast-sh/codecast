"use client";
// One decision a step made (line-workspace.md LW3), ported from Studio's
// decision card: what it was handed on the left, an arrow, what it decided on
// the right; opening it shows its reasoning in its own words, the fields it
// reported and where the run went next. DecisionList is a step's decisions,
// filtered by outcome; compact, it is the chat's one-line rows.
import { memo, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { LineStep, StepDecision } from "../../../lib/line/lineModel";
import { LINE_ACTIONS } from "./actionSlots";
import { NavLink, OutcomeTag, dayWords, durationWords, outcomeWords, useLineNav } from "./parts";

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
        {d.received.from && <div className="lw-dcard-got">{d.received.summary}</div>}
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
        <div className="lw-lbl"><OutcomeTag outcome={d.decided.outcome} status={d.status} />{took && <span>{took}</span>}</div>
        <div className="lw-dcard-said">{d.decided.words}</div>
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
      {(d.label || Label) && (
        <div className="lw-dfoot" style={{ gridColumn: "1 / -1", margin: 0, padding: "6px 14px 8px", borderTop: "1px solid var(--lw-rule-2)" }}>
          {d.label && (
            <span className="lw-labelmark" data-verdict={d.label.verdict} title={d.label.note ?? undefined}>
              {d.label.verdict === "right" ? "Right" : "Wrong"}{d.label.byName && !d.label.mine ? `, says ${d.label.byName}` : ""}
            </span>
          )}
          {d.label?.note && <span style={{ fontStyle: "italic", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label.note}</span>}
          <span className="lw-spacer" />
          {Label && <Label step={step} decision={d} />}
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

const outcomeKey = (d: StepDecision) => outcomeWords(d.decided.outcome, d.status);

/** A step's decisions, newest first, with a chip per outcome to narrow them. */
export function DecisionList({ step, decisions = step.decisions, compact, limit, outcome, selectedRun, onOpen }: DecisionListProps) {
  const [filter, setFilter] = useState<string | null>(outcome ?? null);
  const [openId, setOpenId] = useState<string | null>(() => (selectedRun ? decisions.find((d) => d.runId === selectedRun)?.id ?? null : null));
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of decisions) m.set(outcomeKey(d), (m.get(outcomeKey(d)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [decisions]);
  const shown = useMemo(() => {
    const f = decisions.filter((d) => !filter || outcomeKey(d) === filter);
    return limit ? f.slice(0, limit) : f;
  }, [decisions, filter, limit]);

  if (!decisions.length) {
    return <div className="lw-empty" data-line-decisions-empty><b>No decisions yet</b>No run has reached {step.label} on this graph.</div>;
  }
  if (compact) {
    return (
      <div className="lw-drows" data-line-widget="decisions">
        {shown.map((d) => (
          <button key={d.id} type="button" className="lw-drow" onClick={() => onOpen?.(d)} data-line-decision={d.id}>
            <span><OutcomeTag outcome={d.decided.outcome} status={d.status} /></span>
            <span className="lw-drow-t">{d.decided.words}</span>
            <span className="lw-drow-m">{d.caseRef ?? dayWords(d.at)}</span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div data-line-widget="decisions">
      {counts.length > 1 && (
        <div className="lw-filters" role="group" aria-label="Narrow by outcome">
          <button type="button" className="lw-filter" aria-pressed={!filter} onClick={() => setFilter(null)}>All<span>{decisions.length}</span></button>
          {counts.map(([o, n]) => (
            <button key={o} type="button" className="lw-filter" aria-pressed={filter === o} onClick={() => setFilter(filter === o ? null : o)}>{o}<span>{n}</span></button>
          ))}
        </div>
      )}
      {shown.map((d) => (
        <DecisionCard
          key={d.id}
          decision={d}
          step={step}
          open={openId === d.id}
          onToggle={() => setOpenId(openId === d.id ? null : d.id)}
          highlighted={!!selectedRun && d.runId === selectedRun}
        />
      ))}
      {limit && decisions.length > shown.length && !filter && <p className="lw-dfoot">{decisions.length - shown.length} older decisions not shown.</p>}
    </div>
  );
}
