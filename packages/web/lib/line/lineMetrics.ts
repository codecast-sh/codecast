/**
 * The three numbers that say how a line's quality is going (the-line-model.md
 * LM8), none of which is a count of findings:
 *
 * 1. expectation breaks per day: signals that cite an expectation (LM5) and
 *    were not refuted, the outcome;
 * 2. explained share: of the signals that arrived, the share that joined a
 *    known cause rather than opening one;
 * 3. fixes that hold: of the watches that ended, the share that ended quiet.
 *
 * Pure: the rows come from the store, the window from the caller, so the map,
 * /line and a test all read the same numbers.
 */
import { isLineRun, lineRunOutcome } from "@codecast/shared/contracts/changeCard";
import { isExpectationId } from "@codecast/shared/contracts/expectations";
import { DAY, quietWatchEnd, type LineCauseTask, type LineSignal } from "../lineFlow";

export type MetricsWindow = { from: number; to: number };

/** A line run, the fields these numbers read: which cause, and how its dissolve station ended. */
export type MetricsRun = {
  task_id?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string; started_at?: number; completed_at?: number; result_preview?: string }>;
};

export type ExplainedShare = { explained: number; opened: number; share: number | null };
export type FixesThatHold = { held: number; reopened: number; share: number | null };
export type ExpectationBreaks = { breaks: number; days: number; perDay: number };
export type LineMetrics = { breaks: ExpectationBreaks; explained: ExplainedShare; holding: FixesThatHold };

const inWindow = (at: number | null | undefined, w: MetricsWindow): at is number => typeof at === "number" && at >= w.from && at < w.to;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/**
 * Of the signals created in the window, the share the attach step put on a
 * cause it already had (a fingerprint hit or the judge's pick) rather than a
 * new one. A signal a person placed by hand says nothing about what the line
 * understands, so it counts on neither side.
 */
export function explainedShare(signals: ReadonlyArray<Pick<LineSignal, "created_at" | "attach">>, w: MetricsWindow): ExplainedShare {
  let explained = 0;
  let opened = 0;
  for (const s of signals) {
    if (!inWindow(s.created_at, w)) continue;
    if (s.attach === "fingerprint" || s.attach === "judge") explained++;
    else if (s.attach === "new") opened++;
  }
  return { explained, opened, share: ratio(explained, explained + opened) };
}

/**
 * Of the watches that ended in the window, the share that ended quiet (LE12).
 * A watch ends one of two ways: a signal comes back during it (the signal
 * that reopened the cause, dated when it arrived), or it runs out quiet
 * (quietWatchEnd, the one rule the map and /line read "held" by). A cause
 * shipped twice counts once per watch.
 */
export function fixesThatHold(
  tasks: ReadonlyArray<LineCauseTask>,
  signals: ReadonlyArray<Pick<LineSignal, "created_at" | "reopened">>,
  w: MetricsWindow,
  now: number,
): FixesThatHold {
  let held = 0;
  for (const t of tasks) if (t.cause && inWindow(quietWatchEnd(t, now), w)) held++;
  let reopened = 0;
  for (const s of signals) if (s.reopened && inWindow(s.created_at, w)) reopened++;
  return { held, reopened, share: ratio(held, held + reopened) };
}

/**
 * What the dissolve station printed (line/dissolve.sh), from the head of its
 * output the run keeps on the node: "judge_defect" when the cause's findings
 * were the judge's own mistake, "no_repro" when the miss did not reproduce.
 */
export function dissolveKind(preview: string | undefined): "judge_defect" | "no_repro" | null {
  const line = preview?.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    const kind = (JSON.parse(line) as { dissolved?: unknown }).dissolved;
    return kind === "judge_defect" || kind === "no_repro" ? kind : null;
  } catch {
    return null;
  }
}

/** The causes whose last line run ended at dissolve because the judge was wrong: their signals were refuted. */
export function judgeDefectCauses(runs: ReadonlyArray<MetricsRun>): Set<string> {
  const latest = new Map<string, { at: number; judge: boolean }>();
  for (const r of runs) {
    if (!r.task_id || !isLineRun(r.node_statuses)) continue;
    const end = lineRunOutcome(r.node_statuses);
    if (!end) continue;
    const prev = latest.get(r.task_id);
    if (prev && prev.at > end.at) continue;
    const dissolve = end.kind === "dissolved" ? r.node_statuses!.find((n) => n.node_id === "dissolve") : undefined;
    latest.set(r.task_id, { at: end.at, judge: dissolveKind(dissolve?.result_preview) === "judge_defect" });
  }
  return new Set([...latest].filter(([, v]) => v.judge).map(([id]) => id));
}

/**
 * Signals created in the window that cite an expectation (their subject is an
 * `ex-<project>-<n>` id, LE3) and were not refuted, per day of the window. A
 * signal is refuted when its cause dissolved as the judge's own mistake.
 */
export function expectationBreaks(
  signals: ReadonlyArray<Pick<LineSignal, "created_at" | "subject" | "task_id">>,
  refuted: ReadonlySet<string>,
  w: MetricsWindow,
): ExpectationBreaks {
  let breaks = 0;
  for (const s of signals) if (inWindow(s.created_at, w) && isExpectationId(s.subject) && !refuted.has(s.task_id)) breaks++;
  const days = Math.max(0, w.to - w.from) / DAY;
  return { breaks, days, perDay: days > 0 ? breaks / days : 0 };
}

/** All three, over one window. */
export function lineMetrics(input: {
  signals: ReadonlyArray<LineSignal>;
  tasks: ReadonlyArray<LineCauseTask>;
  runs: ReadonlyArray<MetricsRun>;
  window: MetricsWindow;
  now: number;
}): LineMetrics {
  const { signals, tasks, runs, window: w, now } = input;
  return {
    breaks: expectationBreaks(signals, judgeDefectCauses(runs), w),
    explained: explainedShare(signals, w),
    holding: fixesThatHold(tasks, signals, w, now),
  };
}
