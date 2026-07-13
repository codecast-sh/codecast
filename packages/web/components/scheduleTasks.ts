// Schedules (agent_tasks) projected onto the inbox — the synthesis model:
//
//   Schedules live in ONE collapsible SCHEDULES section; everything a schedule
//   does stays behind its row until it needs you — then it's a normal card.
//
// Every ARMED schedule (recurring, once, event; inject or spawn — no user-facing
// distinction) gets exactly one schedule-first row. Conversations never change
// section because of a schedule; instead, work that is purely the schedule's —
// a resting loop's home conversation after a machine wake, or an uneventful
// spawned run — is ABSORBED behind its row (dropped from the triage buckets and
// keyboard nav, reachable by clicking the row). Anything that needs a human
// (hard blocker, failed/flagged run, or a turn the human initiated) is never
// absorbed: it triages as an ordinary card.
//
// Data source is the per-user agentTasks.webList subscription (deduped by
// Convex across the badge, the strip, and /schedules) — never the store.

import type { InboxSession } from "../store/inboxStore";
import { isSessionHardBlocked, isSessionHidden } from "../store/inboxStore";
import { isMachineDeliveredMessage } from "./sessionMessage";

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
  originating_conversation_title?: string;
  target_conversation_id?: string;
  retry_count?: number;
  // Haiku-distilled presentation fields (agentTasks.generateDisplaySummary).
  // display_title only exists when the stored title was a prompt slice; an
  // explicit human title is left alone, so preferring display_title is safe.
  display_title?: string;
  display_summary?: string;
};

// A prompt-slice title is cut at 60 chars mid-word or mid-parenthesis
// ("Check the deploy (sha 9ee76"). Trim the dangling fragment so the fallback
// reads like a name, not a cut. Only slice-width titles get the word trim —
// a short explicit title is already whole.
export function cleanPromptSliceTitle(title: string): string {
  let t = title.trim();
  const open = t.lastIndexOf("(");
  if (open !== -1 && !t.includes(")", open)) t = t.slice(0, open);
  if (title.length >= 60) t = t.replace(/\s+\S{1,3}$/, "");
  t = t.trim().replace(/[\s,;:.—-]+$/, "");
  return t || title;
}

// The readable name for a schedule, shared by every row surface.
export function taskDisplayTitle(t: Pick<TaskRow, "display_title" | "title">): string {
  return t.display_title?.trim() || cleanPromptSliceTitle(t.title);
}

// Optimistic webList patch for schedule verbs (run now / pause / resume /
// cancel): flip the row's fields in Convex's local query cache so the UI
// renders the result of the click synchronously — local-first — and the server
// echo reconciles. Shared by every surface that mutates schedules off the
// webList subscription (rows, dock, /schedules page).
export function patchTaskInWebList(
  localStore: { getQuery: (q: unknown, a: unknown) => unknown; setQuery: (q: unknown, a: unknown, v: unknown) => void },
  webListQuery: unknown,
  taskId: string,
  patch: Partial<TaskRow>,
) {
  const rows = localStore.getQuery(webListQuery, {}) as TaskRow[] | undefined;
  if (!rows) return;
  localStore.setQuery(
    webListQuery,
    {},
    rows.map((t) => (t._id === taskId ? { ...t, ...patch } : t)),
  );
}

export interface ScheduleRow {
  task: TaskRow;
  // Conversation this row opens: the home conversation (inject) or the newest
  // visible run, falling back to the last recorded run even when folded (the
  // dismissed-peek path handles it). Undefined for a spawn schedule that has
  // never run.
  openId?: string;
  // The latest outcome landed after the user's read watermark.
  unread: boolean;
}

export interface ScheduleInboxPartition {
  // One row per armed schedule, soonest fire first (event/paused sink last).
  rows: ScheduleRow[];
  // Sessions absorbed behind a row: resting loop homes + uneventful runs.
  absorbedIds: Set<string>;
  // conv id → ALL armed inject schedules. Exactly the set the kill transition
  // cancels server-side; the kill toast and undo-revive read it.
  armedInjectByConv: Map<string, TaskRow[]>;
  // Collapsed-header briefing numbers.
  unreadCount: number;
  nextRunAt?: number;
}

const EMPTY: ScheduleInboxPartition = {
  rows: [],
  absorbedIds: new Set(),
  armedInjectByConv: new Map(),
  unreadCount: 0,
  nextRunAt: undefined,
};

export function partitionScheduleInbox(
  tasks: TaskRow[] | undefined,
  sessions: Record<string, InboxSession>,
  opts: {
    sessionsWithQueuedMessages?: Set<string>;
    // clientState.ui.schedules_seen_at — outcomes newer than this are unread.
    seenAt?: number;
  } = {},
): ScheduleInboxPartition {
  if (!tasks?.length) return EMPTY;
  const seenAt = opts.seenAt ?? 0;

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

  const rows: ScheduleRow[] = [];
  const absorbedIds = new Set<string>();
  const armedInjectByConv = new Map<string, TaskRow[]>();
  let unreadCount = 0;
  let nextRunAt: number | undefined;

  for (const task of tasks) {
    if (!ARMED_STATUSES.has(task.status)) continue;

    const unread = !!task.last_run_at && task.last_run_at > seenAt;
    if (unread) unreadCount++;
    if (task.status === "scheduled" && task.run_at !== undefined) {
      if (nextRunAt === undefined || task.run_at < nextRunAt) nextRunAt = task.run_at;
    }

    if (task.originating_conversation_id) {
      const convId = task.originating_conversation_id;
      const armed = armedInjectByConv.get(convId);
      if (armed) armed.push(task);
      else armedInjectByConv.set(convId, [task]);

      // Absorption requires a LOOP: a once follow-up is a reminder on an
      // ordinary conversation, never a reason to hide it. A loop's home rests
      // behind the row only while the machine is driving — pinned, blocked,
      // blank, hidden, or human-engaged conversations triage normally.
      if (task.schedule_type === "recurring" || task.schedule_type === "event") {
        const home = sessions[convId];
        if (
          home &&
          !home.is_pinned &&
          home.message_count > 0 &&
          !isSessionHidden(home) &&
          !isSessionHardBlocked(home, opts.sessionsWithQueuedMessages) &&
          (!home.last_user_message || isMachineDeliveredMessage(home.last_user_message))
        ) {
          absorbedIds.add(convId);
        }
      }
      rows.push({ task, openId: convId, unread });
      continue;
    }

    // Spawn schedule: absorb its uneventful runs. A run escapes absorption
    // (stays a loose card) when hard-blocked, or when it's the latest run and
    // the schedule flagged it (failed / --needs-attention).
    const runs = runsByTask.get(task._id) ?? [];
    let newestAbsorbed: InboxSession | undefined;
    for (const run of runs) {
      const isLatest =
        run._id === task.last_run_conversation_id ||
        (!!task.last_run_session_uuid && run.session_id === task.last_run_session_uuid);
      const escalated =
        isSessionHardBlocked(run, opts.sessionsWithQueuedMessages) ||
        (isLatest && (!!task.last_run_failed || !!task.last_run_needs_attention));
      if (escalated) continue;
      absorbedIds.add(run._id);
      if (!newestAbsorbed) newestAbsorbed = run;
    }
    rows.push({ task, openId: newestAbsorbed?._id ?? task.last_run_conversation_id, unread });
  }

  // Ordered in tiers of "what's happening now → what's happening next → what's
  // idle": live runs at the very top, then scheduled by soonest fire, then
  // paused / event / no-run_at at the bottom (newest-created first among those).
  // (Running previously sank to the bottom because its status isn't
  // "scheduled" — the opposite of what a roster wants to surface.)
  const tier = (t: ScheduleRow["task"]) =>
    t.status === "running" ? 0 : t.status === "scheduled" ? 1 : 2;
  rows.sort((a, b) => {
    const ta = tier(a.task), tb = tier(b.task);
    if (ta !== tb) return ta - tb;
    const ar = a.task.status === "scheduled" ? a.task.run_at ?? Infinity : Infinity;
    const br = b.task.status === "scheduled" ? b.task.run_at ?? Infinity : Infinity;
    if (ar !== br) return ar - br;
    return b.task.created_at - a.task.created_at;
  });

  return { rows, absorbedIds, armedInjectByConv, unreadCount, nextRunAt };
}
