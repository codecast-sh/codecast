import type { Id } from "./_generated/dataModel";

type DbCtx = { db: any };

export type PendingMessageDeliveryAllocation = {
  protocolVersion: number;
  deliveryId: string;
  conversationSequence: number;
  executionEpoch: number;
};

export type PendingMessageInsertFields = {
  conversationId: Id<"conversations">;
  fromUserId: Id<"users">;
  ownerUserId: Id<"users">;
  fromConversationId?: Id<"conversations">;
  content: string;
  imageStorageId?: Id<"_storage">;
  imageStorageIds?: Id<"_storage">[];
  clientId?: string;
  origin?: "scheduler";
  createdAt: number;
};

export class PendingMessageWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PendingMessageWriteError";
  }
}

function fail(code: string, message: string): never {
  throw new PendingMessageWriteError(code, message);
}

function requireCanonicalId(value: string | undefined, field: string): string {
  if (!value?.trim() || value !== value.trim()) {
    fail("INVALID_PENDING_MESSAGE_ID", `${field} must be non-empty canonical text`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_PENDING_MESSAGE_DELIVERY", `${field} must be a positive safe integer`);
  }
}

function validateDelivery(
  clientId: string | undefined,
  delivery: PendingMessageDeliveryAllocation,
): void {
  const canonicalClientId = requireCanonicalId(clientId, "clientId");
  requireCanonicalId(delivery.deliveryId, "deliveryId");
  if (delivery.deliveryId !== canonicalClientId) {
    fail(
      "PENDING_MESSAGE_DELIVERY_ID_MISMATCH",
      "deliveryId must be the caller-stable clientId",
    );
  }
  requirePositiveSafeInteger(delivery.protocolVersion, "protocolVersion");
  requirePositiveSafeInteger(delivery.conversationSequence, "conversationSequence");
  requirePositiveSafeInteger(delivery.executionEpoch, "executionEpoch");
}

async function insertPendingMessageRow(
  ctx: DbCtx,
  fields: PendingMessageInsertFields,
  delivery?: PendingMessageDeliveryAllocation,
  resendOfDeliveryId?: string,
): Promise<Id<"pending_messages">> {
  if (delivery) validateDelivery(fields.clientId, delivery);
  if (resendOfDeliveryId !== undefined) {
    const originalDeliveryId = requireCanonicalId(
      resendOfDeliveryId,
      "resendOfDeliveryId",
    );
    const clientId = requireCanonicalId(fields.clientId, "clientId");
    if (!delivery) {
      fail(
        "RISK_RESEND_REQUIRES_FENCED_DELIVERY",
        "risk-bearing resend must include a fenced delivery allocation",
      );
    }
    if (clientId === originalDeliveryId) {
      fail(
        "RISK_RESEND_REQUIRES_NEW_ID",
        "risk-bearing resend must use a new logical delivery id",
      );
    }
  }

  return await ctx.db.insert("pending_messages", {
    conversation_id: fields.conversationId,
    from_user_id: fields.fromUserId,
    owner_user_id: fields.ownerUserId,
    from_conversation_id: fields.fromConversationId,
    content: fields.content,
    image_storage_id: fields.imageStorageId,
    image_storage_ids: fields.imageStorageIds,
    client_id: fields.clientId,
    origin: fields.origin,
    status: "pending" as const,
    created_at: fields.createdAt,
    retry_count: 0,
    ...(delivery
      ? {
          delivery_protocol_version: delivery.protocolVersion,
          delivery_id: delivery.deliveryId,
          conversation_sequence: delivery.conversationSequence,
          execution_epoch: delivery.executionEpoch,
          delivery_status: "pending" as const,
        }
      : {}),
    ...(resendOfDeliveryId !== undefined
      ? { resend_of_delivery_id: resendOfDeliveryId }
      : {}),
  });
}

/**
 * The DELIVERY-side twin of the enqueue wake-up rules (pendingMessages'
 * enqueuePendingMessage): if the system is injecting a message into a
 * conversation, that conversation is alive, whatever its inbox flags still say.
 *
 * Without this a message that outlived a kill — a leftover legacy row, or a
 * fenced delivery the kill could not cancel — lands in the pane and runs the
 * session while the row still carries inbox_killed_at. The record then
 * contradicts reality, and (since classifyWorkState now reads a killed row as
 * "idle") it does so INVISIBLY: a session busily working while the inbox files
 * it as retired. Record follows reality.
 *
 * Deliberately does NOT clear inbox_stashed_at: stash means "keep working out of
 * my sight", so delivering into a stashed session is its intended behavior and
 * must not drag it back into the active inbox (mirrors enqueue's machine-wake
 * rule). Lives here, not in pendingMessages, so both the legacy status path and
 * the fenced delivery path (executionBindings) can call it without an import
 * cycle.
 */
export async function reviveConversationOnDelivery(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
): Promise<boolean> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return false;
  const revive: Record<string, unknown> = {};
  if (conversation.inbox_killed_at) revive.inbox_killed_at = undefined;
  if (conversation.inbox_dismissed_at) revive.inbox_dismissed_at = undefined;
  if (conversation.status === "completed") revive.status = "active";
  if (Object.keys(revive).length === 0) return false;
  await ctx.db.patch(conversationId, revive);
  return true;
}

/** The sole raw insertion path for a newly admitted product/legacy message. */
export async function insertEnqueuedPendingMessage(
  ctx: DbCtx,
  fields: PendingMessageInsertFields & {
    delivery?: PendingMessageDeliveryAllocation;
  },
): Promise<Id<"pending_messages">> {
  return await insertPendingMessageRow(ctx, fields, fields.delivery);
}

/** The sole raw insertion path for an explicitly accepted ambiguity-risk resend. */
export async function insertRiskResendPendingMessage(
  ctx: DbCtx,
  fields: PendingMessageInsertFields & {
    clientId: string;
    delivery: PendingMessageDeliveryAllocation;
    resendOfDeliveryId: string;
  },
): Promise<Id<"pending_messages">> {
  return await insertPendingMessageRow(
    ctx,
    fields,
    fields.delivery,
    fields.resendOfDeliveryId,
  );
}
