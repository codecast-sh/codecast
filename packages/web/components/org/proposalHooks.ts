// A proposal as the store holds it: its changes, the tree they are drawn
// against, and what a verdict saw. Read by ProposalCard and the entity card.
import { useMemo } from "react";
import { isOrgChangeDecidable, latestOrgRevisionAt, type OrgVerdictSeen } from "@codecast/shared/contracts/orgProposal";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { proposalWorkspace, sameWorkspace } from "./staffingModel";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

const changesSig = (all: Record<string, OrgProposalChange>, proposalId: string): string => {
  let sig = "";
  for (const c of Object.values(all)) if (c.proposal_id === proposalId) sig += `${c._id}:${c.status}:${c.revision?.at ?? 0}:${c.applied_note ?? ""}|`;
  return sig;
};

/** A proposal's changes from the store, re-read only when one of them moves
 *  (a signature, never the collection: CLAUDE.md store rules). */
export function useProposalChanges(proposalId: string | undefined): OrgProposalChange[] {
  const sig = useInboxStore((s) => (proposalId ? changesSig(s.orgProposalChanges, proposalId) : ""));
  return useMemo(() => {
    if (!proposalId) return [];
    return Object.values(useInboxStore.getState().orgProposalChanges).filter((c) => c.proposal_id === proposalId).sort((a, b) => a.seq - b.seq);
  }, [sig, proposalId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The org tree the proposal's changes are drawn against: the active
 *  workspace's, when the proposal belongs to it. A proposal from another
 *  workspace draws faceless rows rather than the wrong people. */
export function useProposalTree(proposal: Pick<OrgProposalListRow, "team_id" | "scope_user_id"> | undefined): OrgTree | null {
  const { tree } = useSyncOrgTree();
  if (!tree || !proposal) return null;
  return sameWorkspace(proposalWorkspace(proposal), tree.workspace) ? tree : null;
}

/** What the card showed when a verdict was pressed (S18): the latest revise
 *  and the rows still waiting, so the server refuses a verdict on a change
 *  revised under the reader. */
export function proposalSeen(changes: readonly OrgProposalChange[]): OrgVerdictSeen {
  return { revised_at: latestOrgRevisionAt(changes), seqs: changes.filter((c) => isOrgChangeDecidable(c.status)).map((c) => c.seq) };
}

