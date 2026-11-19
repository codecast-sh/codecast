import { unreachableTerminalHoldReason } from "@codecast/shared/contracts/deliveryHold";
import { formatDuration } from "@codecast/shared/time";

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

export class RunLimitHoldError extends Error {
  readonly holdReason: string;
  readonly recheckMs = TERMINAL_HOLD_RECHECK_MS;
  constructor(maxRunMinutes: number, minutesLeft: number) {
    const reason = `this host reaches its ${formatDuration(maxRunMinutes * 60_000)} run limit in ${minutesLeft} min; held until it restarts`;
    super(reason);
    this.holdReason = reason;
  }
}

// A conversation whose agent this daemon cannot start blank (anything but
// Claude, with no transcript to resume and no registered session). Retrying on
// the failure ladder only spends the retry count every five minutes with no
// reason anyone can see (a Grok role start that failed held its launch prompt
// 461 times, 2026-11-19). Held with its reason instead; it goes out once the
// agent registers a session, or someone starts the conversation again.
export const BLANK_START_HOLD_RECHECK_MS = 5 * 60_000;

export class BlankStartHoldError extends Error {
  readonly holdReason: string;
  readonly recheckMs = BLANK_START_HOLD_RECHECK_MS;
  constructor(agent: string) {
    const reason = `no ${agent} session to resume on this machine; start the conversation again to send it`;
    super(reason);
    this.holdReason = reason;
  }
}
