export class PendingDeliveryHeldError extends Error {
  constructor() {
    super("Pending message is no longer admitted for delivery");
  }
}

export async function requirePendingDeliveryAdmission(
  syncService: { claimPendingMessageForDelivery(messageId: string, conversationId?: string): Promise<unknown> },
  messageId: string,
  conversationId: string,
): Promise<void> {
  if (!await syncService.claimPendingMessageForDelivery(messageId, conversationId)) throw new PendingDeliveryHeldError();
}

/**
 * One admission per delivery attempt. The claim admits only a row still
 * "pending", and every injection path marks the row "injected" before it
 * pastes; so a path that fails after its own mark (a terminal with no
 * reachable tty, then the auto-resume fallback) was refused by its own fallback
 * and the message sat until the stale-injected healer re-pended it — the
 * human's decision reply to a session looped that way for hours on
 * 2026-09-07. A successful claim stands for the whole attempt; a refused one is
 * asked again, so a genuine cancellation is still honored.
 */
export function createDeliveryAdmission(
  syncService: { claimPendingMessageForDelivery(messageId: string, conversationId?: string): Promise<unknown> },
  messageId: string,
  conversationId: string,
): () => Promise<void> {
  let admitted = false;
  return async () => {
    if (admitted) return;
    await requirePendingDeliveryAdmission(syncService, messageId, conversationId);
    admitted = true;
  };
}
