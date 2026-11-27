// What wakes a Dormant session, and when. A parked session is only safe to
// ignore when the reader can see the wake it waits on, so this names the
// soonest real wake the row knows about (a running workflow or background
// task, a subagent still producing, a trigger or /loop and its countdown, a run
// it started, a task or a wait it waits on, and why the server no longer
// vouches for a run or wait the classifier dropped), or says plainly that
// nothing is scheduled and when the row comes back to the person.
//
// Pure and isomorphic: web, mobile and the server each pass their own trigger
// row shape. The words for a wake stay with each surface (web
// components/inbox/dormantWake.ts dormantWakeLabel).
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import { rowHeartbeatAliveAt } from "./inboxProjection";
import { rowParkedWakeLive } from "./inboxPlacement";
import { threadStateHeadline, threadStateRows } from "./threadState";

/** What a trigger row must carry for the wake to read it. */
export interface DormantTriggerRow {
  task: {
    status: string;
    run_at?: number | null;
    schedule_type?: string;
    event_filter?: { event_type: string; pr_number?: number | null; repository?: string | null } | null;
  };
}

export type DormantWake<T extends DormantTriggerRow = DormantTriggerRow> =
  /** A workflow run in this session is still going. */
  | { kind: "workflow"; name: string }
  /** Background commands or Monitors the turn ended on. */
  | { kind: "background"; count: number; what: string }
  /** A subagent or worker of this session is still producing. */
  | { kind: "workers" }
  /** The soonest armed trigger or /loop into the session. */
  | { kind: "trigger"; row: T; others: number }
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
  /** When the daemon last published that report: with its heartbeat, whether it still vouches for it (openTasksVouchForWaiting). */
  open_tasks_at?: number | null;
}

/** A background shell or Monitor a surface watches live (web useLiveWatchRows). */
export type DormantWatch = { kind?: string; description?: string; command?: string };

const ARMED = new Set(["scheduled", "running"]);

export const isArmedTrigger = (row: DormantTriggerRow): boolean => ARMED.has(row.task.status);

// The soonest wake first: a running trigger, then the earliest run_at. An event
// trigger has no time and sorts after every timed one.
function soonest<T extends DormantTriggerRow>(rows: T[]): T | null {
  let best: T | null = null;
  const key = (r: T) => (r.task.status === "running" ? -Infinity : r.task.run_at ?? Infinity);
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

/** The row's own workflow run, when one is still going in this session. */
export function runningWorkflowName(session: DormantWakeSession): string | null {
  if (!session.workflow_run_id || session.is_workflow_sub) return null;
  if (session.workflow_run_status !== "running" && session.workflow_run_status !== "pending") return null;
  return session.workflow_run_name || "workflow";
}

export function dormantWakeOf<T extends DormantTriggerRow>(
  session: DormantWakeSession,
  triggers: T[],
  watches: DormantWatch[],
  now: number,
): DormantWake<T> {
  if (session.user_rest === "dormant") return { kind: "parked" };
  if (session.inbox_snoozed_until && session.inbox_snoozed_until > now) return { kind: "snoozed", at: session.inbox_snoozed_until };
  const workflowName = runningWorkflowName(session);
  if (workflowName) return { kind: "workflow", name: workflowName };
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
  return sleepingWakeOf(session, triggers, now);
}

type ParkWake = Extract<DormantWake<never>, { kind: "run" | "run_unreported" | "blocker" | "wait" | "unconfirmed" }>;
export type SleepingWake<T extends DormantTriggerRow> = Extract<DormantWake<T>, { kind: "trigger" | "trigger_unloaded" | "claim" }> | ParkWake;

/** The wake of a row with no work of its own running: a trigger, a server-seen
 *  park, or the agent's unverified claim. */
export function sleepingWakeOf<T extends DormantTriggerRow>(session: DormantWakeSession, triggers: T[], now: number): SleepingWake<T> {
  const armed = triggers.filter(isArmedTrigger);
  const next = soonest(armed);
  if (next) return { kind: "trigger", row: next, others: armed.length - 1 };
  if ((session.armed_trigger_kind ?? "none") !== "none") return { kind: "trigger_unloaded" };
  return serverParkOf(session, now) ?? { kind: "claim", what: namedWake(session.thread_state), back: (session.updated_at ?? now) + DORMANT_CLAIM_TTL_MS };
}

/** The server-seen park on the row (parked_wake_kind), judged by the
 *  classifier's own rule (rowParkedWakeLive): a live one is named as a wake,
 *  one it dropped is named with why (quiet past its trust, or a run while this
 *  session's daemon is not running) rather than hidden. */
export function serverParkOf(session: Pick<DormantWakeSession, "parked_wake_kind" | "updated_at" | "last_heartbeat">, now: number): ParkWake | null {
  const kind = session.parked_wake_kind;
  if (kind !== "run" && kind !== "blocker" && kind !== "wait") return null;
  const row = { parked_wake_kind: kind, updated_at: session.updated_at ?? now, last_heartbeat: session.last_heartbeat ?? null };
  if (rowParkedWakeLive(row, now)) return { kind };
  if (kind === "run" && !rowHeartbeatAliveAt(row, now)) return { kind: "run_unreported" };
  return { kind: "unconfirmed", wake: kind === "run" ? "run" : "wait", since: row.updated_at };
}

/** A park the classifier counts as a wake right now. */
export const isLivePark = (wake: DormantWake<any> | null): boolean => wake?.kind === "run" || wake?.kind === "blocker" || wake?.kind === "wait";
