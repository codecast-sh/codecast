// The rank of each of the viewer's active priorities in every workspace they
// hold: what the inbox's Priorities view labels and sorts a session by when it
// serves a priority outside the active workspace (web store/priorityOrder).
// priorities.list carries only the active workspace, and the inbox lists
// every workspace's sessions.

import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import { heldKeysFor } from "./lib/accessKeys";
import { featureCheck } from "./lib/priorityAccess";
import { activeGroup } from "./lib/priorityGroup";
import { priorityPositions } from "@codecast/shared/contracts/priorities";

export type PriorityRankEntry = { _id: string; workspace: string; rank: number };

/** Each of the viewer's active priorities with its rank among theirs in its workspace, in every held workspace with the feature on. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<PriorityRankEntry[] | null> => {
    const viewer = await getAuthUserId(ctx);
    if (!viewer) return null;
    const featureOn = featureCheck(ctx);
    const out: PriorityRankEntry[] = [];
    for (const workspace of await heldKeysFor(ctx, viewer)) {
      if (!(await featureOn(workspace))) continue;
      const ranks = priorityPositions(await activeGroup(ctx, viewer, workspace), (p) => String(p._id));
      for (const [_id, rank] of ranks) out.push({ _id, workspace, rank });
    }
    return out;
  },
});
