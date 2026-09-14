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

// `humans`: a person's typed message was refused too. Most prompts take a
// typed message as their answer (an AskUserQuestion menu is declined and the
// text typed at the prompt), so a hold normally lets human messages through.
// A dialog no text can answer (an unnumbered select list) refuses them as
// well, and without the hold each refusal re-pends the row, which re-fires the
// subscription at once: a tight loop of claims and captures.
const holds = new Map<string, { at: number; humans: boolean }>();
let redrive: (() => void) | null = null;

// The delivery scan to run when a hold is released; the daemon installs its
// pending poll here.
export function setPendingRedrive(fn: (() => void) | null): void {
  redrive = fn;
}

export function holdConversationForPrompt(conversationId: string, opts: { humans?: boolean } = {}, now: number = Date.now()): void {
  const live = promptHoldRemainingMs(conversationId, false, now) > 0 ? holds.get(conversationId) : undefined;
  holds.set(conversationId, { at: now, humans: !!opts.humans || !!live?.humans });
}

// Milliseconds a scan should still skip this conversation; 0 when it may try
// again (an expired hold is forgotten here, so a real prompt that stays open
// costs one refused attempt per hold window, never a spent budget). `human`
// asks for a person's message, which only a hold that refused one skips.
export function promptHoldRemainingMs(conversationId: string, human = false, now: number = Date.now()): number {
  const hold = holds.get(conversationId);
  if (hold === undefined) return 0;
  const remaining = PROMPT_HOLD_MS - (now - hold.at);
  if (remaining <= 0) {
    holds.delete(conversationId);
    return 0;
  }
  return human && !hold.humans ? 0 : remaining;
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
