// The hint `cast task dep` prints after an agent blocks a task: how this
// session parks on it, or that nothing will wake it. Loaded only when
// applyBlockers (taskGraphCommands.ts) prints it, so it stays off the CLI's
// boot graph (bench/bootGraph.guard.test.ts).

import { blockerWaitingLabel, parkingLine, parseBlockerRef, type Blocker } from "@codecast/shared/tasks";
import type { TaskPulse } from "./taskPulse.js";

/** Two spellings of one task id ("CT-012", "ct-12"). */
function sameTask(a: string, b: string): boolean {
  const norm = (id: string) => { const p = parseBlockerRef(id); return p.ok && p.kind === "task" ? p.ref : id.toLowerCase(); };
  return norm(a) === norm(b);
}

/** After an agent blocks a task: how to park on it when this session holds
 *  it. When it holds another task, a wait the server recorded it as setter
 *  of (`parked`) wakes it (TG2: the task unblocking or closing, or the wait
 *  failing or being removed); otherwise only the session holding the task is woken, and
 *  an older server never says `parked`. When its held task still lists the
 *  task in blocked_by: as the wait's setter (`parked: "close"`), the wait
 *  still tells it when the task unblocks or the wait fails, and its held task
 *  unblocking wakes that task's owner (this session only when `owns`); as a
 *  joiner of another session's wait (`"held"`), the wait tells it nothing. A
 *  session holding no task is wiring up the graph, not waiting: no hint. */
export type HeldPark = { kind: "close" | "held"; owns: boolean };
export function parkAfterBlocking(sessionId: string | null, shortId: string, open: Blocker[], pulse: TaskPulse | null, parked: Blocker[] = [], held: HeldPark | null = null): string | null {
  if (!sessionId || !open.length || !pulse?.started || !pulse.task) return null;
  if (sameTask(pulse.task, shortId)) return parkingLine(open, shortId);
  if (parked.length && held?.kind === "held") {
    return `${pulse.task} still waits for ${shortId} to close; you are woken when ${pulse.task} is unblocked. Pin dormant naming ${shortId} and end your turn.`;
  }
  if (parked.length && held?.kind === "close") {
    const wake = held.owns ? `woken as ${pulse.task}'s owner` : `${pulse.task}'s owning session is woken`;
    return `${pulse.task} still waits for ${shortId} to close: you are told when ${shortId} is unblocked or this wait fails, and ${wake} when ${pulse.task} is unblocked. Pin dormant naming ${shortId} and end your turn.`;
  }
  if (parked.length) {
    return `This session is woken when ${shortId} is unblocked or closed, or if a wait it set fails or is removed. Until then, run cast state --status dormant "${blockerWaitingLabel(parked[0])}" and end your turn.`;
  }
  return `This session does not hold ${shortId}, so nothing wakes it when ${open.length === 1 ? "this clears" : "these clear"} (cast task start ${shortId} to hold it).`;
}
