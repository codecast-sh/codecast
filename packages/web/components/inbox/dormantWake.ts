// What wakes a Dormant session, and when: the one line its row in the Dormant
// section carries. A parked session is only safe to ignore when the reader can
// see the wake it waits on, so the line names the soonest real wake the store
// knows about (a running workflow or background task, a subagent still
// producing, a trigger or /loop and its countdown, a run it started, a task or
// a wait it waits on, and why the server no longer vouches for a run or wait
// the classifier dropped), or says plainly that nothing is scheduled and when
// the row comes back to the person.
import { DORMANT_CLAIM_TTL_MS, rowHeartbeatAliveAt, threadStateRows, threadStateHeadline } from "@codecast/shared/contracts";
import { rowParkedWakeLive } from "@codecast/shared/contracts/inboxPlacement";
import type { InboxSession } from "../../store/inboxStore";
import { fmtClock, fmtDuration } from "../triggerCadence";
import { taskDisplayTitle, type TaskRow, type TriggerRow } from "../triggerTasks";

export type DormantWake =
  /** A workflow run in this session is still going. */
  | { kind: "workflow"; name: string }
  /** Background commands or Monitors the turn ended on. */
  | { kind: "background"; count: number; what: string }
  /** A subagent or worker of this session is still producing. */
  | { kind: "workers" }
  /** The soonest armed trigger or /loop into the session. */
  | { kind: "trigger"; row: TriggerRow; others: number }
  /** The row says a trigger is armed, but the roster has not loaded it. */
  | { kind: "trigger_unloaded" }
  /** The server sees a live run this session started (parked_wake_kind "run"),
   *  and its machine's daemon reports. */
  | { kind: "run" }
  /** A run it started while its session's daemon is not reporting (the
   *  heartbeat lapsed; a hibernated session's daemon still reports): only that
   *  daemon resumes the run, so the classifier no longer counts it. */
  | { kind: "run_unreported" }
  /** An open task on the held task's blocked_by (parked_wake_kind "blocker"). */
  | { kind: "blocker" }
  /** Only waits stand (parked_wake_kind "wait"): on the held task, or set on
   *  another. The row does not say which wait, nor who set it. */
  | { kind: "wait" }
  /** A wait or run stamp quiet past PARKED_WAKE_TTL_MS: the wake may still
   *  come, but nothing has confirmed it since `since`. */
  | { kind: "unconfirmed"; wake: "wait" | "run"; since: number }
  | { kind: "snoozed"; at: number }
  /** The person filed it here themselves. */
  | { kind: "parked" }
  /** The agent declared dormant and named a wake nothing here can see (another
   *  session's reply, a blocker, mail). It returns to the person at `back`. */
  | { kind: "claim"; what: string | null; back: number };

export interface DormantWakeSession {
  agent_status?: string | null;
  updated_at?: number;
  user_rest?: string | null;
  inbox_snoozed_until?: number | null;
  producing_until?: number | null;
  armed_trigger_kind?: string | null;
  parked_wake_kind?: string | null;
  /** The daemon's heartbeat, which a run stamp needs (rowParkedWakeLive). */
  last_heartbeat?: number | null;
  workflow_run_id?: string | null;
  workflow_run_status?: string | null;
  workflow_run_name?: string | null;
  is_workflow_sub?: boolean;
  thread_state?: string | null;
  /** The daemon's checked report of the work the turn ended on. Watch rows
   *  draw shells and Monitors; a Workflow run or background Agent appears only
   *  here. */
  open_tasks?: Array<{ kind: string; description?: string; command?: string }> | null;
}

const ARMED = new Set(["scheduled", "running"]);

// The soonest wake first: a running trigger, then the earliest run_at. An event
// trigger has no time and sorts after every timed one.
function soonest(rows: TriggerRow[]): TriggerRow | null {
  let best: TriggerRow | null = null;
  const key = (r: TriggerRow) => (r.task.status === "running" ? -Infinity : r.task.run_at ?? Infinity);
  for (const r of rows) if (!best || key(r) < key(best)) best = r;
  return best;
}

// The wake the agent named in its pinned state: a `Next:` or `Waiting:` line
// when it wrote one, else the headline.
function namedWake(state: string | null | undefined): string | null {
  const text = state?.trim();
  if (!text) return null;
  const row = threadStateRows(text).find((r) => r.label === "Next" || r.label === "Waiting" || r.label === "Wakes");
  return (row?.text ?? threadStateHeadline(text)).replace(/`/g, "") || null;
}

export function dormantWakeOf(
  session: DormantWakeSession,
  triggers: TriggerRow[],
  watches: Array<{ description?: string; command?: string }>,
  now: number,
): DormantWake {
  if (session.user_rest === "dormant") return { kind: "parked" };
  if (session.inbox_snoozed_until && session.inbox_snoozed_until > now) return { kind: "snoozed", at: session.inbox_snoozed_until };
  if (session.workflow_run_id && !session.is_workflow_sub && (session.workflow_run_status === "running" || session.workflow_run_status === "pending")) {
    return { kind: "workflow", name: session.workflow_run_name || "workflow" };
  }
  if (watches.length > 0) {
    const first = watches[0];
    const what = (first.description || first.command?.split("\n").find((l) => l.trim()) || "").trim();
    return { kind: "background", count: watches.length, what };
  }
  const open = session.open_tasks ?? [];
  const workflow = open.find((t) => t.kind === "workflow");
  if (workflow) return { kind: "workflow", name: workflow.description || "workflow run" };
  if (open.some((t) => t.kind === "agent") || (session.producing_until != null && now < session.producing_until)) return { kind: "workers" };
  if (open.length > 0) {
    const first = open[0];
    return { kind: "background", count: open.length, what: (first.description || first.command || "").trim() };
  }
  const armed = triggers.filter((r) => ARMED.has(r.task.status));
  const next = soonest(armed);
  if (next) return { kind: "trigger", row: next, others: armed.length - 1 };
  if ((session.armed_trigger_kind ?? "none") !== "none") return { kind: "trigger_unloaded" };
  return serverParkOf(session, now) ?? { kind: "claim", what: namedWake(session.thread_state), back: (session.updated_at ?? now) + DORMANT_CLAIM_TTL_MS };
}

/** The server-seen park on the row (parked_wake_kind), judged by the
 *  classifier's own rule (rowParkedWakeLive): a live one is named as a wake,
 *  one it dropped is named with why (quiet past its trust, or a run while this
 *  session's daemon is not running) rather than hidden. */
export function serverParkOf(session: Pick<DormantWakeSession, "parked_wake_kind" | "updated_at" | "last_heartbeat">, now: number): DormantWake | null {
  const kind = session.parked_wake_kind;
  if (kind !== "run" && kind !== "blocker" && kind !== "wait") return null;
  const row = { parked_wake_kind: kind, updated_at: session.updated_at ?? now, last_heartbeat: session.last_heartbeat ?? null };
  if (rowParkedWakeLive(row, now)) return { kind };
  if (kind === "run" && !rowHeartbeatAliveAt(row, now)) return { kind: "run_unreported" };
  return { kind: "unconfirmed", wake: kind === "run" ? "run" : "wait", since: row.updated_at };
}

/** A park the classifier counts as a wake right now. */
export const isLivePark = (wake: DormantWake | null): boolean => wake?.kind === "run" || wake?.kind === "blocker" || wake?.kind === "wait";

// The words for a wake, shared by the inbox card's child line (DormantWakeRow)
// and the conversation header's chip (DormantWakeChip), so both say the same.
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
