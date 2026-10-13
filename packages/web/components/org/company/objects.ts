// A goal as a link finds it in the store, by any ref the link may carry.
// Pure: every reader passes the rows it already holds.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";

export type Member = { _id: string; name?: string; github_username?: string; image?: string; github_avatar_url?: string };

/** A goal by its id, its short id (any case) or its stub key, so a goal
 *  opened by its stub key follows the server row that supersedes it. */
export function findGoal(rows: readonly InitiativeRow[], ref: string): InitiativeRow | undefined {
  const r = ref.trim().toLowerCase();
  return rows.find((g) => g._id === ref || (!!g.short_id && g.short_id.toLowerCase() === r) || g.client_key === ref);
}
