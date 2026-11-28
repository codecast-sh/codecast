// How much room a split group needs, and whether a group can split again.

import { MIN_GROUP_SIZE, canSplitMore, groupRects, type SplitDirection, type Workspace } from "./model";

/** The smallest a group may be, in px: a tab, the breadcrumbs and a status
 *  row still fit, and a few lines of code under them. */
export const MIN_GROUP_PX = { width: 260, height: 160 } as const;
/** Size changes smaller than this re-render nothing. */
export const SIZE_QUANTUM = 20;

/** A group's minimum share of a split `px` long holding `n` groups: the pixel
 *  floor as a percentage, never more than an equal share, so it can always
 *  be met (a pixel minimum the pane cannot meet livelocks the panel library). */
export function minShare(px: number, n: number, floor: number): number {
  if (!px) return MIN_GROUP_SIZE;
  return Math.min(100 / n - 0.5, Math.max(MIN_GROUP_SIZE, (floor / px) * 100));
}

/** Whether `groupId` has room to split in `dir`: under the group limit, and
 *  each half at least the pixel floor (an unmeasured workspace has room). */
export function roomToSplit(ws: Workspace, groupId: string, dir: SplitDirection, size: { w: number; h: number }): boolean {
  if (!canSplitMore(ws)) return false;
  const r = groupRects(ws).get(groupId);
  if (!r) return false;
  const [len, floor] = dir === "right" ? [r.w * size.w, MIN_GROUP_PX.width] : [r.h * size.h, MIN_GROUP_PX.height];
  return !len || len / 2 >= floor;
}
