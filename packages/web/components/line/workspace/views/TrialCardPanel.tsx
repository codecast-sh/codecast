"use client";
// A trial card inside the line app (line-workspace.md LW1): the Inbox opens a
// card here, beside its rows, so the header, the nav and the way back stay.
// It draws the same card body /trial does (TrialCardBody).
import { X } from "lucide-react";
import type { TrialCardRow } from "../../../../hooks/useSyncTrial";
import { TrialCardBody, trialRecord } from "../../../trial/TrialCardBody";
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
        <TrialCardBody card={c} now={now} />
      </div>
    </aside>
  );
}
