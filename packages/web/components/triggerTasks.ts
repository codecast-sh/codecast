// Schedules (agent_tasks) projected onto the inbox — the synthesis model:
//
//   Schedules live in ONE collapsible TRIGGERS section; everything a schedule
//   does stays behind its row until it needs you — then it's a normal card.
//
// Every ARMED schedule (recurring, once, event; inject or spawn — no user-facing
// distinction) gets exactly one schedule-first row. Conversations never change
// section because of a schedule; instead, work that is purely the schedule's —
// a resting loop's home conversation after a machine wake, a once follow-up's
// home that settled in Done, or an uneventful spawned run — is ABSORBED behind
// its row (dropped from the triage buckets and keyboard nav, reachable by
// clicking the row). Anything that needs a human (hard blocker, failed/flagged
// run, or a turn the human initiated) is never absorbed: it triages as an
// ordinary card.
//
// Data source is the per-user agentTasks.webList subscription (deduped by
// Convex across the badge, the strip, and /schedules) — never the store.

import type { InboxSession } from "../store/inboxStore";
import { classifySession, isSessionHardBlocked, isSessionHidden } from "../store/inboxStore";
import { isMachineDeliveredMessage } from "./sessionMessage";

export const ARMED_STATUSES = new Set(["scheduled", "running", "paused"]);

// The agentTasks.webList payload fields the client reads.
export type TaskRow = {
  _id: string;
  short_id?: string;
  title: string;
  prompt: string;
  status: string;
  mode?: string;
  agent_type?: string;
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
  // Conversation that created the trigger — attribution only (spawn triggers
  // have no originating binding, but still trace to their parent through this).
  created_by_conversation_id?: string;
  created_by_conversation_title?: string;
  target_conversation_id?: string;
  retry_count?: number;
  max_runtime_ms?: number;
  // Haiku-distilled presentation fields (agentTasks.generateDisplaySummary).
  // display_title only exists when the stored title was a prompt slice; an
  // explicit human title is left alone, so preferring display_title is safe.
  display_title?: string;
  display_summary?: string;
  // Set when the schedule was canceled as a side effect of killing its home
  // conversation (vs. completing naturally). The server re-arms stamped tasks
  // when the session is restored; the client reads it to SAY so.
  canceled_on_kill_at?: number;
  // Present on conversation-scoped rows (webListForConversation / webGet):
  // false = a trigger anchored to a conversation the viewer can see but owned
  // by another account (a daemon's bot login). Viewable, not manageable —
  // verbs are owner-only. Absent (webList rows) = own.
  is_own?: boolean;
  // The owning account's display name, only when is_own is false.
  owner_name?: string;
};

// Armed inject schedules bound to one conversation — exactly the set the
// server cancels when that conversation is killed. Every kill surface
// (sidebar button, palette, keyboard chord) consults this for its notice.
export function armedInjectTasksFor(tasks: TaskRow[] | undefined, convId: string): TaskRow[] {
  return (tasks ?? []).filter(
    (t) => ARMED_STATUSES.has(t.status) && t.originating_conversation_id === convId,
  );
}

// Schedules a kill of this conversation took down (stamped canceled_on_kill_at)
// — the set the server re-arms when the session is restored.
export function killCanceledTasksFor(tasks: TaskRow[] | undefined, convId: string): TaskRow[] {
  return (tasks ?? []).filter(
    (t) => t.status === "completed" && !!t.canceled_on_kill_at && t.originating_conversation_id === convId,
  );
}

// Is this trigger in trouble RIGHT NOW? The one definition of "failing", shared
// by every surface that shows health — the rail's red dot, the row's status dot,
// the stat cell, and the attention banner — so a trigger never reads as broken in
// one place and fine in another.
//
// Keyed on last_run_failed (the outcome of the latest run), never on retry_count.
// retry_count is the current failure STREAK: failRun counts it up toward
// max_retries and a successful run resets it. Reading it as health was the bug —
// before completeTaskRun reset it, one old blip left a fully recovered trigger
// screaming "retrying" forever while the rail (already on last_run_failed) showed
// it green.
export function isTriggerFailing(t: Pick<TaskRow, "last_run_failed">): boolean {
  return !!t.last_run_failed;
}

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

// The most recent firing of a schedule that's already in the local message
// cache — the synchronous fast path for "click the trigger row → land on its
// last run". Matches exactly what the server's webListRuns matches (the
// task-id marker substring on user turns), scanned newest-first over the
// loaded window. Returns undefined when the window holds none (messages not
// loaded, or the runs fell outside it) — callers fall back to the run-list
// query rather than guessing.
export function latestLoadedTriggerMessage(
  messages: readonly { _id: string; role: string; content?: string; timestamp: number }[] | undefined,
  taskId: string,
): { messageId: string; timestamp: number } | undefined {
  if (!messages?.length) return undefined;
  const marker = `task-id="${taskId}"`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.content?.includes(marker)) {
      return { messageId: m._id, timestamp: m.timestamp };
    }
  }
  return undefined;
}

export interface TriggerRow {
  task: TaskRow;
  // Conversation this row opens: the home conversation (inject) or the newest
  // visible run, falling back to the last recorded run even when folded (the
  // dismissed-peek path handles it), then to the creating session for a spawn
  // schedule that has never run. Undefined only when none of those exist.
  openId?: string;
  // The latest outcome landed after the user's read watermark.
  unread: boolean;
  // Pseudo rows synthesized from sessions rather than agent_tasks: a harness
  // /loop sleeping on a ScheduleWakeup. They wear the same row anatomy but
  // carry no server verbs (pause/run-now/cancel) — you can't reach inside a
  // harness from here. Absent = a real trigger.
  kind?: "loop";
}

// -- Pseudo rows: loops projected into the trigger set --
//
// The trigger set models one axis — "a machine will act here on its own on a
// SCHEDULE" — and agent_tasks are only one source of that intent. A session
// sleeping on a ScheduleWakeup (/loop) is the same standing intent, so it gets
// a row in the same roster, mapped through the TaskRow shape every trigger
// surface already renders. Subagents are deliberately NOT in this set: a
// running worker is transient labor, not a standing trigger, and it already
// renders nested under its parent session's card.

// Freshness lives in shared/contracts/loopState — the server classifier and
// this roster must agree on when a loop stops being a live standing intent.
import { isLoopFresh } from "@codecast/shared/contracts";
export { LOOP_OVERDUE_GRACE_MS, LOOP_WAKING_TTL_MS, isLoopFresh } from "@codecast/shared/contracts";

export type LoopStateLike = NonNullable<InboxSession["loop_state"]>;

export function loopTaskRow(sess: InboxSession, loop: LoopStateLike): TaskRow {
  return {
    _id: `loop:${sess._id}`,
    // The reason IS the row's name ("watching CI run"); the session title
    // rides the gist line so the row stays attributable.
    title: loop.reason?.trim() || sess.title || "Self-paced loop",
    display_summary: loop.reason?.trim() ? sess.title : undefined,
    prompt: loop.prompt || loop.reason || "",
    status: loop.status === "waking" ? "running" : "scheduled",
    // "apply" is the unmarked norm — anything else grows a read-only chip,
    // which would be a false claim about a harness loop.
    mode: "apply",
    schedule_type: "recurring",
    run_at: loop.status === "armed" ? loop.wakeup_at : undefined,
    project_path: sess.project_path,
    run_count: 0,
    created_at: loop.armed_at,
    last_run_at: loop.fired_at,
    originating_conversation_id: sess._id,
  };
}

export interface TriggerInboxPartition {
  // One row per armed schedule, soonest fire first (event/paused sink last).
  rows: TriggerRow[];
  // Sessions absorbed behind a row: resting loop homes + uneventful runs.
  absorbedIds: Set<string>;
  // conv id → ALL armed inject schedules. Exactly the set the kill transition
  // cancels server-side; the kill toast and undo-revive read it.
  armedInjectByConv: Map<string, TaskRow[]>;
  // Collapsed-header briefing numbers.
  unreadCount: number;
  nextRunAt?: number;
}

const EMPTY: TriggerInboxPartition = {
  rows: [],
  absorbedIds: new Set(),
  armedInjectByConv: new Map(),
  unreadCount: 0,
  nextRunAt: undefined,
};

export function partitionTriggerInbox(
  tasks: TaskRow[] | undefined,
  sessions: Record<string, InboxSession>,
  opts: {
    sessionsWithQueuedMessages?: Set<string>;
    // clientState.ui.schedules_seen_at — outcomes newer than this are unread.
    seenAt?: number;
    // The session open in the conversation pane. Never absorbed — same rule as
    // the focused-session overlay in partitionWorkingSet: the session you're
    // viewing always has a card, so selection highlight and auto-scroll can
    // land on it.
    focusedId?: string | null;
    // Clock for loop-freshness membership (armed wakeup overdue, waking turn
    // aged out). Callers pass a coarse clock so membership re-evaluates on it;
    // countdown text inside rows rides its own render-time clock.
    now?: number;
  } = {},
): TriggerInboxPartition {
  const seenAt = opts.seenAt ?? 0;
  const now = opts.now ?? Date.now();
  const sessList = Object.values(sessions);
  if (!tasks?.length && !sessList.some((s) => s.loop_state)) {
    return EMPTY;
  }

  // Index visible runs once: agent_task_id → top-level, non-hidden sessions.
  const runsByTask = new Map<string, InboxSession[]>();
  for (const s of sessList) {
    if (!s.agent_task_id || isSessionHidden(s) || s.parent_conversation_id) continue;
    let arr = runsByTask.get(s.agent_task_id);
    if (!arr) runsByTask.set(s.agent_task_id, (arr = []));
    arr.push(s);
  }
  for (const runs of runsByTask.values()) {
    runs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  const rows: TriggerRow[] = [];
  const absorbedIds = new Set<string>();
  const armedInjectByConv = new Map<string, TaskRow[]>();
  let unreadCount = 0;
  let nextRunAt: number | undefined;

  for (const task of tasks ?? []) {
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

      // Absorption parks the home behind the row only while the machine is
      // driving — pinned, blocked, blank, hidden, or human-engaged
      // conversations triage normally. A flagged latest run (failed /
      // --needs-attention) escapes too, same as spawn runs below: the flag is
      // a claim on the user until the next clean run overwrites it. A LOOP
      // (recurring / event) absorbs whatever the home's rest verdict; a once
      // follow-up absorbs only a home SETTLED IN DONE — delivered plus a named
      // wake is parked, but a reminder must never hide an open ask or a live
      // run (mirrors the armedOnceTriggerHome demotion in
      // convex/inboxFilters.ts).
      {
        const home = sessions[convId];
        const parks =
          task.schedule_type === "recurring" ||
          task.schedule_type === "event" ||
          (!!home && classifySession(home).waiting && classifySession(home).rest === "done");
        if (
          home && parks &&
          convId !== opts.focusedId &&
          !home.is_pinned &&
          home.message_count > 0 &&
          !isSessionHidden(home) &&
          !isSessionHardBlocked(home, opts.sessionsWithQueuedMessages) &&
          !task.last_run_failed &&
          !task.last_run_needs_attention &&
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
      if (escalated || run._id === opts.focusedId) continue;
      absorbedIds.add(run._id);
      if (!newestAbsorbed) newestAbsorbed = run;
    }
    // A spawn trigger that has never run opens the session that created it —
    // the only conversation that can explain the trigger before a run exists.
    rows.push({
      task,
      openId: newestAbsorbed?._id ?? task.last_run_conversation_id ?? task.created_by_conversation_id,
      unread,
    });
  }

  // -- Pseudo rows: loops from the session cache --
  for (const sess of sessList) {
    const loop = sess.loop_state;
    if (!loop || !isLoopFresh(loop, now)) continue;
    // Dismiss/kill retires the session AND its loop (the harness dies with the
    // tmux); a stashed home keeps its row — stash is the standing-loop home.
    // Deliberately NOT isSessionHidden: that folds in stashed, which this loop
    // must keep. inbox_killed_at is the other half of "retired" — the
    // killSession mutation (the web's convCommand path) stamps it WITHOUT
    // inbox_dismissed_at, so a session killed that way kept a loop row for a
    // harness that no longer exists.
    if (sess.inbox_dismissed_at || sess.inbox_killed_at) continue;
    rows.push({ task: loopTaskRow(sess, loop), openId: sess._id, unread: false, kind: "loop" });
    if (loop.status === "armed" && (nextRunAt === undefined || loop.wakeup_at < nextRunAt)) {
      nextRunAt = loop.wakeup_at;
    }
    // Same resting rule as inject-trigger homes: the machine is driving, so the
    // session lives behind its row. "Waking" is the machine's own turn; an
    // armed loop rests only while the agent is actually asleep (is_idle) —
    // a human-initiated turn surfaces the card like any other conversation.
    if (
      sess._id !== opts.focusedId &&
      !sess.is_pinned &&
      sess.message_count > 0 &&
      !isSessionHidden(sess) &&
      !sess.has_pending &&
      !isSessionHardBlocked(sess, opts.sessionsWithQueuedMessages) &&
      (loop.status === "waking" || sess.is_idle)
    ) {
      absorbedIds.add(sess._id);
    }
  }
  // Ordered in tiers of "what's happening now → what's happening next → what's
  // idle": live runs at the very top, then scheduled by soonest fire, then
  // paused / event / no-run_at at the bottom (newest-created first among those).
  // (Running previously sank to the bottom because its status isn't
  // "scheduled" — the opposite of what a roster wants to surface.)
  const tier = (t: TriggerRow["task"]) =>
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

// "By trigger" lens grouping: each trigger row becomes a first-class group
// header and claims the sessions it drives — the home conversation for inject
// triggers and loops (originating_conversation_id), the runs for
// spawn triggers (agent_task_id). Roster order is preserved (running → soonest
// fire → paused/event, exactly what partitionTriggerInbox sorted); the first
// row to claim a session keeps it. A trigger keeps its group even with zero
// sessions — the trigger is the citizen here, its work may not have run yet.
// Unclaimed sessions return as `rest` for the same project-group fallthrough
// the label/plan lenses use.
//
// opts.hidden: stashed/dismissed sessions a trigger may ALSO claim — a
// standing trigger's home conversation typically lives in the stash (that's
// the standing-loop workflow), and this lens exists precisely to show each
// trigger's work. Hidden sessions claimed here render as muted sub rows;
// hidden sessions no trigger claims never enter `rest` — they stay in their
// stashed/killed buckets.
export function groupSessionsByTrigger(
  rows: TriggerRow[],
  items: InboxSession[],
  opts: { hidden?: InboxSession[] } = {},
): {
  triggerGroups: Array<{ key: string; row: TriggerRow; items: InboxSession[] }>;
  rest: InboxSession[];
} {
  // Visible actives first in each pool walk, hidden appended after — so a
  // trigger with both shows its live work above its resting home.
  const pool = [...items, ...(opts.hidden ?? [])];
  const byId = new Map(pool.map((s) => [s._id, s]));
  const byTaskId = new Map<string, InboxSession[]>();
  for (const s of pool) {
    if (!s.agent_task_id) continue;
    let arr = byTaskId.get(s.agent_task_id);
    if (!arr) byTaskId.set(s.agent_task_id, (arr = []));
    arr.push(s);
  }
  const claimed = new Set<string>();
  const triggerGroups = rows.map((row) => {
    const members: InboxSession[] = [];
    const claim = (s: InboxSession | undefined) => {
      if (s && !claimed.has(s._id)) {
        claimed.add(s._id);
        members.push(s);
      }
    };
    const homeId = row.task.originating_conversation_id;
    if (homeId) {
      claim(byId.get(homeId));
    } else {
      for (const run of byTaskId.get(row.task._id) ?? []) claim(run);
      members.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    }
    return { key: row.task._id, row, items: members };
  });
  return { triggerGroups, rest: items.filter((s) => !claimed.has(s._id)) };
}
