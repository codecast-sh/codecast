"use client";
// A trial card no station posted as a session decision, inside the line app
// (line-workspace.md LW1): the Inbox lists it as a proposal and a problem opens
// it here, beside their rows, so the header, the nav and the way back stay. It
// is drawn on LineDecision's page (one decide page in the line): the problem
// and project in the head, what the change does and what it measured as the
// sweet spot, and the card's long case folded under Full proposal. No session
// asked it, so nothing here answers: the one act asks its run again (Re-ask),
// which has its agent present it as a decision.
import { X } from "lucide-react";
import { useMemo } from "react";
import Link from "next/link";
import { useTrialHref, type TrialCardRow } from "../../../../hooks/useSyncTrial";
import { useInboxStore } from "../../../../store/inboxStore";
import { TrialCardBody } from "../../../trial/TrialCardBody";
import { TrialEvidenceBand } from "../../widgets/TrialEvidenceBand";
import { ReaskNotice } from "../../widgets/ReaskRun";
import { trialAsk } from "../../../../lib/line/lineInbox";
import { ageShort } from "../../../../lib/lineFlow";
import "../../widgets/lineDecision.css";
import "./trialCardPanel.css";

export function TrialCardPanel({ card: c, now, source, onClose, onProblem, onRun }: {
  card: TrialCardRow;
  now: number;
  /** The problem's source in chip words, when the surface knows it. */
  source?: string | null;
  /** Close it, where a surface opened it over something else; absent where it is the reader's own content. */
  onClose?: () => void;
  onProblem: () => void;
  onRun: () => void;
}) {
  const waiting = c.status === "waiting";
  const project = useInboxStore((s) => (s.projects as Record<string, { title?: string }> | undefined)?.[c.project_id]?.title ?? null);
  // Read, never answered here: the body sees a card that waits on nobody, so its answer keys stay off,
  // and the panel hides the answer rows it would draw (trialCardPanel.css .lwt-readonly).
  const readOnly = useMemo(() => (waiting ? { ...c, status: "answered" as const, answer: undefined } : c), [c, waiting]);
  const ask = trialAsk(c);
  const trialLink = useTrialHref(c.project_id, c.short_id);

  return (
    <article className="ld decision-doc" aria-label={`Proposal ${c.short_id}`} data-line-trial-panel={c.short_id} data-trial="">
      <header className="ld-head">
        <button type="button" className="ld-ref" onClick={onProblem} data-line-trial-problem>{c.task_short_id}</button>
        <span className="ld-title" title={c.task_title}>{c.task_title}</span>
        {source && <span className="lw-srcchip">{source}</span>}
        {project && <span className="ld-project">{project}</span>}
        {!/\btrial\b/i.test(project ?? "") && <Link className="ld-trial" href={trialLink} title="A trial run: nothing it proposes ships. Open the trial" data-line-trial-link>Trial</Link>}
        <span className="ld-spacer" />
        {onClose && <button type="button" className="ld-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><X className="w-4 h-4" /></button>}
      </header>
      <div className="ld-sub">
        <span data-tone={waiting ? "wait" : "done"}>{waiting ? (c.stale_gate ? "step removed" : "no session asked") : c.status}</span>
        <span>proposed {ageShort(now - c.created_at)} ago</span>
        <button type="button" className="ld-run" onClick={onRun} data-line-trial-run title="The run that built it, at the card it stopped on">the run</button>
        <span className="ld-id">{c.short_id}</span>
      </div>
      <div className="ld-grid" data-solo="">
        <div className="ld-main">
          <div className="ld-sweet">
            <h1 className="ld-question" data-long={ask.length > 140 ? "" : undefined}>{ask}</h1>
            <TrialEvidenceBand card={c} />
            {waiting && (
              <div className="ld-nosession" data-line-trial-no-session>
                <ReaskNotice taskId={c.task_id} task={c.task_short_id} reason={c.stale_gate ? "Its step left the line, so an answer has nowhere to go." : "No session asked this, so nobody can take an answer."} />
              </div>
            )}
          </div>
          <details className="ld-full">
            <summary>Full proposal</summary>
            <div className="ld-full-body lwt-readonly">
              <TrialCardBody card={readOnly} now={now} />
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}
