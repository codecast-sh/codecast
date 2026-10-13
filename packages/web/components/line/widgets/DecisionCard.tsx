"use client";
// One decision a step made (line-workspace.md LW3) and a step's decisions:
// the full list is StepRuns' run rows; compact, the chat's one-line rows. The
// words a decision found and the fields it reported, which every surface reads.
import { memo, useMemo, useState } from "react";
import type { LineStep, StepDecision } from "../../../lib/line/lineModel";
import { decisionSaid, findingNeverShipped } from "../../../lib/line/lineModel";
import { stepRunGroups } from "../../../lib/line/stepRuns";
import { backTimes, DecisionTag, FoundWords, dayWords } from "./parts";
import { StepRunRow, StepRuns } from "./StepRuns";

/** What a decision found, in its own words (decisionSaid), tagged when it names a guard its close never shipped. */
export function DecisionSaid({ d }: { d: Pick<StepDecision, "reasoning" | "decided" | "closed"> }) {
  const said = decisionSaid(d);
  return <FoundWords text={said} unshipped={findingNeverShipped(d, said)} />;
}

/** A reported field's value in words. */
function fieldText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x).map(fieldText).join(" · ") : fieldText(x))).join(", ");
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${fieldText(x)}`).join("; ");
}

/** The report keys a reader knows by another name: a dissolution's `kind` is why it closed, `into` what it was folded into. */
const FIELD_NAMES: Record<string, string> = { kind: "Why", into: "Folded into", residue: "Left over" };

/** A known field's value in words, or null to leave the row out: a bare commit hash or a zero says nothing. */
function fieldValue(k: string, v: unknown): string | null {
  const t = fieldText(v);
  if (k === "kind") return t.replace(/_/g, " ");
  if (k === "into") return /^[0-9a-f]{7,40}$/i.test(t.trim()) ? null : /^C\d+$/.test(t.trim()) ? `cause ${t.trim()}` : t;
  if (k === "residue") return t === "0" ? null : t;
  return t;
}

/** The fields a step reported, minus the outcome its tag already says, under the names a reader knows. */
export function ResultFields({ result, cap = 600 }: { result: Record<string, unknown> | null; cap?: number }) {
  const rows = useMemo(() => Object.entries(result ?? {})
    .filter(([k, v]) => k !== "outcome" && k !== "summary" && v !== "" && v != null && !(Array.isArray(v) && v.length === 0))
    .flatMap(([k, v]) => {
      const t = fieldValue(k, v);
      if (!t) return [];
      const name = FIELD_NAMES[k] ?? k.replace(/_/g, " ");
      return [[name.charAt(0).toUpperCase() + name.slice(1), t.length > cap ? `${t.slice(0, cap)}…` : t] as const];
    }), [result, cap]);
  if (!rows.length) return null;
  return <dl className="lw-fields">{rows.map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export type DecisionCardProps = {
  decision: StepDecision;
  step: LineStep;
  open?: boolean;
  onToggle?: () => void;
  /** The run the workspace has selected: its row is marked. */
  highlighted?: boolean;
};

/** One run at a step on its own (a chat's decision widget): the problem, then the run's row. */
export const DecisionCard = memo(function DecisionCard({ decision: d, step, open, onToggle, highlighted }: DecisionCardProps) {
  const [shut, setShut] = useState(!open);
  return (
    <div className="sr-list" data-line-widget="decision">
      <div className="sr-group">
        <div className="sr-prob">
          {d.caseRef && <span className="sr-ref">{d.caseRef}</span>}
          <span className="sr-title" title={d.caseTitle}>{d.caseTitle}</span>
        </div>
        <StepRunRow d={d} step={step} open={onToggle ? !!open : !shut} onToggle={onToggle ?? (() => setShut((v) => !v))} hl={highlighted} />
      </div>
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

/** A step's decisions, newest first: the drawer's run rows (StepRuns), or compact, the chat's one-line rows, one per case. */
export function DecisionList({ step, decisions = step.decisions, compact, limit, outcome, selectedRun, onOpen }: DecisionListProps) {
  if (!compact) return <StepRuns step={step} decisions={decisions} outcome={outcome} limit={limit} selectedRun={selectedRun} />;
  return <CompactDecisions decisions={decisions} step={step} limit={limit} outcome={outcome} onOpen={onOpen} />;
}

function CompactDecisions({ step, decisions, limit, outcome, onOpen }: { step: LineStep; decisions: ReadonlyArray<StepDecision>; limit?: number | null; outcome?: string | null; onOpen?: (d: StepDecision) => void }) {
  const cases = useMemo(() => {
    const all = stepRunGroups(decisions, outcome ?? null);
    return limit ? all.slice(0, limit) : all;
  }, [decisions, outcome, limit]);
  if (!decisions.length) return <div className="lw-empty" data-line-decisions-empty><b>No runs yet</b>Nothing has reached {step.label}.</div>;
  return (
    <div className="lw-drows" data-line-widget="decisions">
      {cases.map(({ key, latest: d, earlier, earlierBack, earlierBackTotal }) => (
        <button key={key} type="button" className="lw-drow" onClick={() => onOpen?.(d)} data-line-decision={d.id}>
          <span><DecisionTag d={d} /></span>
          <span className="lw-drow-t"><DecisionSaid d={d} /></span>
          <span className="lw-drow-m">{d.caseRef ?? dayWords(d.at)}{earlier.length > 0 && <small title={`${earlier.length} earlier ${earlier.length === 1 ? "run" : "runs"} on this case`}> +{earlier.length}</small>}{earlierBack > 0 && <small className="lw-route-back" title={`${earlierBack} of the earlier runs closed it and it came back`}> came back {backTimes(earlierBackTotal)}</small>}</span>
        </button>
      ))}
    </div>
  );
}
