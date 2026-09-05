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
