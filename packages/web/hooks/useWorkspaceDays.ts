// The data under "Where your messages went" (components/priorities/MessagesByWorkspace):
// each workspace the viewer belongs to with Priorities on, its typing per day
// (convex priorities.history, an enrichment read: other workspaces' typing is
// not in the store) split by where the viewer's priorities rank today (the
// store's priorityRanks, every held workspace, fed here).
import { useMemo } from "react";
import { useQueries } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import { splitDays, type WorkspaceDays } from "../lib/priorityBreakdown";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import type { PriorityRankEntry } from "../store/priorityOrder";

/**
 * Every workspace the viewer belongs to (each team, and their personal one)
 * where Priorities is on, its typing per day split by today's ranks. One
 * useQueries call holds a history read per workspace, so the set can change
 * without breaking hook order; a failed read comes back as its Error and
 * counts as no data.
 */
export function useWorkspaceDays(days: string[]): WorkspaceDays[] {
  const teams = useInboxStore((s) => s.teams);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  // Woken by a digest of what the split reads off the ranks, then read whole.
  const ranksState = useTrackedStore([(st) => ranksSig((st.priorityRanks ?? NO_ENTRIES) as Record<string, PriorityRankEntry>)]);
  const entries = (ranksState.priorityRanks ?? NO_ENTRIES) as Record<string, PriorityRankEntry>;
  const spaces = useMemo(() => {
    const all = teams ?? [];
    return [
      ...all.filter((t: { _id: string }) => workspaceFeatureEnabled(all, t._id, "priorities")).map((t: { _id: string; name: string }) => ({ workspace: `team:${t._id}`, name: t.name })),
      ...(viewerId && workspaceFeatureEnabled(all, null, "priorities") ? [{ workspace: `user:${viewerId}`, name: "Personal" }] : []),
    ];
  }, [teams, viewerId]);
  const ranks = useMemo(() => {
    const out = new Map<string, Map<string, number>>();
    for (const e of Object.values(entries)) {
      if (!e.short_id) continue;
      if (!out.has(e.workspace)) out.set(e.workspace, new Map());
      out.get(e.workspace)!.set(e.short_id, e.rank);
    }
    return out;
  }, [entries]);
  const n = days.length;
  const tz = new Date().getTimezoneOffset();
  const queries = useMemo(
    () => Object.fromEntries(spaces.map((w) => [w.workspace, { query: api.priorities.history, args: { workspace: w.workspace, days: n, tz_offset_minutes: tz } }])),
    [spaces, n, tz],
  );
  const results = useQueries(queries);
  return spaces.map((w) => {
    const value = results[w.workspace];
    const history = value === undefined || value instanceof Error ? undefined : (value as PriorityHistory);
    const split = splitDays(history, ranks.get(w.workspace) ?? NO_RANKS, days);
    return { ...w, days: split, total: split.reduce((c, d) => c + d.total, 0) };
  });
}

const NO_RANKS: ReadonlyMap<string, number> = new Map();
const NO_ENTRIES: Record<string, PriorityRankEntry> = {};
const ranksSig = makeCollectionSig((e: PriorityRankEntry) => `${e.workspace}:${e.short_id ?? ""}:${e.rank}`);
