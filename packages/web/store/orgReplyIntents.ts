// The org intents that act on proposal rows and the record rather than the
// tree (orgSlice.ts header): a verdict's flip, a note's reply stamp, a
// withdraw, an undo's mark, and what puts each back.
import type { OrgProposalChange, OrgProposalListRow } from "../components/org/orgStaffingTypes";
import type { OrgChangeReply } from "@codecast/shared/contracts/orgProposal";
import type { OrgLogEntry } from "@codecast/shared/contracts/orgChange";
import type { OrgIntent } from "./orgSlice";

/** A verdict's flip, on the change rows: the same body for the action's
 *  draft and for the replay onto a push that still carries the old status.
 *  The edits ride the intent, so a stale push that replaced the row with the
 *  server's copy (no edits yet) gets them back too. */
export function applyOrgChangeIntent(changes: Record<string, OrgProposalChange>, intent: Extract<OrgIntent, { kind: "decideChange" | "noteChange" }>): void {
  const c = changes[intent.change_id];
  if (!c) return;
  if (intent.kind === "noteChange") return applyNoteStamp(c, intent);
  if (c.decided_by !== undefined || c.status === intent.to) return;
  c.status = intent.to;
  c.decided_at = intent.at;
  if (intent.reply) c.reply = intent.reply;
}

/** The server's own `reply` stamp written since this note was pressed: it
 *  names who answered (the draft's stamp never does) and is not the stamp the
 *  row held before (`from`, which the server wrote for an earlier answer).
 *  No clocks: a client's `at` and the server's cannot be compared. */
export function replyStampEchoed(reply: OrgChangeReply | undefined, intent: { from?: OrgChangeReply }): boolean {
  if (!reply || reply.by === undefined) return false;
  const was = intent.from;
  return !was || was.by !== reply.by || was.at !== reply.at || was.verdict !== reply.verdict || (was.text ?? "") !== (reply.text ?? "");
}

/** A note's stamp on its row (a change, or the proposal for a note on the
 *  whole): the action's draft and the replay onto a push that predates the
 *  mutation. The server's own stamp, once there, is left alone. */
export function applyNoteStamp(row: { reply?: OrgChangeReply }, intent: { reply: OrgChangeReply; from?: OrgChangeReply }): void {
  if (!replyStampEchoed(row.reply, intent)) row.reply = intent.reply;
}

/** The intents that act on the list row (a withdraw's flip, a whole-proposal
 *  note's stamp): the action's draft and the replay onto a list push that
 *  started before the mutation landed. */
export function applyOrgProposalIntent(proposals: Record<string, OrgProposalListRow>, intent: Extract<OrgIntent, { kind: "withdraw" | "noteProposal" }>): void {
  const p = proposals[intent.proposal_id];
  if (!p) return;
  if (intent.kind === "noteProposal") return applyNoteStamp(p, intent);
  if (p.resolved_at !== undefined || p.status !== "open") return;
  p.status = "withdrawn";
}

/** The entries one undo or redo marks: the one pressed, and the later ones
 *  the person agreed go with it. */
export const undoIntentBatches = (intent: Extract<OrgIntent, { kind: "undoChange" }>) => [intent.batch, ...intent.with];

/** The mark an undo or a redo puts on the record: the action's draft and the
 *  replay onto a list push that started before the mutation landed. An undo
 *  strikes each entry under the person's name with no batch named yet (the
 *  server's stamp names it, which is how the echo is told from the mark); a
 *  redo takes the strike off. */
export function applyOrgUndoIntent(log: Record<string, OrgLogEntry>, intent: Extract<OrgIntent, { kind: "undoChange" }>): void {
  for (const b of undoIntentBatches(intent)) {
    const e = log[b];
    if (!e) continue;
    if (intent.redo) delete e.undone_by;
    else if (!e.undone_by) e.undone_by = { batch: "", user_id: intent.by.user_id, name: intent.by.name, at: intent.at };
  }
}

export function putReplyBack(row: { reply?: OrgChangeReply }, from: OrgChangeReply | undefined): void {
  if (from) row.reply = from;
  else delete row.reply;
}
