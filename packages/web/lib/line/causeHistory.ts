// A cause's life over time (line-workspace.md LW1 Timeline, LW5), as the web
// reads it. The derivation is the shared one
// (@codecast/shared/contracts/causeHistory), which the server also runs for a
// line run that starts on the cause (lineWorkspace causeHistoryForTask), so
// the timeline a person reads and the brief a station is handed never
// disagree. This file only supplies what the web says better: a run's outcome
// in the run report's words (runOutcome).
import {
  causeHistory as sharedCauseHistory,
  signalQuotes,
  type CauseHistory as SharedCauseHistory,
  type HistoryAttempt as SharedHistoryAttempt,
  type HistoryDecisionRow,
  type DeployRow,
  type OccurrenceRow,
  type RunSaid,
} from "@codecast/shared/contracts/causeHistory";
import type { LineCauseTask } from "../lineFlow";
import type { MapDecision, MapRun, MapSignal } from "./lineMap";
import { runOutcome, type ReportRun, type ReportTask, type RunOutcome } from "./runReport";

export {
  carryingDeploys, historyBrief, earlierFixes, closesSummary, closesArgument, closedAtStep, unshippedGuard,
  type OccurrenceRow, type DeployRow, type RunMergeRow, type Occurrence, type AttemptCard, type AttemptMerge, type CarriedHow,
  type HistoryDeploy, type FixBasis, type HistoryShip, type WatchState, type HistoryWatch, type HistoryRegression, type DeployCoverage,
  type EarlierFix, type HistoryClose, type HistoryRecurrence, type CloseKind, type CloseArgument, type RunSaid,
} from "@codecast/shared/contracts/causeHistory";

export type HistoryAttempt = SharedHistoryAttempt<RunOutcome>;
export type CauseHistory = SharedCauseHistory<RunOutcome>;

export type HistoryInput = {
  task: LineCauseTask | undefined;
  /** The cause's runs, any graph, newest first. */
  runs: ReadonlyArray<MapRun>;
  decisions: ReadonlyArray<MapDecision>;
  signals: ReadonlyArray<MapSignal>;
  occurrences: OccurrenceRow | undefined;
  /** Undefined until read; the project's deploys newest first. */
  deploys: ReadonlyArray<DeployRow> | undefined;
  /** Per run, what its stations found, proposed and built, and a close's argument (the model reads them off the visits). */
  said: (runId: string) => RunSaid;
  /** The line profile's watch days, when known. */
  watchDays: number | null;
  now: number;
};

export function causeHistory(input: HistoryInput): CauseHistory {
  // An occurrence's own words, for the signals the store holds (the recent two weeks).
  let quotes: Map<number, string> | null = null;
  const quoteAt = (at: number) => {
    quotes ??= new Map(input.signals.flatMap((s) => {
      const q = signalQuotes(s.detail_md)[0];
      return q ? [[s.observed_at ?? s.created_at, q] as const] : [];
    }));
    return quotes.get(at) ?? null;
  };
  return sharedCauseHistory({
    quoteAt,
    ...input,
    runs: input.runs as ReadonlyArray<MapRun & ReportRun>,
    decisions: input.decisions as ReadonlyArray<MapDecision & HistoryDecisionRow>,
    outcome: (run) => runOutcome(run, input.task as ReportTask | undefined, input.now, true),
  });
}
