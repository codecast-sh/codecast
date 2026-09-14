// The daemon's answer to a web Escape: interrupt the live turn, or skip and say why.
//
// The web forwards every Escape pressed in an empty composer, stamped with the
// press time, and shows the "user interrupted" line at once. It no longer
// judges whether the agent is mid-turn: its copy of the live status is a
// windowed overlay that goes stale, and a press it dropped on a stale "idle"
// never reached the agent at all. The daemon holds the facts, so the daemon
// decides.
//
// Two facts decide it:
// - Did a message reach the agent AFTER the press? On 2026-08-28 a message was
//   pending when the user pressed Escape; the daemon pasted it, and the Escape
//   arrived 400ms later and cancelled the turn the paste had just started. The
//   injection time is the daemon's own clock, so the comparison is exact.
// - Is there a turn to interrupt? A SIGINT at claude's idle prompt exits the
//   process, and a double Escape at an idle pane opens the Rewind dialog, so
//   nothing is sent unless a turn is provably running.

import { MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";

// A press older than this is a leftover: a parked command from a closed laptop,
// a row an offline owner picks up hours later. Whatever it meant to stop is over.
export const ESCAPE_PRESS_MAX_AGE_MS = 60_000;

export type EscapeSkipReason = "stale_press" | "message_injected_after_press" | "no_active_turn";

export type EscapeVerdict =
  | { action: "interrupt" }
  | { action: "skip"; reason: EscapeSkipReason };

export function decideEscape(input: {
  /** Client clock at the press; absent from older clients and the CLI. */
  pressedAt: number | null | undefined;
  now: number;
  /** Daemon clock at the newest delivery into this conversation (paste or app-server turn start). */
  lastInjectedAt: number | null | undefined;
  turnActive: boolean;
}): EscapeVerdict {
  if (typeof input.pressedAt === "number") {
    if (input.now - input.pressedAt > ESCAPE_PRESS_MAX_AGE_MS) return { action: "skip", reason: "stale_press" };
    if (typeof input.lastInjectedAt === "number" && input.lastInjectedAt > input.pressedAt) {
      return { action: "skip", reason: "message_injected_after_press" };
    }
  }
  if (!input.turnActive) return { action: "skip", reason: "no_active_turn" };
  return { action: "interrupt" };
}

// Whether a tmux-hosted agent has a turn running. Either witness is enough:
// the pane showing a spinner, or the hook status naming a turn in progress
// (which is what says a permission prompt is INSIDE a turn). The pane never
// vetoes a mid-turn hook: the text classifier only knows the shapes it has
// seen, and on 2026-09-14 it read a running turn's composer as idle while the
// hook said working, so a user's Escape was skipped. A stale "working" with
// a truly idle pane costs a double Escape at the prompt, which opens the
// Rewind dialog the delivery path already cancels before its next paste. Only
// an exited pane vetoes: there is no process left to interrupt.
export function turnLooksActive(hookStatus: string | null | undefined, paneState: string | null | undefined): boolean {
  if (paneState === "exited") return false;
  if (paneState === "busy") return true;
  return MID_TURN_AGENT_STATUSES.has(hookStatus ?? "");
}
