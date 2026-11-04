// A metric alert told one way everywhere: its episodes (announced crossing to
// announced recovery), never its polls. The watch page's stat strip, its
// issue card, the issue page's header and its metric card all read this.
import { useMemo } from "react";
import { useOpsEvents } from "../../hooks/useSyncOps";
import { alertEpisodes, currentEpisodeSince, episodeSummary, type Episode, type TransitionRow } from "./metricModel";
import { regressedAt } from "./issuesModel";
import type { OpsEvent, OpsGroup, OpsWatch } from "./opsTypes";

/** The transitions the monitor announced on a group, oldest first. */
export function announcedTransitions(events: readonly OpsEvent[], group: Pick<OpsGroup, "_id" | "short_id"> | null | undefined): TransitionRow[] {
  if (!group) return [];
  return events
    .filter((e) => (e.group_id === group._id || e.data?.group_short_id === group.short_id) && (e.kind === "metric_alert" || e.kind === "metric_recovered"))
    .map((e): TransitionRow => ({ at: e.created_at, kind: e.kind === "metric_alert" ? "crossed" : "recovered", value: typeof e.data?.value === "number" ? e.data.value : null }))
    .sort((a, b) => a.at - b.at);
}

/** A watch's announced transitions and the episodes they make, from the store. */
export function useWatchEpisodes(watch: Pick<OpsWatch, "state" | "threshold" | "points" | "direction"> | null | undefined, group: OpsGroup | null | undefined): { announced: TransitionRow[]; episodes: Episode[]; since: number | null } {
  const events = useOpsEvents();
  return useMemo(() => {
    const announced = announcedTransitions(events, group);
    const since = watch ? currentEpisodeSince(watch, group) : null;
    return { announced, episodes: alertEpisodes(announced, since), since };
  }, [events, group, watch]);
}

/**
 * A metric issue's alert counted the one way the watch page counts it:
 * episodes, and the time they ran. Never polls. The running episode starts
 * no earlier than the issue's own regression, the moment its pill and
 * banner name, so "this one" agrees with them.
 */
export function useIssueEpisodes(group: OpsGroup, watch: OpsWatch | null | undefined, now: number) {
  const { episodes, since } = useWatchEpisodes(watch, group);
  const sum = episodeSummary(episodes, { from: 0, to: now }, now);
  const back = regressedAt(group);
  return { ...sum, current: sum.current !== null && back !== null ? Math.max(sum.current, back) : sum.current, since };
}
