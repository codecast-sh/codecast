// The inbox's priority chips and Priorities order. Every card filed under one
// of the viewer's priorities names its rank and title (priorityPlaceReader,
// rankLabelOf); the Priorities view also sorts: each status section by the viewer's
// priority a session serves, the active workspace's first (its rank, then the
// milestone's place in that priority), then other workspaces' by rank, every
// other session after, in the order it already had. A leaf (no store imports)
// so the store and the panel share it without a cycle.
import { priorityPositions, type PriorityRow } from "@codecast/shared/contracts/priorities";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { activeWorkspaceKey, workspaceDisplayName, workspaceRefOf } from "../lib/workspaceScope";
import { makeCollectionSig } from "./wakeSig";

type PriorityLinked = { priority_id?: string | null; priority_step_key?: string | null };
type RankedRow = Pick<PriorityRow, "_id" | "short_id" | "title" | "status" | "person_pos" | "ai_rank" | "last_active_at" | "user_id" | "workspace" | "steps">;
type Ranks = Map<string, number>;

/** One of the viewer's active priorities with its rank, id and title, in any workspace they hold (convex priorityRanks.mine). */
export type PriorityRankEntry = { _id: string; workspace: string; rank: number; short_id: string; title: string };

/**
 * Where a session sits in the viewer's order: the priority's rank, its
 * milestone's index, and the priority's workspace when that is not the
 * active one (null when it is); with the priority's `pri-N` and title, which
 * its chip names.
 */
export type PriorityPlace = { rank: number; step: number; workspace: string | null; shortId: string; title: string };

/** A session's place, or null: no link, or no rank of the viewer's (a teammate's priority, one not active). */
export type PriorityStanding = PriorityPlace | null;

/** What a card's priority chip shows: the rank and title, the `pri-N` it opens, and the other workspace it is in. null: no chip. */
export type PriorityRankLabel = { rank: number; workspace: string | null; shortId: string; title: string } | null;

/** What the order reads off the store. */
export type PriorityOrderState = {
  priorities?: Record<string, RankedRow>;
  priorityRanks?: Record<string, PriorityRankEntry>;
  sessions?: Record<string, PriorityLinked | undefined>;
  currentUser?: { _id?: unknown } | null;
  clientState?: { ui?: { active_team_id?: string | null } };
};

/** Whether any workspace the viewer works in has priorities on: then every card's chip is fed and read. */
export function prioritiesAnywhere(s: { teams?: readonly unknown[] | null }): boolean {
  return workspaceFeatureEnabled((s.teams ?? []) as never, null, "priorities");
}

/** The one reader of a session's priority link (the conversation's priority_id and priority_step_key). */
export function sessionPriorityOf(s: PriorityLinked): { priorityId: string; stepKey: string | null } | null {
  return s.priority_id ? { priorityId: s.priority_id, stepKey: s.priority_step_key ?? null } : null;
}

/** Every loaded priority's position among its owner's active ones (1 = first), by _id: the effective order the server's list reads too. */
export function priorityRanks(priorities: Record<string, RankedRow> | undefined): Ranks {
  return priorityPositions(Object.values(priorities ?? {}), (r) => String(r._id));
}

const stepOf = (row: RankedRow | undefined, stepKey: string | null) => {
  const at = row && stepKey ? row.steps.findIndex((st) => st.key === stepKey) : -1;
  return at < 0 ? Infinity : at;
};

/**
 * The standing reader the Priorities view sorts and labels by. The active
 * workspace's ranks are read off its `priorities` rows, so a move paints at
 * once; another workspace's off `priorityRanks`. Links are read from the
 * state's current session rows by id: a placed row can be an older copy kept
 * while nothing it draws changed.
 */
export function priorityPlaceReader(state: PriorityOrderState): (s: PriorityLinked & { _id?: string }) => PriorityStanding {
  const viewer = state.currentUser?._id ? String(state.currentUser._id) : null;
  const active = activeWorkspaceKey(state.clientState?.ui?.active_team_id, viewer);
  const ranks = priorityRanks(state.priorities);
  return (s) => {
    const link = sessionPriorityOf((s._id && state.sessions?.[s._id]) || s);
    if (!link || !viewer) return null;
    const row = state.priorities?.[link.priorityId];
    if (row && row.workspace === active) {
      const rank = String(row.user_id) === viewer ? ranks.get(String(row._id)) : undefined;
      return rank == null ? null : { rank, step: stepOf(row, link.stepKey), workspace: null, shortId: row.short_id, title: row.title };
    }
    const entry = state.priorityRanks?.[link.priorityId];
    if (!entry) return null;
    return { rank: entry.rank, step: stepOf(row, link.stepKey), workspace: entry.workspace === active ? null : entry.workspace, shortId: entry.short_id, title: entry.title };
  };
}

const labels = new Map<string, NonNullable<PriorityRankLabel>>();

/** A standing's chip label, one object per rank, workspace and priority, so a card's prop keeps its identity while its label does. */
export function rankLabelOf(standing: PriorityStanding): PriorityRankLabel {
  if (!standing) return null;
  const key = `${standing.rank}|${standing.workspace ?? ""}|${standing.shortId}|${standing.title}`;
  let label = labels.get(key);
  if (!label) labels.set(key, (label = { rank: standing.rank, workspace: standing.workspace, shortId: standing.shortId, title: standing.title }));
  return label;
}

/** The workspace a rank from outside the active one carries on its chip: a team's icon, colour and name, or the viewer's personal workspace. */
export type WorkspaceMark = { personal: true; name: string } | { personal: false; name: string; icon: string | null; color: string | null };

export function workspaceMarkOf(
  workspace: string,
  teams: ReadonlyArray<{ _id?: string; name?: string; icon?: string | null; icon_color?: string | null }> | null | undefined,
  viewerId: string | null | undefined,
): WorkspaceMark | null {
  const ref = workspaceRefOf({ workspace });
  if (!ref) return null;
  const name = workspaceDisplayName(ref, teams, viewerId);
  if (ref.kind !== "team") return { personal: true, name };
  const team = (teams ?? []).find((t) => t?._id === ref.id);
  return { personal: false, name, icon: team?.icon ?? null, color: team?.icon_color ?? null };
}

/** The chip's accessible name. */
export function rankTitle(label: NonNullable<PriorityRankLabel>, mark: WorkspaceMark | null): string {
  return `Your priority #${label.rank}${label.title ? `: ${label.title}` : ""}${mark ? ` in ${mark.name}` : ""}`;
}

/** Stable: the active workspace's ranked rows by rank then milestone, then other workspaces' by rank, every other row after in its given order. */
export function sortByPriority<T>(items: readonly T[], placeOf: (s: T) => PriorityStanding): T[] {
  const tier = (p: PriorityStanding) => (!p ? 2 : p.workspace ? 1 : 0);
  const keyed = items.map((s, i) => ({ s, i, p: placeOf(s) }));
  keyed.sort((a, b) =>
    tier(a.p) - tier(b.p)
    || (a.p && b.p ? a.p.rank - b.p.rank || a.p.step - b.p.step : 0)
    || a.i - b.i);
  return keyed.map((k) => k.s);
}

/**
 * The decision queue in the inbox's Priorities view: each session's asks stay
 * together and in their order, the sessions sorted by the rank of the
 * viewer's priority they serve as the inbox sorts them (sortByPriority), the
 * rest after in queue order. The one order the panel numbers and the stepper
 * walks (hooks/useDecisionQueue).
 */
export function sortQueueByPriority<T extends { conversationId: string }>(items: readonly T[], placeOf: (conversationId: string) => PriorityStanding): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const g = groups.get(item.conversationId);
    if (g) g.push(item);
    else groups.set(item.conversationId, [item]);
  }
  return sortByPriority([...groups], ([id]) => placeOf(id)).flatMap(([, asks]) => asks);
}

/**
 * Ctrl+I's pick from one walk (walkOrder). Every view takes its first row. The
 * Priorities view walks on: the first row after the open session, wrapping,
 * and never the open session itself (so a walk holding only it falls through
 * to the next one).
 */
export function walkPick<T extends { _id: string }>(order: readonly T[], currentId: string | null | undefined, walkOn: boolean): T | undefined {
  if (!walkOn || !currentId) return order[0];
  const at = order.findIndex((s) => s._id === currentId);
  const pick = at === -1 ? order[0] : order[(at + 1) % order.length];
  return pick?._id === currentId ? undefined : pick;
}

// What the order reads, as digests for a list's wake deps: each session's
// link; each loaded priority's owner, what its rank is read from, its
// milestone keys and what its chip names; each ranked entry; the viewer and
// active workspace.
const EMPTY = {};
const sessionPriorityLinkSig = makeCollectionSig((s: PriorityLinked) => (s.priority_id ? `${s.priority_id}:${s.priority_step_key ?? ""}` : null));
const priorityRowsSig = makeCollectionSig((p: RankedRow) =>
  `${p.user_id}:${p.workspace}:${p.status}:${p.person_pos ?? ""}:${p.ai_rank ?? ""}:${p.last_active_at}:${p.steps.map((st) => st.key).join(",")}:${p.short_id}:${p.title}`);
const priorityRankEntriesSig = makeCollectionSig((e: PriorityRankEntry) => `${e.workspace}:${e.rank}:${e.short_id}:${e.title}`);

export function priorityOrderSig(s: PriorityOrderState): string {
  return [
    sessionPriorityLinkSig((s.sessions ?? EMPTY) as Record<string, PriorityLinked>),
    priorityRowsSig(s.priorities ?? EMPTY),
    priorityRankEntriesSig(s.priorityRanks ?? EMPTY),
    String(s.currentUser?._id ?? ""),
    s.clientState?.ui?.active_team_id ?? "",
  ].join("|");
}
