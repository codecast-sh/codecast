// The order a session takes its queued messages in. A row's place is its
// queue_at when someone moved it, else its created_at; every reader that
// takes "the oldest row" (the daemon's head of queue, the web's in-flight
// card) orders by this, so moving a row changes what the session takes next.
// Pure, so the web and the tests share it with the mutations.

export type QueueRow = {
  _id: unknown;
  status: string;
  created_at?: number;
  queue_at?: number;
  _creationTime?: number;
  delivery_status?: string;
  queued?: boolean;
};

export function queueOrder(row: Pick<QueueRow, "queue_at" | "created_at" | "_creationTime">): number {
  return row.queue_at ?? row.created_at ?? row._creationTime ?? 0;
}

export function byQueueOrder(a: QueueRow, b: QueueRow): number {
  return queueOrder(a) - queueOrder(b);
}

const IN_DELIVERY = new Set(["claimed", "delivery-started", "ambiguous"]);

/** Whether a row still waits in line: queued for the turn's end, or pending and not mid delivery. Only these move or merge. */
export function isWaitingInQueue(row: QueueRow): boolean {
  if (row.status === "held") return !!row.queued;
  return row.status === "pending" && !IN_DELIVERY.has(row.delivery_status ?? "");
}

/**
 * The queue_at that places a row directly before `beforeId` among `rows`
 * (the queue without the moving row, in order), or after the last row when
 * `beforeId` is null. Null when the target is not a waiting row: nothing may
 * jump ahead of a message the session is already taking.
 */
export function queueAtBefore(rows: readonly QueueRow[], beforeId: string | null): number | null {
  if (beforeId === null) return rows.length ? queueOrder(rows[rows.length - 1]) + 1 : Date.now();
  const at = rows.findIndex((r) => String(r._id) === beforeId);
  if (at < 0 || !isWaitingInQueue(rows[at])) return null;
  const next = queueOrder(rows[at]);
  const prev = at > 0 ? queueOrder(rows[at - 1]) : next - 2;
  return (prev + next) / 2;
}
