"use client";
// What waits on the person (D7), read from the store for the two places that
// show it: the strip above the Org conversation (useOrgAsks, beside the
// proposal rows the screen already holds) and the sidebar's Org count
// (useOrgNeedsYouCount). Both go through staffingModel's needsYou rules, so
// the two numbers cannot disagree. Subscriptions are wake signatures of the
// fields needsYou reads, so a tree push or a heartbeat that changes none of
// them re-renders nothing.
import { useMemo } from "react";
import { useInboxStore, useTrackedStore, isConvexId } from "../../store/inboxStore";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { useWorkspaceFeature } from "../../lib/teamFeatures";
import { needsYouHealthSig, needsYouLine, needsYouProposalsSig, needsYouTreeSig, orgAsks, workspaceOpenProposals, type NeedsYouItem, type OrgWorkspaceRef } from "./staffingModel";
import type { OrgTree } from "./orgTypes";

/** The decisions and stuck roles of the tree on screen. The screen passes its
 *  own tree (the dev preview's included); health and the queue come from the
 *  store. */
export function useOrgAsks(tree: OrgTree | null): NeedsYouItem[] {
  const queue = useDecisionQueue();
  const s = useTrackedStore([(st) => needsYouHealthSig(st.orgHealth)]);
  const healthSig = needsYouHealthSig(s.orgHealth);
  return useMemo(() => orgAsks(tree, s.orgHealth, queue), [tree, healthSig, queue]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The active workspace as proposals name it: the team, else the person. */
export function activeOrgWorkspace(activeTeamId: string | null | undefined, meId: string | null | undefined): OrgWorkspaceRef | null {
  if (activeTeamId && isConvexId(activeTeamId)) return { kind: "team", id: activeTeamId };
  return meId ? { kind: "user", id: meId } : null;
}

/** The count the strip leads with, for a reader that is not on the screen.
 *  Zero when the workspace has the org feature off: nothing there proposes
 *  or asks. */
export function useOrgNeedsYouCount(): number {
  const on = useWorkspaceFeature("org");
  const queue = useDecisionQueue();
  const s = useTrackedStore([
    (st) => needsYouTreeSig(st.orgTree),
    (st) => needsYouHealthSig(st.orgHealth),
    (st) => needsYouProposalsSig(st.orgProposals),
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.currentUser?._id,
  ]);
  const ws = activeOrgWorkspace(s.clientState.ui?.active_team_id as string | undefined, s.currentUser?._id ? String(s.currentUser._id) : null);
  const treeSig = needsYouTreeSig(s.orgTree);
  const healthSig = needsYouHealthSig(s.orgHealth);
  const proposalsSig = needsYouProposalsSig(s.orgProposals);
  return useMemo(() => {
    if (!on) return 0;
    // The slot holds one tree; until the active workspace's lands, the asks
    // wait for it rather than count another workspace's roles.
    const tree = s.orgTree && ws && s.orgTree.workspace.id === ws.id ? s.orgTree : null;
    const proposals = workspaceOpenProposals(Object.values(s.orgProposals ?? {}), ws).length;
    return needsYouLine(proposals, orgAsks(tree, s.orgHealth, queue)).total;
  }, [on, treeSig, healthSig, proposalsSig, ws?.kind, ws?.id, queue]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** How many of those are proposals: the badge is violet only when all of them are. */
export function useOrgNeedsYouProposals(): number {
  const s = useTrackedStore([
    (st) => needsYouProposalsSig(st.orgProposals),
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.currentUser?._id,
  ]);
  const ws = activeOrgWorkspace(s.clientState.ui?.active_team_id as string | undefined, s.currentUser?._id ? String(s.currentUser._id) : null);
  const proposalsSig = needsYouProposalsSig(s.orgProposals);
  return useMemo(() => workspaceOpenProposals(Object.values(s.orgProposals ?? {}), ws).length, [proposalsSig, ws?.kind, ws?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Whether the store holds a goal (`in-N`) or project (`pj-…`) by short id:
 *  a decision that cites one opens it. Read at click time, so nothing
 *  subscribes. */
export function storeHoldsObject(ref: string): boolean {
  const st = useInboxStore.getState() as { initiatives?: Record<string, { short_id?: string }>; projects?: Record<string, { short_id?: string }> };
  const rows = ref.startsWith("in-") ? st.initiatives : ref.startsWith("pj-") ? st.projects : undefined;
  return !!rows && Object.values(rows).some((r) => r?.short_id === ref);
}
