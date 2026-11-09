import { unreachableTerminalHoldReason } from "@codecast/shared/contracts/deliveryHold";

// A live agent whose terminal has no way for the daemon to type into it (a
// plain Alacritty window: daemon.ts TMUX_ONLY_TERMINALS; a Ghostty whose
// AppleScript is out of reach). No retry can reach it, and the agent is the
// person's own process, so the message is held with a reason the sender sees,
// never counted as a failed attempt. It goes out once the terminal can be
// typed into, or the process exits and the next attempt resumes it in tmux.
export const TERMINAL_HOLD_RECHECK_MS = 60_000;

export class TerminalHoldError extends Error {
  readonly holdReason: string;
  readonly recheckMs = TERMINAL_HOLD_RECHECK_MS;
  constructor(readonly terminalLabel: string, hint?: string | null) {
    const reason = unreachableTerminalHoldReason(terminalLabel, hint);
    super(reason);
    this.holdReason = reason;
  }
}
