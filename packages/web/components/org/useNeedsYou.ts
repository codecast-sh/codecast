"use client";
// Waits on you, read from the store (waitsOnYou.ts). One hook feeds every
// place that shows it: the list above the Org canvas, a role card's
// "Waiting on you" and the rail's Org count, so the three cannot disagree.
// Subscriptions are wake signatures of the fields waitsOnYou reads, so a tree
// push or a heartbeat that changes none of them re-renders nothing.
import { useMemo } from "react";
import { useInboxStore, useTrackedStore, isConvexId } from "../../store/inboxStore";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { useWorkspaceFeature } from "../../lib/teamFeatures";
import { joinProposals, type OrgProposalChange, type OrgProposalListRow } from "./orgStaffingTypes";
import type { NeedsYouItem, OrgWorkspaceRef } from "./staffingModel";
import type { OrgTree } from "./orgTypes";
import { canAnswerInPlace, orgDecisions, waitsOnYou, waitsProposalsSig, waitsTreeSig, type WaitItem } from "./waitsOnYou";

/** The active workspace as proposals name it: the team, else the person. */
export function activeOrgWorkspace(activeTeamId: string | null | undefined, meId: string | null | undefined): OrgWorkspaceRef | null {
  if (activeTeamId && isConvexId(activeTeamId)) return { kind: "team", id: activeTeamId };
  return meId ? { kind: "user", id: meId } : null;
}

const NONE: WaitItem[] = [];

/** Everything that waits on the viewer in the active workspace's org, in
 *  the order the list draws it. Empty when the workspace has Org off. */
export function useWaitsOnYou(): WaitItem[] {
  const on = useWorkspaceFeature("org");
  const queue = useDecisionQueue();
  const s = useTrackedStore([
    (st) => waitsTreeSig(st.orgTree),
    (st) => waitsProposalsSig(st.orgProposals),
    (st) => st.orgProposalChanges,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.currentUser?._id,
  ]);
  const ws = activeOrgWorkspace(s.clientState.ui?.active_team_id as string | undefined, s.currentUser?._id ? String(s.currentUser._id) : null);
  const treeSig = waitsTreeSig(s.orgTree);
  const proposalsSig = waitsProposalsSig(s.orgProposals);
  const changes = s.orgProposalChanges as Record<string, OrgProposalChange> | undefined;
  return useMemo(() => {
    if (!on) return NONE;
    // The slot holds one tree; until the active workspace's lands, decisions
    // wait for it rather than match another workspace's roles.
    const tree = s.orgTree && ws && s.orgTree.workspace.id === ws.id ? s.orgTree : null;
    const proposals = joinProposals((s.orgProposals ?? {}) as Record<string, OrgProposalListRow>, changes ?? {});
    return waitsOnYou({ tree, queue, proposals, workspace: ws });
  }, [on, treeSig, proposalsSig, changes, ws?.kind, ws?.id, queue]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The rail's Org count: the number of Waits on you rows. */
export function useOrgNeedsYouCount(): number {
  return useWaitsOnYou().length;
}

/** @deprecated Wave-2 shim for company/NowBlock: the org's decisions as the
 *  old NeedsYouItem shape. Deleted with NowBlock's move to useWaitsOnYou. */
export function useOrgAsks(tree: OrgTree | null): NeedsYouItem[] {
  const queue = useDecisionQueue();
  return useMemo(
    () => orgDecisions(tree, queue).map(({ item, role }) => ({ kind: "decision" as const, key: item.key, role, item, canAnswerInPlace: canAnswerInPlace(item) })),
    [tree, queue],
  );
}

/** @deprecated Wave-2 shim for nowModel.asksFor. Whether the store holds a
 *  goal (`in-N`) or project (`pj-…`) by short id. Read at click time. */
export function storeHoldsObject(ref: string): boolean {
  const st = useInboxStore.getState() as { initiatives?: Record<string, { short_id?: string }>; projects?: Record<string, { short_id?: string }> };
  const rows = ref.startsWith("in-") ? st.initiatives : ref.startsWith("pj-") ? st.projects : undefined;
  return !!rows && Object.values(rows).some((r) => r?.short_id === ref);
}
