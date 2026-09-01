// A session sleeping on a harness ScheduleWakeup (/loop) — the conversation's
// denormalized loop_state, derived from messages at ingest (convex/messages.ts
// deriveLoopState) so every surface can see the armed wake without reading
// messages. The same "a machine will act here on its own" axis as an armed
// trigger, and classified the same way: an armed, fresh loop parks its session
// dormant; a dead harness (overdue wakeup, waking turn that never ended) must
// NOT — the wake it promises is never coming, so the row surfaces instead.
//
// PURE isomorphic data — consumed by Convex (classifier), the web (trigger
// roster pseudo rows + absorption) and the CLI.

export type LoopState = {
  status: "armed" | "waking" | "stopped";
  /** When the armed wakeup fires (ms). */
  wakeup_at: number;
  /** When the loop armed this wakeup. */
  armed_at: number;
  /** When the last wakeup fired (waking only). */
  fired_at?: number;
  /** Latest loop event of any kind — the freshness reference. */
  event_at: number;
  /** The agent's one-line reason for the chosen delay. */
  reason?: string;
  /** The /loop prompt the wakeup re-fires. */
  prompt?: string;
};

// An armed wakeup whose fire time passed this long ago is a dead harness (the
// fire lands within seconds normally) — the loop is no longer a live standing
// intent.
export const LOOP_OVERDUE_GRACE_MS = 15 * 60_000;
// A wakeup turn that hasn't re-armed or stopped within this window ended
// without telling us (session killed mid-turn) — stop treating it as live.
export const LOOP_WAKING_TTL_MS = 30 * 60_000;

/** Is this loop still a live standing intent at `now`? */
export function isLoopFresh(loop: Pick<LoopState, "status" | "wakeup_at" | "fired_at" | "event_at">, now: number): boolean {
  if (loop.status === "stopped") return false;
  return loop.status === "waking"
    ? now - (loop.fired_at ?? loop.event_at) < LOOP_WAKING_TTL_MS
    : loop.wakeup_at > now - LOOP_OVERDUE_GRACE_MS;
}
