// A proposal as the store holds it: its changes, the tree they are drawn
// against, and what a verdict saw. Read by ProposalCard and the entity card.
import { useMemo } from "react";
import { isOrgChangeDecidable, latestOrgRevisionAt, type OrgVerdictSeen } from "@codecast/shared/contracts/orgProposal";
import { useInboxStore, type PlanItem, type ProjectItem } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { findEntityInStore } from "../../lib/liveEntities";
import { proposalWorkspace, sameWorkspace } from "./staffingModel";
import { namedTaskRefs, type SubjectLive } from "./proposalSubjects";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

const changesSig = (all: Record<string, OrgProposalChange>, proposalId: string): string => {
  let sig = "";
  // The stamp of what an accept moved arrives with the applied row (S39), so it wakes the card too; so does the person's answer on the row.
  for (const c of Object.values(all)) if (c.proposal_id === proposalId) sig += `${c._id}:${c.status}:${c.revision?.at ?? 0}:${c.applied_note ?? ""}:${c.applied_at ?? 0}:${c.applied_diff?.length ?? ""}:${c.reply?.at ?? 0}|`;
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

// A card's before reads these fields and nothing else: a comment, a task
// count or a heartbeat on a project repaints no card.
const projectSig = (p: ProjectItem) => `${p.title}|${p.short_id ?? ""}|${p.status}|${p.priority ?? ""}|${p.goal ?? ""}|${p.owner_role_id ?? ""}|${(p.success_metrics ?? []).join("\u0001")}|${(p.non_goals ?? []).join("\u0001")}|${((p as { risks?: string[] }).risks ?? []).join("\u0001")}`;
const planSig = (p: PlanItem) => `${p.title}|${p.short_id}|${p.status}|${(p as { project_id?: string }).project_id ?? ""}`;
const NO_TASKS: SubjectLive["tasks"] = [];

/** The active workspace's records a card reads a before from, without the
 *  tree: goals, projects, plans, and only the tasks the changes name (behind
 *  one signature of what a card shows of them, never the task collection).
 *  A surface that already holds a tree pairs this with `subjectLiveOf`. */
export function useSubjectRecords(changes: readonly OrgProposalChange[]): Omit<SubjectLive, "tree"> {
  const goals = useInitiatives();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const plans = useWorkspaceCollection<PlanItem>("plans", planSig);
  const refs = useMemo(() => namedTaskRefs(changes), [changes]);
  const taskSig = useInboxStore((s) => refs.map((ref) => { const t = findEntityInStore(s, "task", ref); return t ? `${ref}:${t._id ?? ""}:${t.status ?? ""}:${t.title ?? ""}` : ref; }).join("|"));
  const tasks = useMemo(() => {
    if (refs.length === 0) return NO_TASKS;
    const state = useInboxStore.getState();
    return refs.flatMap((ref) => { const t = findEntityInStore(state, "task", ref); return t?._id ? [{ _id: t._id, short_id: t.short_id ?? ref, title: t.title ?? ref, status: t.status ?? "" }] : []; });
  }, [taskSig]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ goals, projects, plans, tasks }), [goals, projects, plans, tasks]);
}

/** The records with the tree they are read against: null until the tree
 *  lands, and for a proposal of another workspace (the records belong to the
 *  ACTIVE workspace, and a title match there would print another company's
 *  values as "before"). Pure: the same object while nothing moved. */
export function subjectLiveOf(tree: OrgTree | null | undefined, records: Omit<SubjectLive, "tree">): SubjectLive | null {
  return tree ? { tree, ...records } : null;
}

/**
 * The live records a proposal's cards read a before from (S39): the one place
 * they are gathered, for the conversation's card, the org page, the company
 * document and the chart. All of it is the store, nothing is fetched; a cold
 * store gives cards with no before, which is the honest fallback. The tree is
 * the active workspace's, mounted here; a surface that must not mount the tree
 * feeder reads `useSubjectRecords` and `subjectLiveOf` with its own.
 */
export function useSubjectLive(proposal: Pick<OrgProposalListRow, "team_id" | "scope_user_id"> | undefined, changes: readonly OrgProposalChange[]): SubjectLive | null {
  const tree = useProposalTree(proposal);
  const records = useSubjectRecords(changes);
  return useMemo(() => subjectLiveOf(tree, records), [tree, records]);
}
