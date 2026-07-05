// Schedules (agent_tasks) projected onto the inbox. One shared home for the
// webList row shape and the partition that decides how each armed schedule
// shows up in the session list:
//
// - INJECT schedules (originating_conversation_id set — every schedule created
//   from inside a session) have a stable home conversation. A recurring/event
//   one makes that session a STANDING row: it rests in its own section instead
//   of cycling through triage, and only a hard blocker (poll, permission
//   prompt, API error, dead agent) escalates it back into Needs Input.
// - SPAWN schedules (web/shell-created, no originating conversation) get a
//   synthetic group row; their run conversations collapse under it instead of
//   landing as loose cards. A run escapes the group when it's hard-blocked or
//   when the schedule flagged it (failed / --needs-attention).
//
// Data source is the per-user agentTasks.webList subscription (deduped by
// Convex across the badge, the strip, and /schedules) — never the store.

import type { InboxSession } from "../store/inboxStore";
import { isSessionHardBlocked, isSessionHidden } from "../store/inboxStore";

export const ARMED_STATUSES = new Set(["scheduled", "running", "paused"]);

// The agentTasks.webList payload fields the client reads.
export type TaskRow = {
  _id: string;
  title: string;
  prompt: string;
  status: string;
  mode?: string;
  schedule_type: "once" | "recurring" | "event";
  run_at?: number;
  interval_ms?: number;
  event_filter?: { event_type: string } | null;
  project_path?: string;
  run_count: number;
  created_at: number;
  last_run_at?: number;
  last_run_summary?: string;
  last_run_failed?: boolean;
  last_run_needs_attention?: boolean;
  last_run_conversation_id?: string;
  last_run_conversation_title?: string;
  last_run_session_uuid?: string;
  originating_conversation_id?: string;
  target_conversation_id?: string;
};

export interface ScheduleGroup {
  task: TaskRow;
  // Visible runs collapsed under this group row, newest first. Escalated runs
  // are NOT here — they stay loose cards in the triage buckets.
  runs: InboxSession[];
}

export interface ScheduleInboxPartition {
  // conv id → armed recurring/event inject schedules: the standing loops.
  standingByConv: Map<string, TaskRow[]>;
  // conv id → ALL armed inject schedules (any schedule_type). This is exactly
  // the set cancelTasksBoundToConversation retires when the session is killed,
  // so the hide-gesture toast and undo-revive read it.
  armedInjectByConv: Map<string, TaskRow[]>;
  // Armed spawn schedules with their collapsed runs, soonest fire first.
  spawnGroups: ScheduleGroup[];
  // Run conv ids collapsed under a group row — excluded from the status
  // buckets and from keyboard nav (reachable through the row).
  groupedRunIds: Set<string>;
}

const EMPTY: ScheduleInboxPartition = {
  standingByConv: new Map(),
  armedInjectByConv: new Map(),
  spawnGroups: [],
  groupedRunIds: new Set(),
};

export function partitionScheduleInbox(
  tasks: TaskRow[] | undefined,
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages?: Set<string>,
): ScheduleInboxPartition {
  if (!tasks?.length) return EMPTY;

  // Index visible runs once: agent_task_id → top-level, non-hidden sessions.
  const runsByTask = new Map<string, InboxSession[]>();
  for (const s of Object.values(sessions)) {
    if (!s.agent_task_id || isSessionHidden(s) || s.parent_conversation_id) continue;
    let arr = runsByTask.get(s.agent_task_id);
    if (!arr) runsByTask.set(s.agent_task_id, (arr = []));
    arr.push(s);
  }
  for (const runs of runsByTask.values()) {
    runs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  const standingByConv = new Map<string, TaskRow[]>();
  const armedInjectByConv = new Map<string, TaskRow[]>();
  const spawnGroups: ScheduleGroup[] = [];
  const groupedRunIds = new Set<string>();

  for (const task of tasks) {
    if (!ARMED_STATUSES.has(task.status)) continue;

    if (task.originating_conversation_id) {
      const convId = task.originating_conversation_id;
      const armed = armedInjectByConv.get(convId);
      if (armed) armed.push(task);
      else armedInjectByConv.set(convId, [task]);
      if (task.schedule_type === "recurring" || task.schedule_type === "event") {
        const standing = standingByConv.get(convId);
        if (standing) standing.push(task);
        else standingByConv.set(convId, [task]);
      }
      continue;
    }

    const runs = runsByTask.get(task._id) ?? [];
    const collapsed: InboxSession[] = [];
    for (const run of runs) {
      const isLatest =
        run._id === task.last_run_conversation_id ||
        (!!task.last_run_session_uuid && run.session_id === task.last_run_session_uuid);
      const escalated =
        isSessionHardBlocked(run, sessionsWithQueuedMessages) ||
        (isLatest && (!!task.last_run_failed || !!task.last_run_needs_attention));
      if (escalated) continue;
      collapsed.push(run);
      groupedRunIds.add(run._id);
    }
    spawnGroups.push({ task, runs: collapsed });
  }

  spawnGroups.sort((a, b) => (a.task.run_at ?? Infinity) - (b.task.run_at ?? Infinity));
  return { standingByConv, armedInjectByConv, spawnGroups, groupedRunIds };
}
