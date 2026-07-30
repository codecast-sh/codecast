// Harness loop state, scraped from the message stream at ingest.
//
// Claude Code's /loop dynamic mode paces itself with a ScheduleWakeup tool
// call ("wake me in Ns") and the harness answers later with a system message
// (subtype "scheduled_task_fire"). That standing intent — "this session will
// act again on its own" — is exactly what the inbox trigger set models for
// agent_tasks, but it lives only in the transcript. deriveLoopState folds the
// stream into one conversation-level record so every trigger surface (dock,
// bars, strip) can treat a loop like an armed trigger without reading
// messages.
//
// State machine, driven by three events in timestamp order:
//   arm  (ScheduleWakeup with delaySeconds)  -> armed, wakeup_at = ts + delay
//   fire (system scheduled_task_fire)        -> waking (the loop turn runs)
//   stop (ScheduleWakeup with stop: true)    -> stopped (kept as a tombstone
//        so a replayed historical batch can't re-arm a finished loop)
//
// event_at is the monotonic guard: batches replaying older messages (backfill,
// re-sync) apply nothing.

export type LoopState = {
  status: "armed" | "waking" | "stopped";
  // Next scheduled fire (ms epoch) — meaningful while armed.
  wakeup_at: number;
  // When the wakeup was scheduled (the agent ended its turn here).
  armed_at: number;
  // Last wakeup fire, if one has happened.
  fired_at?: number;
  // Timestamp of the newest event applied — the replay guard.
  event_at: number;
  // The one-sentence reason the agent gave ScheduleWakeup ("watching CI run").
  reason?: string;
  // The /loop prompt the wakeup re-fires (trimmed; display only).
  prompt?: string;
};

type LoopMsg = {
  role: string;
  subtype?: string;
  timestamp?: number;
  tool_calls?: Array<{ name: string; input: string }>;
};

// Cheap gate so ordinary traffic never pays for the derivation.
export function batchHasLoopEvent(msgs: LoopMsg[]): boolean {
  return msgs.some(
    (m) =>
      (m.role === "system" && m.subtype === "scheduled_task_fire") ||
      (m.role === "assistant" && m.tool_calls?.some((tc) => tc.name === "ScheduleWakeup")),
  );
}

// The runtime clamps delays to [60, 3600]s; mirror it so a bogus input can't
// arm a wakeup years out.
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;

type LoopEvent =
  | { kind: "arm"; ts: number; delayMs: number; reason?: string; prompt?: string }
  | { kind: "fire"; ts: number }
  | { kind: "stop"; ts: number };

function eventsFrom(msgs: LoopMsg[], now: number): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (const m of msgs) {
    const ts = m.timestamp || now;
    if (m.role === "system" && m.subtype === "scheduled_task_fire") {
      events.push({ kind: "fire", ts });
      continue;
    }
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.name !== "ScheduleWakeup") continue;
      let input: { stop?: boolean; delaySeconds?: number; reason?: string; prompt?: string } = {};
      try {
        input = JSON.parse(tc.input || "{}");
      } catch {
        continue;
      }
      if (input.stop === true) {
        events.push({ kind: "stop", ts });
      } else if (typeof input.delaySeconds === "number" && isFinite(input.delaySeconds)) {
        const delayS = Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, input.delaySeconds));
        events.push({
          kind: "arm",
          ts,
          delayMs: delayS * 1000,
          reason: typeof input.reason === "string" ? input.reason.slice(0, 500) : undefined,
          prompt: typeof input.prompt === "string" ? input.prompt.slice(0, 4000) : undefined,
        });
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

// Fold a message batch into the conversation's loop state. Returns the next
// state, or undefined when the batch changes nothing (caller skips the patch).
export function deriveLoopState(
  prev: LoopState | undefined,
  msgs: LoopMsg[],
  now: number,
): LoopState | undefined {
  let state = prev;
  for (const ev of eventsFrom(msgs, now)) {
    if (state && ev.ts < state.event_at) continue; // replayed history
    if (ev.kind === "arm") {
      state = {
        status: "armed",
        wakeup_at: ev.ts + ev.delayMs,
        armed_at: ev.ts,
        fired_at: state?.fired_at,
        event_at: ev.ts,
        reason: ev.reason,
        prompt: ev.prompt,
      };
    } else if (ev.kind === "fire") {
      // A fire with no prior record still proves a loop exists (old sessions
      // synced mid-loop): seed from the fire itself.
      state = {
        status: "waking",
        wakeup_at: state?.wakeup_at ?? ev.ts,
        armed_at: state?.armed_at ?? ev.ts,
        fired_at: ev.ts,
        event_at: ev.ts,
        reason: state?.reason,
        prompt: state?.prompt,
      };
    } else {
      if (!state) continue; // stop without a loop: nothing to record
      state = { ...state, status: "stopped", event_at: ev.ts };
    }
  }
  if (!state || state === prev) return undefined;
  if (prev && JSON.stringify(state) === JSON.stringify(prev)) return undefined;
  return state;
}
