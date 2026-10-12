"use client";
// A trial card inside the line app (line-workspace.md LW1): the Inbox opens a
// card here, beside its rows, so the header, the nav and the way back stay.
// A card its station posted draws as that session's decision (DecisionDocument,
// with Discuss to the session); an older one draws the card body /trial does.
import { X } from "lucide-react";
import type { TrialCardRow } from "../../../../hooks/useSyncTrial";
import { TrialCardBody, trialRecord } from "../../../trial/TrialCardBody";
import { DecisionDocument } from "../../../decisions/DecisionDocument";
import { ageShort } from "../../../../lib/lineFlow";

export function TrialCardPanel({ card: c, now, onClose, onProblem, onRun }: {
  card: TrialCardRow;
  now: number;
  onClose: () => void;
  onProblem: () => void;
  onRun: () => void;
}) {
  const waiting = c.status === "waiting";
  const record = trialRecord(c, now);

  return (
    <aside className="lwt-panel" aria-label={`Trial card ${c.short_id}`} data-line-trial-panel={c.short_id}>
      <header className="lwt-panel-h">
        <b className="lwt-panel-ref">{c.short_id}</b>
        <button type="button" className="lw-chip" onClick={onProblem} data-line-trial-problem>{c.task_short_id}</button>
        <button type="button" className="lw-chip" onClick={onRun} data-line-trial-run>run</button>
        <span className="lwt-panel-state" data-state={c.status}>{waiting ? "waiting" : record}</span>
        <span className="lw-num lwt-panel-age">{ageShort(now - c.created_at)}</span>
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" onClick={onClose} aria-label="Close card (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>
      </header>
      <div className="lwt-panel-body decision-doc">
        {/* A card its station posted is that session's own decision: its page, its answers and the discussion with it. */}
        {c.decision?.short_id ? <DecisionDocument id={c.decision.short_id} /> : <TrialCardBody card={c} now={now} />}
      </div>
    </aside>
  );
}
