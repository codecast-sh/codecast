// Where a plan stands, derived from the sessions working on it.
//
// A plan's own status is a person's last word and drifts in both directions:
// drafts carry the most active work, and a plan marked done still has sessions
// waiting on someone. The plan's current_session_id is whoever bound last. So
// the state reads the sessions whose own binding is the plan (their work
// state and when it last changed) and uses the plan's status only to close it.
// Edits and comments on its tasks are not movement.

import type { WorkState } from "../contracts/workState";

export const PLAN_STATES = ["needs_you", "moving", "parked", "finished", "stalled", "closed"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** A session bound to the plan: its work state and the event stamp of that
 *  state (when it started waiting, last worked, parked, or delivered). */
export interface PlanMember {
  id: string;
  work_state: WorkState;
  at: number;
}

export interface PlanFacts {
  status?: string | null;
  progress?: { done?: number; total?: number } | null;
}

export interface PlanStanding {
  state: PlanState;
  /** Sessions waiting on a person, oldest wait first. */
  asks: string[];
  /** When the oldest of them started waiting. */
  askedAt: number | null;
  /** The newest event on any member. */
  movedAt: number | null;
}

/** A member that took a turn this recently still counts as moving. */
export const PLAN_MOVING_MS = 24 * 3600_000;

const CLOSED = new Set(["done", "abandoned"]);

export function derivePlanState(plan: PlanFacts | null | undefined, members: readonly PlanMember[], now: number): PlanStanding {
  const waiting = members.filter((m) => m.work_state === "needs_input").sort((a, b) => a.at - b.at);
  const movedAt = members.length ? Math.max(...members.map((m) => m.at)) : null;
  const base = { asks: waiting.map((m) => m.id), askedAt: waiting[0]?.at ?? null, movedAt };
  const closed = CLOSED.has(plan?.status ?? "");
  if (waiting.length) return { ...base, state: "needs_you" };
  if (members.some((m) => m.work_state === "working")) return { ...base, state: "moving" };
  // A parked member names a machine wake: the plan's next move is that wake's,
  // however recently it last moved.
  if (members.some((m) => m.work_state === "dormant")) return { ...base, state: "parked" };
  if (!closed && movedAt !== null && now - movedAt < PLAN_MOVING_MS) return { ...base, state: "moving" };
  if (closed) return { ...base, state: "closed" };
  const total = plan?.progress?.total ?? 0;
  if (total > 0 && (plan?.progress?.done ?? 0) >= total) return { ...base, state: "finished" };
  return { ...base, state: "stalled" };
}

/** Order for a list of plans: the ones waiting on a person first. */
export const PLAN_STATE_RANK: Record<PlanState, number> = Object.fromEntries(PLAN_STATES.map((s, i) => [s, i])) as Record<PlanState, number>;
