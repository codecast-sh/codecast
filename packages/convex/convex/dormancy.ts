// The server-side view of "which of this user's sessions is the home of an
// armed inject trigger" — the structural dormancy source that classifyWorkState
// cannot see from the conversation row alone. One indexed read per armed
// status per user, cached by the caller for the life of a query, so a 200-row
// inbox pays three small reads rather than one per row.
//
// The rule mirrors the web's partitionTriggerInbox absorption (triggerTasks.ts):
// a trigger that injects into a session (has an originating_conversation_id),
// armed (scheduled / running / paused), whose last run neither failed nor
// flagged attention. Failed / flagged runs are exactly the "parked but
// something warrants input" case, so they surface the home instead of parking
// it. Standing loops (recurring / event) and `once` follow-ups park with
// different strength — see ArmedTriggerHomes — so the loader keeps them apart.
import { isLoopFresh, isMachineDeliveredMessage } from "@codecast/shared/contracts";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const ARMED_TRIGGER_STATUSES = ["scheduled", "running", "paused"] as const;

type InjectTriggerTask = {
  originating_conversation_id?: Id<"conversations"> | null;
  schedule_type: string;
  status: string;
  last_run_failed?: boolean | null;
  last_run_needs_attention?: boolean | null;
};

export function isArmedInjectTrigger(task: InjectTriggerTask): boolean {
  if (!task.originating_conversation_id) return false;
  if (!(ARMED_TRIGGER_STATUSES as readonly string[]).includes(task.status)) return false;
  if (task.last_run_failed || task.last_run_needs_attention) return false;
  return true;
}

export function isStandingInjectTrigger(task: InjectTriggerTask): boolean {
  if (task.schedule_type !== "recurring" && task.schedule_type !== "event") return false;
  return isArmedInjectTrigger(task);
}

// Two strengths of park, keyed by what the wake promises:
//   standing — a recurring / event loop drives the session; the machine owns
//              it outright, so the home parks over EVERY rest verdict.
//   once     — a single armed follow-up. It names the next actor only when the
//              session has nothing left for the human, so it demotes a `done`
//              rest to dormant and never touches needs_input (a reminder must
//              not hide an open ask). classifyWorkState applies that split.
export interface ArmedTriggerHomes {
  standing: Set<string>;
  once: Set<string>;
}

export async function loadArmedTriggerHomes(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<ArmedTriggerHomes> {
  const homes: ArmedTriggerHomes = { standing: new Set(), once: new Set() };
  for (const status of ARMED_TRIGGER_STATUSES) {
    const tasks = await ctx.db
      .query("agent_tasks")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", status))
      .collect();
    for (const task of tasks) {
      if (!isArmedInjectTrigger(task)) continue;
      const bucket = isStandingInjectTrigger(task) ? homes.standing : homes.once;
      bucket.add(task.originating_conversation_id!.toString());
    }
  }
  return homes;
}

// The last user turn was delivered by machinery — another session's cast send,
// a trigger injection, a task notification, an agent-team teammate — rather
// than typed by the human. The SHARED isMachineDeliveredMessage, applied to
// the row's last_message_preview (its checks key off opening tags, so a
// truncated preview matches). A human who spoke last is triaging the session,
// so an armed-trigger home with a human turn on top classifies like any other
// conversation instead of parking.
export function isMachineDeliveredPreview(preview: string | null | undefined): boolean {
  return isMachineDeliveredMessage(preview);
}

// The classifier's armed-trigger input for one row: its home is armed AND the
// machine delivered its last user turn (or it has none). last_message_preview
// is written only for user-role messages (messages.ts), so it IS the last user
// message whatever the agent said afterwards — the same field the web reads
// as last_user_message.
export function isArmedTriggerHome(
  conv: { _id: { toString(): string }; last_message_preview?: string | null },
  armedHomes: Set<string>,
): boolean {
  if (!armedHomes.has(conv._id.toString())) return false;
  return lastTurnAllowsPark(conv);
}

// The machine-delivered-last-turn half of isArmedTriggerHome, shared with the
// denormalized path below.
export function lastTurnAllowsPark(conv: { last_message_preview?: string | null }): boolean {
  return !conv.last_message_preview || isMachineDeliveredPreview(conv.last_message_preview);
}

// ── Denormalized armed state (conversations.armed_trigger_kind) ─────────────
//
// The inbox projection must stamp every row with zero extra reads, so the
// answer loadArmedTriggerHomes computes from agent_tasks is written onto the
// conversation row whenever a trigger is armed, paused, resumed, completed,
// cancelled or failed (agentTasks.refreshArmedTriggerKind). A semantic field:
// it rides the sync log and the base list for free.
export const ARMED_TRIGGER_KINDS = ["none", "standing", "once"] as const;
export type ArmedTriggerKind = (typeof ARMED_TRIGGER_KINDS)[number];

// The kind for one conversation given every agent_tasks row that injects into
// it. Standing wins over once: a recurring loop owns the session outright.
export function armedTriggerKindFor(tasks: InjectTriggerTask[]): ArmedTriggerKind {
  let kind: ArmedTriggerKind = "none";
  for (const task of tasks) {
    if (!isArmedInjectTrigger(task)) continue;
    if (isStandingInjectTrigger(task)) return "standing";
    kind = "once";
  }
  return kind;
}

// isArmedTriggerHome over the row's own denormalized field instead of a loaded
// set — same last-turn rule, no reads.
export function isArmedTriggerHomeOfKind(
  conv: { armed_trigger_kind?: string | null; last_message_preview?: string | null },
  kind: Exclude<ArmedTriggerKind, "none">,
): boolean {
  if ((conv.armed_trigger_kind ?? "none") !== kind) return false;
  return lastTurnAllowsPark(conv);
}

// Per-query memo over loadArmedTriggerHomes for callers that classify rows
// belonging to several users (the team feed).
export function armedTriggerHomeLoader(ctx: Pick<QueryCtx, "db">) {
  const cache = new Map<string, Promise<ArmedTriggerHomes>>();
  return (userId: Id<"users">): Promise<ArmedTriggerHomes> => {
    const key = userId.toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = loadArmedTriggerHomes(ctx, userId);
      cache.set(key, hit);
    }
    return hit;
  };
}

// ── Armed /loop wakeup (conversations.loop_state) ───────────────────────────
// The third structural dormancy source, after armed inject triggers and open
// background tasks: a session sleeping on a harness ScheduleWakeup. The
// denormalized loop_state rides the row (derived at message ingest), so this
// is zero extra reads — same contract as armed_trigger_kind. Standing
// strength: the loop owns the session's cadence. The same last-turn rule
// applies — a human who spoke last is triaging the session, so it classifies
// normally even while the wakeup stays armed. Only a FRESH "armed" parks:
// "waking" is the machine's own turn in flight (the active arms classify it),
// and an overdue wakeup is a dead harness whose promise must not hide the row.
export function isArmedLoopHome(
  conv: {
    loop_state?: { status: string; wakeup_at: number; fired_at?: number | null; event_at: number } | null;
    last_message_preview?: string | null;
  },
  now: number,
): boolean {
  const loop = conv.loop_state;
  if (!loop || loop.status !== "armed") return false;
  if (!isLoopFresh({ status: "armed", wakeup_at: loop.wakeup_at, fired_at: loop.fired_at ?? undefined, event_at: loop.event_at }, now)) return false;
  return lastTurnAllowsPark(conv);
}
