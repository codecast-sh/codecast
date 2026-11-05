// One count per set of recordings, read from one home. Every surface that
// says how many recordings a source, the workspace or an issue has asks the
// same browse the Replays list runs for it (convex replays.browse, the list's
// first page with its default filter), so the count is that browse's tally in
// the store (opsReplayTallies) and the subscription is shared with the list
// when it is open. A count that stopped at the browse's scan is a floor, and
// every surface marks it with the same "+".
import { useMemo } from "react";
import { REPLAY_DEFAULT_MATCH, replayMatches, resolveReplayFilter } from "@codecast/shared/replay";
import { useOpsReplays, useOpsReplayTally, useSyncOpsReplayBrowse } from "../../hooks/useSyncOps";
import { REPLAY_PAGE, floorShown } from "./replayModel";

/** provisional: the server has not counted yet, so this is the cached rows that match, a floor every surface marks the same way. */
export type ReplayTotal = { total: number; capped: boolean; provisional?: boolean };

/** The number a count shows: a floor of 100 or more rounds down to the hundred, as the Replays tab badge does, so it stops flipping between 1,501+ and 1,500+ and every surface shows the same floor. */
export const replayCountShown = (t: ReplayTotal) => (t.capped ? floorShown(t.total) : t.total);

/** A count as every surface writes it: "1,400+" when it is a floor. */
export const replayTotalText = (t: ReplayTotal) => `${replayCountShown(t).toLocaleString()}${t.capped && t.total > 0 ? "+" : ""}`;

function useBrowseTotal(source: string | null, match: ReturnType<typeof resolveReplayFilter>, on: boolean): ReplayTotal | null {
  const browse = useMemo(() => (on ? { source, match, sort: "newest" as const, limit: REPLAY_PAGE } : null), [on, source, match]);
  const { key } = useSyncOpsReplayBrowse(browse);
  const tally = useOpsReplayTally(key);
  // Before the count lands, the cached rows the same filter admits stand in, as a floor: the list does the same, so the badge and the list read one number.
  const rows = useOpsReplays();
  const local = useMemo(() => (tally || !on ? 0 : rows.filter((r) => (!source || r.source_name === source) && replayMatches(r, match)).length), [tally, on, rows, source, match]);
  if (tally) return { total: tally.total, capped: !!tally.capped };
  return on ? { total: local, capped: true, provisional: true } : null;
}

/** The recordings of a source (or, with null, the workspace) under the list's default filter: the Replays tab badge and the source lists. */
export function useReplayTotal(source: string | null, on = true): ReplayTotal | null {
  return useBrowseTotal(source, REPLAY_DEFAULT_MATCH, on);
}

/** The recordings that caught an issue, the same the list shows under ?issue=: the issue page's Replays card. */
export function useIssueReplayTotal(groupId: string | null): ReplayTotal | null {
  const match = useMemo(() => resolveReplayFilter({ group_id: groupId ?? undefined }, 0), [groupId]);
  return useBrowseTotal(null, match, !!groupId);
}
