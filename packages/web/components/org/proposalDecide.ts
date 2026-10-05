// One verdict on several changes of a proposal (org-staffing.md S39): a card
// holds every change to one subject, and its Accept decides them together.
// Every surface that draws a card sends its verdict through here, so the
// order, the rows it may touch and the history line are decided once.
import { editedOrgChange, isOrgChangeDecidable, orgChangeTakesOver } from "@codecast/shared/contracts/orgProposal";
import { undoAsOne } from "../../store/undo/labels";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { orderChanges } from "./staffingModel";

export type SubjectVerdictWord = "accept" | "skip";

/**
 * Decide a set of changes of one proposal in apply order, as one history row.
 * `decideOne` is the surface's own single change verdict (the store action,
 * or the org page's wrapper with its preview branch). Only rows that still
 * wait are sent, a role before what rides on it (the accept order of S4), and
 * "leave the sessions" reaches only the rows that would take sessions over
 * (R1, the rule accept all applies).
 */
export function decideTogether(
  changes: readonly OrgProposalChange[],
  ids: readonly string[],
  verdict: SubjectVerdictWord,
  decideOne: (changeId: string, verdict: SubjectVerdictWord, edits: Record<string, unknown> | undefined) => void,
  opts?: { leave_sessions?: boolean },
): void {
  const wanted = new Set(ids);
  const rows = orderChanges(changes.filter((c) => wanted.has(c._id) && isOrgChangeDecidable(c.status)));
  if (rows.length === 0) return;
  const leave = (c: OrgProposalChange) => verdict === "accept" && !!opts?.leave_sessions && orgChangeTakesOver(editedOrgChange(c.change, c.edits));
  undoAsOne(`${verdict === "accept" ? "Accepted" : "Skipped"} ${rows.length} org changes`, () => {
    for (const c of rows) decideOne(c._id, verdict, leave(c) ? { leave_sessions: true } : undefined);
  });
}
