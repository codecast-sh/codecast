// What a card's Close does to one session, and the words its tooltip says.
// One decision for every Close surface (the card button, session.close, the
// menu, the phone), so the button never promises what the gesture does not do.
// Imports by relative path only: the phone bundles this file (Metro maps `@/`
// to the mobile package).
import { sessionLiveAt } from "./liveness";

export type CloseFacts = {
  /** Running a turn right now: Close sets it aside and lets it finish. */
  running: boolean;
  /** A role's own session or a standing anchor. */
  role: boolean;
  /** Armed triggers (and a /loop) that inject into it. */
  triggers: number;
  /** Its turn ended on a workflow run that has not reported yet. */
  waitingOnRun: boolean;
};

export type CloseKind = "aside" | "keeps_triggers" | "waits_on_run" | "clears";

export function closeKindOf(f: CloseFacts): CloseKind {
  if (f.running) return "aside";
  if (f.role || f.triggers > 0) return "keeps_triggers";
  if (f.waitingOnRun) return "waits_on_run";
  return "clears";
}

/** Close sets it aside (the agent keeps running) instead of stopping it. */
export const closeSetsAside = (f: CloseFacts) => closeKindOf(f) === "aside";

export function closeTooltip(f: CloseFacts): string {
  switch (closeKindOf(f)) {
    case "aside": return "Close: hides it, lets it finish";
    case "keeps_triggers":
      if (f.triggers === 0) return "Close: stops it, comes back on its next message";
      return `Close: stops it, keeps its ${f.triggers === 1 ? "trigger, comes back when it fires" : `${f.triggers} triggers, comes back when one fires`}`;
    case "waits_on_run": return "Close: stops it, comes back when its run reports";
    case "clears": return "Close: stops it, clears it from the list";
  }
}

/** The row fields the facts read. Every inbox row carries them. */
export type CloseRow = Parameters<typeof sessionLiveAt>[0] & {
  persistent?: boolean | null;
  standing_role_id?: string | null;
  armed_trigger_kind?: string | null;
  loop_state?: unknown;
  workflow_run_id?: string | null;
  workflow_run_status?: string | null;
  is_workflow_sub?: boolean | null;
};

/** The facts of one row at `now`. `armedTriggers` is the roster's count of
 *  armed triggers into it; `pendingSend` a send this window has not seen
 *  land, which is a turn starting. */
export function closeFactsOf(row: CloseRow, armedTriggers: number, now: number, pendingSend = false): CloseFacts {
  // The row says a trigger is armed before the roster has loaded it.
  const rowArmed = (row.armed_trigger_kind ?? "none") !== "none" ? 1 : 0;
  return {
    running: pendingSend || sessionLiveAt(row, now),
    role: !!row.persistent || !!row.standing_role_id,
    triggers: Math.max(armedTriggers + (row.loop_state ? 1 : 0), rowArmed),
    waitingOnRun: !!row.workflow_run_id && !row.is_workflow_sub && (row.workflow_run_status === "running" || row.workflow_run_status === "pending"),
  };
}
