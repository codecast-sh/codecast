// Where a usage-limit park stands, read from what the owner machine recorded.
// A park is not a failure when the machine recovers it: the loop (or a person)
// switches accounts or continues on one with room, the session restarts, the
// "continue" lands, and the agent picks up. The park card walks those steps so
// the minute of restart reads as progress rather than as a stuck error.

import type { RecoveryDecision } from "@codecast/shared/contracts";

// The park's timestamp is the transcript's; the server stamps the park when the
// daemon reports it, a beat later, and only then can a recovery act on it.
const SKEW_MS = 5_000;
// How long after a park a recovery still counts as ITS recovery once the
// session has moved on. The device keeps one decision record, so a later park
// in the same thread takes it over; an old card claims only what happened
// shortly after it and otherwise just says the session continued.
export const RESUMED_MATCH_MS = 30 * 60_000;

export type LimitRecoveryAction = {
  kind: "switch" | "continue";
  // The account the session continues on (profile name, else email).
  target?: string;
  by: "auto" | "you";
  at: number;
};

export type LimitRecoveryPhase =
  | { phase: "parked" }
  | { phase: "recovering"; action: LimitRecoveryAction; step: "moving" | "resuming" }
  | { phase: "resumed"; action: LimitRecoveryAction }
  | { phase: "moved_on" };

export function limitRecoveryAction(input: {
  parkedAt?: number;
  lastAction?: string;
  lastActionAt?: number;
  decision?: RecoveryDecision | null;
  // A revive this browser asked for, before the server's record of it arrives.
  localRequestAt?: number;
  localTarget?: string;
}): LimitRecoveryAction | null {
  const { parkedAt, lastAction, lastActionAt, decision } = input;
  if (parkedAt == null) return null;
  if (lastActionAt != null && lastAction && lastActionAt >= parkedAt - SKEW_MS) {
    const recorded = decision && decision.at === lastActionAt && (decision.kind === "switch" || decision.kind === "continue")
      ? decision
      : null;
    const switchedTo = lastAction.startsWith("switch:") ? lastAction.slice("switch:".length) : undefined;
    return {
      kind: recorded ? (recorded.kind as "switch" | "continue") : switchedTo ? "switch" : "continue",
      target: recorded?.target_name ?? recorded?.target_email ?? switchedTo,
      by: lastAction === "manual" ? "you" : "auto",
      at: lastActionAt,
    };
  }
  if (input.localRequestAt != null && input.localRequestAt >= parkedAt) {
    return { kind: input.localTarget ? "switch" : "continue", target: input.localTarget, by: "you", at: input.localRequestAt };
  }
  return null;
}

export function limitRecoveryPhase(input: {
  // The park is still in force (see useApiErrorLive).
  live: boolean;
  parkedAt?: number;
  action: LimitRecoveryAction | null;
  // The recovery's "continue" reached the restarted session.
  continueDelivered?: boolean;
}): LimitRecoveryPhase {
  const { live, parkedAt, action } = input;
  if (!live) {
    return action && parkedAt != null && action.at - parkedAt <= RESUMED_MATCH_MS
      ? { phase: "resumed", action }
      : { phase: "moved_on" };
  }
  if (!action) return { phase: "parked" };
  return { phase: "recovering", action, step: input.continueDelivered ? "resuming" : "moving" };
}
