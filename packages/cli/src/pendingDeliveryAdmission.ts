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
 * Asked before every injection of one delivery attempt. The claim admits only
 * a row still "pending", and every injection path marks the row "injected"
 * before it pastes; so a path that fails after its own mark (a terminal with
 * no reachable tty, then the auto-resume fallback) was refused by its own
 * fallback and the message sat until the stale-injected healer re-pended it
 * (2026-09-07). Once this attempt has marked the row (`markedThisAttempt`),
 * the earlier claim stands. Until then each injection asks again, so a cancel
 * made after the daemon fetched the row, while it resolved a pane or resumed
 * the session, stops the paste instead of losing to it (ct-98180).
 */
export function createDeliveryAdmission(
  syncService: { claimPendingMessageForDelivery(messageId: string, conversationId?: string): Promise<unknown> },
  messageId: string,
  conversationId: string,
  markedThisAttempt: () => boolean,
): () => Promise<void> {
  let admitted = false;
  return async () => {
    if (admitted && markedThisAttempt()) return;
    await requirePendingDeliveryAdmission(syncService, messageId, conversationId);
    admitted = true;
  };
}
