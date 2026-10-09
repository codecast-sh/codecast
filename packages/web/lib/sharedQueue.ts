// The shared queue as the web reads it: every message waiting to go into a
// session, from whoever sent it, in the order the session will take them.
// The rows live in one place, the conversation's pending status row
// (pendingMessageStatus[convId].inflight, from getConversationPendingMessage);
// these are pure reads and the optimistic edits the store's reorder and
// merge actions make on the draft, the same rules the server applies
// (convex/lib/sessionQueue, pendingMessages.mergeQueuedForUser).
import { formatJointMessage, jointPartsOf, type JointPart } from "@codecast/shared/contracts/jointMessage";
import { isWaitingInQueue, queueAtBefore, queueOrder } from "@codecast/convex/convex/lib/sessionQueue";
import { isBootstrapPrompt, parseScheduledTask, type WaitingSession } from "@codecast/shared/contracts";
import { parseInboundSessionMessage, parseMachineDeliveredMessage } from "../components/sessionMessage";

export type QueueRow = {
  message_id: string;
  client_id?: string;
  created_at: number;
  queue_at?: number;
  status: string;
  delivery_status?: string;
  queued?: boolean;
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

/** Held for the end of the agent's turn ("Queue for later"). */
export function isHeldForTurnEnd(row: QueueRow): boolean {
  return row.status === "held" && !!row.queued;
}

// ── What a row reads as ─────────────────────────────────────────────────────
// A row's content is the wire form the session will receive. Machinery wraps
// what it delivers (a trigger run's frame, another session's message), and
// the queue shows who that is from and what it says, never the wrapper: the
// same reading the transcript gives the message once it lands.

export type QueueLine =
  /** Words a person typed (or several people's, merged): shown under their names. */
  | { kind: "person" }
  /** A role's opening brief, sent by the person who staffed it. */
  | { kind: "brief"; text: string }
  /** A trigger's run: its title, the trigger (tr-N) and the session it fired for, when named. */
  | { kind: "trigger"; title: string; trigger?: string; waiting?: WaitingSession | null; text: string }
  /** Another session's, a teammate agent's or a chat thread's words. `ref` is the sending session's short id. */
  | { kind: "session" | "teammate" | "chat"; source: string; ref?: string; text: string };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function queueLineOf(row: QueueRow): QueueLine {
  const frame = parseScheduledTask(row.content);
  if (frame) return { kind: "trigger", title: frame.title || "Trigger run", trigger: frame.trigger, waiting: frame.waiting, text: oneLine(frame.waiting?.state || frame.body) };
  const machine = parseMachineDeliveredMessage(row.content);
  if (machine && machine.kind !== "schedule") {
    const ref = machine.kind === "session" ? parseInboundSessionMessage(row.content)?.from : undefined;
    return { kind: machine.kind, source: machine.source, ...(ref && ref !== "unknown" ? { ref } : {}), text: oneLine(machine.body) };
  }
  if (isBootstrapPrompt(row.content)) return { kind: "brief", text: oneLine(row.content.split("\n")[0].replace(/\*\*/g, "")) };
  return { kind: "person" };
}

/** One line of the queue as drawn: a row, or a run of the same trigger's
 *  runs waiting back to back, folded under the first. */
export type QueueGroup = { rows: QueueRow[]; line: QueueLine };

/** The queue as drawn. A trigger that fired many times into a session that
 *  took none of them (a machine that was away) reads as one line with a
 *  count, not a wall of the same title. Only waiting rows fold: one going in
 *  now is its own line. */
export function queueGroupsOf(rows: QueueRow[]): QueueGroup[] {
  const groups: QueueGroup[] = [];
  for (const row of rows) {
    const line = queueLineOf(row);
    const last = groups[groups.length - 1];
    if (last && line.kind === "trigger" && last.line.kind === "trigger" && last.line.title === line.title && canSteer(row) && last.rows.every(canSteer)) last.rows.push(row);
    else groups.push({ rows: [row], line });
  }
  return groups;
}

/** How many lines the queue shows before the rest fold behind "show more". */
export const QUEUE_PREVIEW_LINES = 5;
