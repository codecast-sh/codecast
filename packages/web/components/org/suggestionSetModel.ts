// The Head of People's open suggestions as one set (docs/architecture/org-staffing.md
// S45). A review posts one proposal per kind of work, and the chat adds small
// ones, so a workspace can hold several open proposals at once; the person
// reads them as one current set of pieces. The Head of People keeps that set
// current by revising its own proposals; what another author posted stays
// apart, because only its author can revise it.
import { isOrgChangeDecidable } from "@codecast/shared/contracts/orgProposal";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { workspaceOpenProposals, type OrgWorkspaceRef } from "./staffingModel";

type Row = Pick<OrgProposalListRow, "_id" | "status" | "team_id" | "author" | "mode" | "created_at" | "superseded_by">;

export type SuggestionSplit<R extends Row> = {
  /** The Head of People's open proposals, oldest first: the set's pieces. */
  set: R[];
  /** Its open proposals a newer one replaced: the person withdraws them. */
  replaced: R[];
  /** Open proposals another author posted (a role's hire, a person's request), oldest first. */
  others: R[];
};

/** Whether the Head of People wrote it: its role, or a review run (a review or a first chart is its work whoever ran it). */
export function isHeadSuggestion(row: Pick<Row, "author" | "mode">, headRoleId: string | null): boolean {
  if (row.mode === "init" || row.mode === "review") return true;
  return !!headRoleId && row.author?.kind === "role" && row.author.id === headRoleId;
}

/** The workspace's open proposals split into the set, the replaced and the rest. */
export function splitSuggestions<R extends Row>(rows: readonly R[], ws: OrgWorkspaceRef | null, headRoleId: string | null): SuggestionSplit<R> {
  const open = workspaceOpenProposals(rows, ws).sort((a, b) => a.created_at - b.created_at);
  const out: SuggestionSplit<R> = { set: [], replaced: [], others: [] };
  for (const p of open) {
    if (!isHeadSuggestion(p, headRoleId)) out.others.push(p);
    else if (p.superseded_by && open.some((q) => q._id === p.superseded_by!.id)) out.replaced.push(p);
    else out.set.push(p);
  }
  return out;
}

/** When a piece was last put to the person: its proposal's post, or the latest revise of its changes. */
export function pieceAge(proposalCreatedAt: number, changes: readonly Pick<OrgProposalChange, "revision">[]): number {
  return Math.max(proposalCreatedAt, ...changes.map((c) => c.revision?.at ?? 0));
}

/** The changes still waiting on the person. */
export const waitingChanges = <C extends Pick<OrgProposalChange, "status">>(changes: readonly C[]): C[] => changes.filter((c) => isOrgChangeDecidable(c.status));

/** A piece older than this reads as stale: the Head of People should have refreshed or dropped it. */
export const STALE_PIECE_MS = 7 * 24 * 60 * 60 * 1000;

/** "today", "3d", "2w": a piece's age at a glance. */
export function ageWords(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
