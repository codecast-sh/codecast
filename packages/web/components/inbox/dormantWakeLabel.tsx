// The words for a Dormant session's wake (dormantWakeOf), shared by the inbox
// card's child line (DormantWakeRow) and the conversation header's chip
// (DormantWakeChip), so both always say the same thing.
import { useMemo } from "react";
import type { InboxSession } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useLiveWatchRows } from "../../hooks/useLiveWatchRows";
import { fmtClock, fmtDuration } from "../triggerCadence";
import { partitionTriggerInbox, taskDisplayTitle, type TaskRow, type TriggerRow } from "../triggerTasks";
import { SchedFireBadge } from "../TriggerRow";
import { dormantWakeOf, type DormantWake } from "./dormantWake";

export interface DormantWakeLabel {
  what: string;
  /** When it wakes; a trigger carries its task instead, drawn as its live countdown badge. */
  when: string | { task: TaskRow };
  /** Nothing verifiable is scheduled: the agent's claim, unverified. */
  warn: boolean;
}

export function dormantWakeLabel(wake: DormantWake, now: number): DormantWakeLabel {
  switch (wake.kind) {
    case "trigger":
      return { what: taskDisplayTitle(wake.row.task) + (wake.others > 0 ? ` +${wake.others}` : ""), when: { task: wake.row.task }, warn: false };
    case "trigger_unloaded":
      return { what: "a trigger fires into it", when: "armed", warn: false };
    case "workflow":
      return { what: `workflow: ${wake.name}`, when: "when it finishes", warn: false };
    case "background":
      return { what: `${wake.count > 1 ? `${wake.count} background tasks` : "background task"}${wake.what ? `: ${wake.what}` : ""}`, when: "when it finishes", warn: false };
    case "workers":
      return { what: "its subagents are still working", when: "when they finish", warn: false };
    case "snoozed":
      return { what: "snoozed", when: fmtClock(wake.at, now), warn: false };
    case "parked":
      return { what: "parked by you", when: "on next activity", warn: false };
    case "claim":
      return {
        what: wake.what ? `nothing scheduled · ${wake.what}` : "nothing scheduled",
        when: wake.back > now ? `yours in ${fmtDuration(wake.back - now)}` : "yours now",
        warn: true,
      };
  }
}

export const DORMANT_CLAIM_TITLE = "The agent named a wake nothing here can see. It returns to Needs Input if nothing happens.";

export function WakeWhen({ when }: { when: DormantWakeLabel["when"] }) {
  return typeof when === "string" ? <>{when}</> : <SchedFireBadge task={when.task} />;
}

/** One session's wake from the rows it is handed (its own triggers and loops). */
export function useDormantWake(session: InboxSession, rows: TriggerRow[]) {
  const now = useCoarseNow(30_000);
  const watches = useLiveWatchRows(session, now);
  const wake = dormantWakeOf(session, rows, watches, now);
  return { wake, label: dormantWakeLabel(wake, now) };
}

/** The trigger rows a session's card carries: the ones it originates or
 *  created, plus the trigger that spawned it (GlobalSessionPanel's
 *  scheduleBarRowsFor, for one session). */
export function sessionTriggerRows(rows: TriggerRow[], session: Pick<InboxSession, "_id" | "agent_task_id">): TriggerRow[] {
  return rows.filter((r) =>
    r.task.originating_conversation_id === session._id ||
    r.task.created_by_conversation_id === session._id ||
    (!!session.agent_task_id && r.task._id === session.agent_task_id));
}

/** The same rows, built from the trigger roster for one open session. */
export function useSessionTriggerRows(session: InboxSession, tasks: TaskRow[] | undefined): TriggerRow[] {
  const now = useCoarseNow(30_000);
  return useMemo(() => {
    const { rows } = partitionTriggerInbox(tasks, { [session._id]: session }, { focusedId: session._id, now });
    return sessionTriggerRows(rows, session);
  }, [tasks, session, now]);
}
