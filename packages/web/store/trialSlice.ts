// Trial cards (convex lineTrial.ts): a trial project's line run stops at its
// gates without asking anyone, and the /trial page answers them. The answer
// paints the card at once and rides dispatch to the side effect of the same
// name (convex/dispatch.ts trialAnswer), which hands it to the paused run. A
// failed run's rerun rides trialRerun the same way, and a paused run that can
// take no answer is asked again through trialReask. An answer from a tab a
// cast browser session drives is an agent's, so it rides as a stand-in
// (the action's result carries `agent`) and never reads as the person's verdict.
import { action } from "./mutativeMiddleware";
import { isAgentDrivenTab } from "../lib/desktopHandoff";

export type TrialSliceActions = {
  /** Answer a trial card by its option key, with an optional note (Revise's words). */
  trialAnswer: (cardId: string, key: string, note?: string | null) => void;
  /** Run a failed trial run again (keyed by its problem), on a fresh branch from origin/main. `newApproach`: a stopped
   *  station's approach did not work, and the new run is asked for a different one (its report rides along). */
  trialRerun: (taskId: string, newApproach?: boolean) => void;
  /** Close a stopped trial run's problem (keyed by its problem): it drops, and its findings retire with it. */
  trialClose: (taskId: string) => void;
  /** Ask a paused trial run again (keyed by its problem): its machine has the asking station present a new decision. */
  trialReask: (taskId: string) => void;
  /** Raise a trial's run limit and spend cap (only up): its dispatcher may start runs again on its next pass. */
  trialRaiseLimits: (projectId: string, maxRuns: number, capUsd: number) => void;
};

type Cards = { trialCards: Record<string, any>; trialRuns: Record<string, any>; trialProjects?: Record<string, any>; currentUser?: { _id: string } | null };

export function createTrialSlice(): TrialSliceActions {
  return {
    trialAnswer: action(function (this: Cards, cardId: string, key: string, note?: string | null) {
      const card = this.trialCards[cardId];
      if (!card || card.status !== "waiting") return;
      const option = (card.options ?? []).find((o: any) => String(o.key).toUpperCase() === key.toUpperCase());
      if (!option) return;
      const now = Date.now();
      const text = note?.trim() || undefined;
      const agent = isAgentDrivenTab();
      card.status = "answered";
      card.answer = { key: option.key, label: option.label, ...(text ? { note: text } : {}), at: now, by: String(this.currentUser?._id ?? ""), stand_in: agent };
      card.updated_at = now;
      return agent ? { agent: true } : undefined;
    }) as TrialSliceActions["trialAnswer"],
    // The row shows the new run at once; the server's row (its new run id) replaces it.
    trialRerun: action(function (this: Cards, taskId: string, _newApproach?: boolean) {
      const row = this.trialRuns[taskId];
      if (!row || !(row.status === "failed" || row.stopped)) return;
      // A run lost at its own card picks up there, the same run; any other starts again from main.
      if (row.lost_at_gate) row.node_id = row.lost_at_gate.node;
      row.lost_at_gate = null;
      row.status = "pending";
      row.fail_reason = null;
      row.stopped = null;
      row.fresh_branch = true;
      row.updated_at = Date.now();
    }) as TrialSliceActions["trialRerun"],
    // The problem reads closed at once, in the pane and on its task; the server's row drops out of Stopped.
    trialClose: action(function (this: Cards & { tasks?: Record<string, any> }, taskId: string) {
      const row = this.trialRuns[taskId];
      if (!row?.stopped) return;
      const now = Date.now();
      row.task_status = "dropped";
      row.updated_at = now;
      const task = this.tasks?.[taskId];
      if (task) { task.status = "dropped"; task.closed_at = now; task.updated_at = now; }
    }) as TrialSliceActions["trialClose"],
    // The problem's waiting cards say they were asked again (`reask_at`, read by the Re-ask button); the server closes
    // them once the run's machine has picked the run up, and the new decision arrives as a card of its own.
    trialReask: action(function (this: Cards, taskId: string) {
      const now = Date.now();
      for (const card of Object.values(this.trialCards)) if (card.task_id === taskId && card.status === "waiting") card.reask_at = now;
    }) as TrialSliceActions["trialReask"],
    // The header reads the new limits at once, and no hold: the one recorded named the old limits (lineTrial.raiseLimits).
    trialRaiseLimits: action(function (this: Cards, projectId: string, maxRuns: number, capUsd: number) {
      const d = this.trialProjects?.[projectId]?.dispatch;
      if (!d || maxRuns < (d.max_runs ?? 0) || capUsd < d.cap_usd) return;
      d.max_runs = maxRuns;
      d.cap_usd = capUsd;
      d.held = null;
    }) as TrialSliceActions["trialRaiseLimits"],
  };
}
