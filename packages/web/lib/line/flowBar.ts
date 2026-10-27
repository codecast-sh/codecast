// The live flow's bar as the Problems page reads it (convex liveFlows, decision sd-1700): a problem under it waits
// for another finding, under "Waiting for findings", and its row says what it scored and what runs.
import { barWords, clearsBar, type FlowBar } from "@codecast/shared/contracts/linePriority";

/** A problem its live flow's bar holds back: what it scored, its findings, and the bar. */
export type UnderBar = { score: number; findings: number; bar: Pick<FlowBar, "score" | "findings"> };

type BarTask = { status?: string; readiness?: string | null; assignee?: string | null; workflow_run_id?: string | null; cause?: { signal_count?: number; scored?: { score: number } | null } | null };

/** Whether its flow's bar holds an open, ready problem back (convex liveFlows: one handed to a role runs whatever it
 *  scored), and with what; null when it clears the bar or none is set. */
export function underBarOf(t: BarTask | null | undefined, bar: Pick<FlowBar, "score" | "findings"> | null | undefined): UnderBar | null {
  const score = t?.cause?.scored?.score;
  if (!t || !bar || score == null || t.status !== "open" || t.readiness !== "ready" || t.assignee || clearsBar(t, bar)) return null;
  return { score, findings: t.cause?.signal_count ?? 0, bar: { score: bar.score, findings: bar.findings } };
}

/** "Scored 42 on 1 finding; runs at score 60+ or 3+ findings" */
export const underBarWords = (u: UnderBar): string =>
  `Scored ${u.score} on ${u.findings} finding${u.findings === 1 ? "" : "s"}; runs at ${barWords(u.bar)}`;
