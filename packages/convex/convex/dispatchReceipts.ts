// The durable command receipt a dispatch action can carry: the envelope the
// web wraps a local result in, the actions whose server write the receipt
// owns, the continuation a receipt-backed create may run, and the create
// itself run through runLocalCommand so a retry returns the first result.

import type { Id } from "./_generated/dataModel";
import { runLocalCommand } from "./localFirstCommands";

export type ReceiptActionEnvelope = {
  receiptActionVersion: 1;
  commandId: string;
  localResult?: unknown;
};

export function receiptCommandId(action: string, result: unknown): string {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  if (
    envelope?.receiptActionVersion !== 1 ||
    typeof envelope.commandId !== "string" ||
    !envelope.commandId
  ) {
    throw new Error(`${action} requires a durable command receipt id`);
  }
  return envelope.commandId;
}

export function hasReceiptCommandId(result: unknown): result is ReceiptActionEnvelope {
  const envelope = result as Partial<ReceiptActionEnvelope> | null;
  return envelope?.receiptActionVersion === 1 &&
    typeof envelope.commandId === "string" &&
    envelope.commandId.length > 0;
}

export const RECEIPT_OWNS_SERVER_WRITE = new Set([
  "createBucket",
  "updateBucket",
  "assignSessionToBucket",
  "addComment",
  "editComment",
  "deleteComment",
  "askAgentInThread",
  "sendMessage",
]);

export function receiptLocalResult<T>(result: unknown): T {
  return (hasReceiptCommandId(result)
    ? result.localResult
    : result) as T;
}

export function receiptOrLegacyCommandId(
  action: string,
  result: unknown,
  legacyCommandId: string,
): string {
  if (hasReceiptCommandId(result)) return receiptCommandId(action, result);
  const payload = result as { commandId?: unknown } | null;
  return typeof payload?.commandId === "string" && payload.commandId
    ? payload.commandId
    : legacyCommandId;
}

type DurableCreateContinuation =
  | { version: 1; kind: "navigate" }
  | { version: 1; kind: "assignBucket"; conversationIds: string[] }
  // A project created from a goal's sheet lands under that goal in the same
  // transaction as the create, so the goal never lists a project that failed.
  | { version: 1; kind: "attachToInitiative"; initiativeId: string };

export function validatedCreateContinuation(
  action: string,
  result: unknown,
): DurableCreateContinuation | null {
  if (!hasReceiptCommandId(result)) return null;
  const localResult = result.localResult;
  if (!localResult || typeof localResult !== "object") return null;
  const raw = (localResult as { continuation?: unknown }).continuation;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid ${action} continuation`);
  }
  const continuation = raw as Record<string, unknown>;
  if (
    continuation.version === 1 &&
    continuation.kind === "navigate" &&
    (action === "createDoc" ||
      action === "createPlan" ||
      action === "createProject")
  ) {
    return { version: 1, kind: "navigate" };
  }
  if (
    continuation.version === 1 &&
    continuation.kind === "assignBucket" &&
    action === "createBucket" &&
    Array.isArray(continuation.conversationIds) &&
    continuation.conversationIds.length > 0 &&
    continuation.conversationIds.length <= 100 &&
    continuation.conversationIds.every(
      (id) => typeof id === "string" && id.length > 0,
    )
  ) {
    return {
      version: 1,
      kind: "assignBucket",
      conversationIds: [...new Set(continuation.conversationIds as string[])],
    };
  }
  if (
    continuation.version === 1 &&
    continuation.kind === "attachToInitiative" &&
    action === "createProject" &&
    typeof continuation.initiativeId === "string" &&
    continuation.initiativeId.length > 0
  ) {
    return { version: 1, kind: "attachToInitiative", initiativeId: continuation.initiativeId };
  }
  throw new Error(`Invalid ${action} continuation`);
}

export async function runReceiptBackedCreate(
  ctx: { db: any },
  userId: Id<"users">,
  input: {
    action: string;
    commandName: string;
    arguments: unknown;
    result: unknown;
    create: () => Promise<unknown>;
  },
) {
  return await runLocalCommand(ctx as any, {
    principalId: userId,
    commandId: receiptCommandId(input.action, input.result),
    commandName: input.commandName,
    arguments: input.arguments,
  }, async () => ({
    status: "acknowledged",
    result: await input.create(),
    // Docs/plans/projects still use their legacy paginated sync surfaces. The
    // receipt provides exact create dedupe/result recovery; those lists do not
    // yet expose a revision or command-id coverage contract to name here.
    coverageViews: [],
  }));
}
