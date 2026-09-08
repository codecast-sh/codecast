// A machine message the daemon refused to paste because the terminal was
// waiting for a human (a menu, a confirmation) is HELD, not failed. It keeps
// its retry budget, the conversation is skipped by the delivery scans for a
// short while (a re-pended row re-fires the subscription at once, and every
// attempt costs a claim and a pane capture), and the moment the prompt closes
// the hold is released and the pending scan runs again. Before this, each
// refusal counted as a failed attempt: ten of them in seven minutes marked a
// cast send undeliverable, and it sat for 49 minutes (2026-09-08).
// Wide enough that a dialog left open costs one refused attempt (a claim, a
// capture and a pre-paste mark) per window; a closed prompt releases at once.
export const PROMPT_HOLD_MS = 45_000;

const holds = new Map<string, number>();
let redrive: (() => void) | null = null;

// The delivery scan to run when a hold is released; the daemon installs its
// pending poll here.
export function setPendingRedrive(fn: (() => void) | null): void {
  redrive = fn;
}

export function holdConversationForPrompt(conversationId: string, now: number = Date.now()): void {
  holds.set(conversationId, now);
}

// Milliseconds a scan should still skip this conversation; 0 when it may try
// again (an expired hold is forgotten here, so a real prompt that stays open
// costs one refused attempt per hold window, never a spent budget).
export function promptHoldRemainingMs(conversationId: string, now: number = Date.now()): number {
  const heldAt = holds.get(conversationId);
  if (heldAt === undefined) return 0;
  const remaining = PROMPT_HOLD_MS - (now - heldAt);
  if (remaining <= 0) {
    holds.delete(conversationId);
    return 0;
  }
  return remaining;
}

// The prompt closed (answered from the app, dismissed in the terminal): drop
// the hold and re-drive delivery now instead of waiting for the next poll.
export function releasePromptHold(conversationId: string): boolean {
  if (!holds.delete(conversationId)) return false;
  redrive?.();
  return true;
}

export function clearPromptHolds(): void {
  holds.clear();
}
