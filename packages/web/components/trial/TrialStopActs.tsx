"use client";
// The acts on a trial run that stopped at a failure step, the same on /trial's
// Stopped band and on Problems' row (line-journeys.md LJ8.7): when the station
// that gave up says its approach did not work, a new approach (its report rides
// along) and closing the problem; otherwise a rerun from main and closing it.
// Each goes through the shared confirm flow; a trial limit that refuses a new
// run (its runs used, its spend cap) is said in the review, which then starts nothing.
import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import type { TrialRunRow } from "../../hooks/useSyncTrial";
import { useSyncTaskEvidence, useTaskEvidenceByShortId } from "../../hooks/useSyncTaskEvidence";
import { useInboxStore } from "../../store/inboxStore";
import { handoffOutcome } from "../../lib/line/stepWork";
import { problemListName } from "../../lib/line/problemTable";
import { closeStoppedLedger, newApproachLedger, trialStationName } from "../../lib/line/trialStopLedgers";
import { cn } from "../../lib/utils";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { useRunCost } from "../consequential/useRunCost";

/** The handoff the giving-up station's session filed on the problem (task evidence); undefined while it is read. */
export function useStationReport(task: string): string | null | undefined {
  useSyncTaskEvidence(task);
  const ev = useTaskEvidenceByShortId(task);
  return ev ? ev.verification_evidence?.trim() || null : undefined;
}

/** The station's report says its approach did not work: a rerun of the same approach is not offered. */
export const approachFailed = (report: string | null | undefined) => handoffOutcome(report) === "strategy_fails";

const BAND = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-opacity hover:opacity-90";

/** `look`: "band" for /trial's Stopped band, "row" for a Problems row (its lw-act buttons). `week`: the findings in the
 *  last 7d, when the surface counts them. */
export function TrialStopActs({ run: r, runLimit, week = null, look }: { run: TrialRunRow; runLimit: string | null; week?: number | null; look: "band" | "row" }) {
  const trialRerun = useInboxStore((s) => s.trialRerun);
  const trialClose = useInboxStore((s) => s.trialClose);
  const cost = useRunCost(r.project_id);
  const failedApproach = approachFailed(useStationReport(r.task_short_id));
  const [review, setReview] = useState<"approach" | "rerun" | "close" | null>(null);
  if (!r.stopped) return null;
  if (isTerminalTaskStatus(r.task_status)) return <span className={look === "band" ? "text-[12.5px] font-medium text-sol-text-dim" : "lwp-sub-note"} data-trial-closed>Closed</span>;
  const problem = problemListName({ title: r.task_title, name: r.task_name });
  const station = trialStationName(r.stopped.station);
  const row = look === "row";
  return (
    <>
      {failedApproach ? (
        <button type="button" onClick={() => setReview("approach")} aria-haspopup="dialog" className={row ? "lw-act" : cn(BAND, "bg-sol-blue text-sol-bg")} data-trial-new-approach={r.task_short_id}>
          {!row && <RotateCcw className="h-3.5 w-3.5" />} New approach…
        </button>
      ) : (
        <button type="button" onClick={() => setReview("rerun")} aria-haspopup="dialog" className={row ? "lw-act" : cn(BAND, "bg-sol-blue text-sol-bg")} data-trial-rerun={r.task_short_id}>
          {!row && <RotateCcw className="h-3.5 w-3.5" />} Rerun from main…
        </button>
      )}
      <button type="button" onClick={() => setReview("close")} aria-haspopup="dialog" className={row ? "lw-act" : cn(BAND, "text-sol-text ring-1 ring-sol-border/60")} data-trial-close={r.task_short_id}>Close…</button>
      {(review === "approach" || review === "rerun") && <SwitchReview ledger={newApproachLedger({ problem, station, cost, blocked: runLimit, rerun: review === "rerun" })} onClose={() => setReview(null)} onConfirm={() => { setReview(null); trialRerun(r._id, review === "approach"); }} />}
      {review === "close" && <SwitchReview ledger={closeStoppedLedger({ problem, findings: r.stopped.findings, week })} onClose={() => setReview(null)} onConfirm={() => { setReview(null); trialClose(r._id); }} />}
    </>
  );
}
