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

// Interactive-prompt / poll answers (tagged __cc_poll, mirrors the daemon's parsePollMessage):
// keystroke selections (keys/steps) and free-text answers that decline the menu and type at
// the prompt (text). These are fire-and-forget — a successful inject IS their delivery, so the
// content-matched ack in addMessages is bypassed and re-injecting them on the stale-injected
// reset is suppressed. Re-injecting a keystroke poll re-sends menu keys and mis-navigates the
// agent's prompts; re-injecting a text poll re-declines and re-types a duplicate answer. (A
// text poll's typed answer DOES echo to the JSONL, unlike a keystroke poll, but the ack still
// can't match it — the stored content is the JSON envelope, not the typed prose.)
export function isControlMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed?.__cc_poll === true && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps) || typeof parsed.text === "string");
  } catch {
    return false;
  }
}

// Only the oldest deliverable row of each conversation. A conversation takes
// one message at a time, in queue order (the daemon serializes per
// conversation, and the launch prompt and the web's in-flight card both read
// the oldest row), so the rows behind the head are nothing the daemon can act
// on yet: it claimed each one on every push only to skip it. A session that
// stays down queues dozens (52 worker reports on one conversation, 3.5 days
// old, on 2026-10-05), and claiming those on every push was 44 mutations a
// second, a tenth of all backend time (ct-56547). The next row arrives the
// moment the head leaves "pending", the same reactive turn as before.
//
// A poll answer goes ahead of every ordinary row. The daemon holds an ordinary
// message while the pane shows a menu, and the answer is what closes that
// menu: queued behind the held message, it never reached the daemon and the
// session sat stuck until someone answered in the terminal (Alex Green's
// jx78ys8, 2026-10-25: a typed message sent while the card was open, then
// three card answers and two messages, none delivered).
export function headOfEachQueue<T extends { conversation_id: unknown; content?: string; created_at?: number; queue_at?: number; _creationTime?: number }>(rows: T[]): T[] {
  const head = new Map<string, T>();
  const ahead = (a: T, b: T) => {
    const pollA = isControlMessage(a.content ?? ""), pollB = isControlMessage(b.content ?? "");
    return pollA !== pollB ? pollA : queueOrder(a) < queueOrder(b);
  };
  for (const row of rows) {
    const key = String(row.conversation_id);
    const held = head.get(key);
    if (!held || ahead(row, held)) head.set(key, row);
  }
  return rows.filter((r) => head.get(String(r.conversation_id)) === r);
}
