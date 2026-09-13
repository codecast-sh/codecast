import type { SessionDecisionItem } from "../store/inboxStore";

// The route of a decision's document page: its short id when it has one.
export function decisionHref(d: Pick<SessionDecisionItem, "_id" | "short_id">): string {
  return `/decisions/${d.short_id ?? d._id}`;
}

// The latest recommendation on the ladder, if any role gave one.
export function ladderRecommendation(d: Pick<SessionDecisionItem, "hops">): number | undefined {
  for (let i = (d.hops?.length ?? 0) - 1; i >= 0; i--) {
    const r = d.hops![i].recommendation;
    if (r !== undefined) return r;
  }
  return undefined;
}
