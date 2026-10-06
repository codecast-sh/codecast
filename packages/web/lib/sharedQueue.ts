// The shared queue as the web reads it: every message waiting to go into a
// session, from whoever sent it, in the order the session will take them.
// The rows live in one place, the conversation's pending status row
// (pendingMessageStatus[convId].inflight, from getConversationPendingMessage);
// these are pure reads and the optimistic edits the store's reorder and
// merge actions make on the draft, the same rules the server applies
// (convex/lib/sessionQueue, pendingMessages.mergeQueuedForUser).
import { formatJointMessage, jointPartsOf, type JointPart } from "@codecast/shared/contracts/jointMessage";
import { isWaitingInQueue, queueAtBefore, queueOrder } from "@codecast/convex/convex/lib/sessionQueue";

export type QueueRow = {
  message_id: string;
  client_id?: string;
  created_at: number;
  queue_at?: number;
  status: string;
  delivery_status?: string;
  content: string;
  from_user_id?: string;
  from_name?: string;
  from_image?: string;
};

const asQueueRow = (r: QueueRow) => ({ ...r, _id: r.message_id });

/** The rows still in line (in order), from a pending status row. */
export function queueRowsOf(status: { inflight?: QueueRow[] } | null | undefined): QueueRow[] {
  return (status?.inflight ?? []).filter((r) => r.status !== "cancelled" && r.status !== "delivered");
}

/** Whether a row can still be moved or merged: waiting, not being handed to the session. */
export function canSteer(row: QueueRow): boolean {
  return isWaitingInQueue(asQueueRow(row));
}

/** The queue with one row moved directly before `beforeId` (or to the end), unchanged when it may not move there. */
export function reorderQueueRows(rows: QueueRow[], messageId: string, beforeId: string | null): QueueRow[] {
  const moving = rows.find((r) => r.message_id === messageId);
  if (!moving || !canSteer(moving)) return rows;
  const rest = rows.filter((r) => r !== moving);
  const at = queueAtBefore(rest.map(asQueueRow), beforeId);
  if (at === null) return rows;
  return [...rest, { ...moving, queue_at: at }].sort((a, b) => queueOrder(a) - queueOrder(b));
}

/** The queue with two waiting rows folded into the earlier one as a joint turn. */
export function mergeQueueRows(rows: QueueRow[], messageId: string, intoId: string): QueueRow[] {
  const a = rows.find((r) => r.message_id === messageId);
  const b = rows.find((r) => r.message_id === intoId);
  if (!a || !b || a === b || !canSteer(a) || !canSteer(b)) return rows;
  const [keep, absorb] = queueOrder(a) <= queueOrder(b) ? [a, b] : [b, a];
  const content = formatJointMessage([...partsOf(keep), ...partsOf(absorb)]);
  return rows.filter((r) => r !== absorb).map((r) => (r === keep ? { ...r, content } : r));
}

/** A row's words as named parts, for display and merging. */
export function partsOf(row: QueueRow): JointPart[] {
  return jointPartsOf(row.content, row.from_name ?? "Someone");
}
