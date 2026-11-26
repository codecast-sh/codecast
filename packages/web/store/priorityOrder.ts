// The inbox's Priorities order: each status section sorted by the viewer's
// priority a session serves (its rank, then the milestone's place in that
// priority), every other session after, in the order it already had. A leaf
// (no store imports) so the store and the panel share it without a cycle.
import { priorityPositions, type PriorityRow } from "@codecast/shared/contracts/priorities";
import { makeCollectionSig } from "./wakeSig";

type PriorityLinked = { priority_id?: string | null; priority_step_key?: string | null };
type RankedRow = Pick<PriorityRow, "_id" | "status" | "person_pos" | "ai_rank" | "last_active_at" | "user_id" | "workspace" | "steps">;
type Ranks = Map<string, number>;

/** Where a session sits in the viewer's order: the priority's rank, then its milestone's index. */
export type PriorityPlace = { rank: number; step: number };

/** The one reader of a session's priority link (the conversation's priority_id and priority_step_key). */
export function sessionPriorityOf(s: PriorityLinked): { priorityId: string; stepKey: string | null } | null {
  return s.priority_id ? { priorityId: s.priority_id, stepKey: s.priority_step_key ?? null } : null;
}

/** Every loaded priority's position among its owner's active ones (1 = first), by _id: the effective order the server's list reads too. */
export function priorityRanks(priorities: Record<string, RankedRow> | undefined): Ranks {
  return priorityPositions(Object.values(priorities ?? {}), (r) => String(r._id));
}

/** A priority's position among its owner's active priorities (1 = first), or null when it has none. */
export function priorityRankOf(row: Pick<PriorityRow, "_id">, ranks: Ranks): number | null {
  return ranks.get(String(row._id)) ?? null;
}

/** Linked to a priority this window has not loaded: the feeder holds only the
 *  active workspace's priorities, and the inbox lists every workspace's sessions. */
export const PRIORITY_ELSEWHERE = "elsewhere";

/** A session's standing in the viewer's order: its place, "elsewhere", or null
 *  (no link, a teammate's priority, one with no rank). */
export type PriorityStanding = PriorityPlace | typeof PRIORITY_ELSEWHERE | null;

/** What a card's rank label says: "#N", "—" for elsewhere, "None" for null. */
export type PriorityRankLabel = number | typeof PRIORITY_ELSEWHERE | null;

export function sessionPriorityPlace(
  s: PriorityLinked,
  priorities: Record<string, RankedRow> | undefined,
  viewerId: string | null | undefined,
  ranks: Ranks = priorityRanks(priorities),
): PriorityStanding {
  const link = sessionPriorityOf(s);
  if (!link) return null;
  const row = priorities?.[link.priorityId];
  if (!row) return PRIORITY_ELSEWHERE;
  if (!viewerId || String(row.user_id) !== viewerId) return null;
  const rank = priorityRankOf(row, ranks);
  if (rank == null) return null;
  const step = link.stepKey ? row.steps.findIndex((st) => st.key === link.stepKey) : -1;
  return { rank, step: step < 0 ? Infinity : step };
}

export function rankLabelOf(standing: PriorityStanding): PriorityRankLabel {
  return standing === PRIORITY_ELSEWHERE ? standing : standing?.rank ?? null;
}

/** A rank label in words, as both apps' rows draw it: the text and its tooltip. */
export function rankLabelWords(rank: PriorityRankLabel): { text: string; title: string } {
  if (typeof rank === "number") return { text: `#${rank}`, title: `Your priority #${rank}` };
  return rank === PRIORITY_ELSEWHERE ? { text: "—", title: "In another workspace" } : { text: "None", title: "Serves none of your priorities" };
}

/** The standing reader the Priorities view sorts and labels by, over one state's priorities and viewer. */
export function priorityPlaceReader(
  priorities: Record<string, RankedRow> | undefined,
  viewerId: string | null | undefined,
): (s: PriorityLinked) => PriorityStanding {
  const viewer = viewerId ? String(viewerId) : null;
  const ranks = priorityRanks(priorities);
  return (s) => sessionPriorityPlace(s, priorities, viewer, ranks);
}

/** Stable: ranked rows by rank then milestone, every other row after in its given order. */
export function sortByPriority<T>(items: readonly T[], placeOf: (s: T) => PriorityStanding): T[] {
  const keyed = items.map((s, i) => {
    const p = placeOf(s);
    return { s, i, p: p === PRIORITY_ELSEWHERE ? null : p };
  });
  keyed.sort((a, b) => {
    if (a.p && b.p) return a.p.rank - b.p.rank || a.p.step - b.p.step || a.i - b.i;
    if (a.p || b.p) return a.p ? -1 : 1;
    return a.i - b.i;
  });
  return keyed.map((k) => k.s);
}

// What the order reads, as two digests for a list's wake deps: each session's
// link, and each priority's owner, what its rank is read from and its milestone keys.
export const sessionPriorityLinkSig = makeCollectionSig((s: PriorityLinked) => (s.priority_id ? `${s.priority_id}:${s.priority_step_key ?? ""}` : null));
export const priorityRanksSig = makeCollectionSig((p: RankedRow) =>
  `${p.user_id}:${p.workspace}:${p.status}:${p.person_pos ?? ""}:${p.ai_rank ?? ""}:${p.last_active_at}:${p.steps.map((st) => st.key).join(",")}`);
