// What wakes a Dormant session, and when: the one line its row in the Dormant
// section carries. A parked session is only safe to ignore when the reader can
// see the wake it waits on, so the line names the soonest real wake the store
// knows about (a running workflow or background task, a subagent still
// producing, a trigger or /loop and its countdown), or says plainly that
// nothing is scheduled and when the row comes back to the person.
import { DORMANT_CLAIM_TTL_MS, threadStateRows, threadStateHeadline } from "@codecast/shared/contracts";
import type { TriggerRow } from "../triggerTasks";

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
  return { kind: "claim", what: namedWake(session.thread_state), back: (session.updated_at ?? now) + DORMANT_CLAIM_TTL_MS };
}
