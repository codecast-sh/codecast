"use client";
// The org's decisions that wait on the viewer, and the store lookups the
// Now block's asks read, from the store.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import type { NeedsYouItem } from "./staffingModel";
import type { OrgTree } from "./orgTypes";
import { canAnswerInPlace, orgDecisions } from "./orgDecisions";

/** The org's decisions as NeedsYouItems, for the Now block. */
export function useOrgAsks(tree: OrgTree | null): NeedsYouItem[] {
  const queue = useDecisionQueue();
  return useMemo(
    () => orgDecisions(tree, queue).map(({ item, role }) => ({ kind: "decision" as const, key: item.key, role, item, canAnswerInPlace: canAnswerInPlace(item) })),
    [tree, queue],
  );
}

/** Whether the store holds a goal (`in-N`) or project (`pj-…`) by short id,
 *  for nowModel.asksFor. Read at click time. */
export function storeHoldsObject(ref: string): boolean {
  const st = useInboxStore.getState() as { initiatives?: Record<string, { short_id?: string }>; projects?: Record<string, { short_id?: string }> };
  const rows = ref.startsWith("in-") ? st.initiatives : ref.startsWith("pj-") ? st.projects : undefined;
  return !!rows && Object.values(rows).some((r) => r?.short_id === ref);
}
