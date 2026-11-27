// The web layer over what wakes a Dormant session (the shared core,
// packages/shared/contracts/dormantWake.ts): the words its row in the Dormant
// section and the header chip carry, and which trigger rows a session's card
// holds.
import type { DormantWake as SharedDormantWake } from "@codecast/shared/contracts/dormantWake";
import type { InboxSession } from "../../store/inboxStore";
import { fmtClock, fmtDuration } from "../triggerCadence";
import { taskDisplayTitle, type TaskRow, type TriggerRow } from "../triggerTasks";

export { dormantWakeOf, isLivePark, serverParkOf, type DormantWakeSession } from "@codecast/shared/contracts/dormantWake";

export type DormantWake = SharedDormantWake<TriggerRow>;

// The words for a wake, shared by a Sleeping row's under-line and the
// conversation header's chip (both through ActivityLine), so both say the same.
export interface DormantWakeLabel {
  what: string;
  /** When it wakes; a trigger carries its task instead, drawn as its live countdown badge. */
  when: string | { task: TaskRow };
  /** Why the line warns, as its tooltip: an unverified claim, or a server-seen
   *  wake gone quiet past its trust. Null when the wake is one to trust. */
  warn: string | null;
}

export const DORMANT_CLAIM_TITLE = "The agent named a wake nothing here can see. It returns to Needs Input if nothing happens.";
export const DORMANT_UNCONFIRMED_TITLE = "The server saw this wake, but nothing has happened for 3 days; it is yours to check.";
export const DORMANT_RUN_UNREPORTED_TITLE = "This session's daemon is not reporting, so the run it started no longer vouches for it; it is yours to check.";

export function dormantWakeLabel(wake: DormantWake, now: number): DormantWakeLabel {
  switch (wake.kind) {
    case "trigger":
      return { what: taskDisplayTitle(wake.row.task) + (wake.others > 0 ? ` +${wake.others}` : ""), when: { task: wake.row.task }, warn: null };
    case "trigger_unloaded":
      return { what: "a trigger fires into it", when: "armed", warn: null };
    case "workflow":
      return { what: `workflow: ${wake.name}`, when: "when it finishes", warn: null };
    case "background":
      return { what: `${wake.count > 1 ? `${wake.count} background tasks` : "background task"}${wake.what ? `: ${wake.what}` : ""}`, when: "when it finishes", warn: null };
    case "workers":
      return { what: "its subagents are still working", when: "when they finish", warn: null };
    case "run":
      return { what: "a run it started", when: "when it ends or asks you", warn: null };
    case "run_unreported":
      return { what: "a run it started · its session's daemon is not reporting", when: "yours now", warn: DORMANT_RUN_UNREPORTED_TITLE };
    case "blocker":
      return { what: "a task it waits on", when: "when it closes", warn: null };
    case "wait":
      return { what: "a pending wait", when: "when it clears", warn: null };
    case "unconfirmed":
      return { what: `${wake.wake === "run" ? "a run it started" : "a pending wait"} · unconfirmed ${fmtDuration(Math.max(0, now - wake.since))}`, when: "yours now", warn: DORMANT_UNCONFIRMED_TITLE };
    case "snoozed":
      return { what: "snoozed", when: fmtClock(wake.at, now), warn: null };
    case "parked":
      return { what: "parked by you", when: "on next activity", warn: null };
    case "claim":
      return {
        what: wake.what ? `nothing scheduled · ${wake.what}` : "nothing scheduled",
        when: wake.back > now ? `yours in ${fmtDuration(wake.back - now)}` : "yours now",
        warn: DORMANT_CLAIM_TITLE,
      };
  }
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
