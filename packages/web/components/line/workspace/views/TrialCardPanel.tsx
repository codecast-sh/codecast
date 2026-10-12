"use client";
// A trial card no station posted as a session decision, inside the line app
// (line-workspace.md LW1): the Inbox and a problem open it here, beside their
// rows, so the header, the nav and the way back stay. A card with a decision
// opens as LineDecision instead, where the answer is given beside the session
// that asked. This one has no session to talk to, so it is read, not answered:
// the card body shows what the run built and proved, and the one control is
// the run itself, until the card is asked again as a decision.
import { X } from "lucide-react";
import { useMemo } from "react";
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
  // Read, never answered here: the body sees a card that waits on nobody, so its answer keys stay off,
  // and the panel hides the answer rows it would draw (trialCards.css .lwt-readonly).
  const readOnly = useMemo(() => (waiting ? { ...c, status: "answered" as const, answer: undefined } : c), [c, waiting]);

  return (
    <aside className="lwt-panel" aria-label={`Trial card ${c.short_id}`} data-line-trial-panel={c.short_id}>
      <header className="lwt-panel-h">
        <b className="lwt-panel-ref">{c.short_id}</b>
        <button type="button" className="lw-chip" onClick={onProblem} data-line-trial-problem>{c.task_short_id}</button>
        <span className="lwt-panel-state" data-state={c.status}>{waiting ? "waiting" : record}</span>
        <span className="lw-num lwt-panel-age">{ageShort(now - c.created_at)}</span>
        <span className="lw-spacer" />
        <button type="button" className="lw-iconbtn" onClick={onClose} aria-label="Close card (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>
      </header>
      {waiting && (
        <div className="lwt-ask-run" data-line-trial-no-session>
          <span className="lwt-ask-run-t">No session holds this card</span>
          <button type="button" className="lw-act" data-primary="" onClick={onRun} data-line-trial-run title="The run that built it, at the card it stopped on">Open the run</button>
        </div>
      )}
      <div className="lwt-panel-body decision-doc lwt-readonly">
        <TrialCardBody card={readOnly} now={now} />
      </div>
    </aside>
  );
}
