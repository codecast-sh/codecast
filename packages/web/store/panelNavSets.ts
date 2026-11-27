// What GlobalSessionPanel publishes to the store so the keyboard walk
// (visualOrder) visits rows in the order the panel draws them.

// The panel→store bridge for schedule-derived nav data. Trigger rows live in a
// per-component Convex subscription (agentTasks.webList), so the panel
// publishes the projections nav needs: the absorbed set (status view) and the
// trigger view's ordered groups (session ids per trigger, roster order).
export type ScheduleNavSets = {
  absorbed: ReadonlySet<string>;
  triggerOrder?: Array<{ key: string; ids: string[] }>;
};

// The rail's split of the Dormant bucket (lib/railActivity): the dormant rows
// drawn under Working, and under Shipping.
export type DormantSplitNav = {
  working: ReadonlySet<string>;
  shipping: ReadonlySet<string>;
};

/** Working, Shipping and Sleeping as the rail draws them: Working's own rows
 *  then the dormant rows drawn there, the Shipping rows, and the rest of
 *  Dormant. Without a split, Dormant stays whole. */
export function splitDormantWalk<T extends { _id: string }>(working: T[], dormant: T[], split: DormantSplitNav | null | undefined): [T[], T[], T[]] {
  if (!split) return [working, [], dormant];
  return [
    [...working, ...dormant.filter((s) => split.working.has(s._id))],
    dormant.filter((s) => split.shipping.has(s._id)),
    dormant.filter((s) => !split.working.has(s._id) && !split.shipping.has(s._id)),
  ];
}
