import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import {
  summarizeShareImpact,
  type PathShareSummary,
  type ProjectCounts,
  type ShareImpact,
} from "../lib/team/shareImpact";

// The server counts at most this many directories per call; the rest read
// their row's own window count until the selection shrinks.
const MAX_EXACT = 12;

/**
 * The numbers behind a share control: the exact session count and start span
 * of every selected directory, folded into one total. `since` is the share
 * start under review: a number counts the sessions before it as older, null
 * reviews "everything" (no older sessions), and leaving it out reads each
 * directory's own mapping, which is what a settings row wants. A one shot
 * preview read (not a registered feed); it fails soft to the rows' own
 * counts, so the band always has something honest to say.
 */
export function useShareImpact(
  selectedPaths: string[],
  rows: ProjectCounts[] | undefined,
  since?: number | null,
): ShareImpact {
  const key = selectedPaths.join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => [...selectedPaths].sort().slice(0, MAX_EXACT), [key]);
  const sinceArg = since === undefined ? undefined : since ?? 0;
  const { data } = useQueryNoThrow(
    api.users.shareImpactForPaths,
    stable.length > 0 ? { path_prefixes: stable, since: sinceArg } : "skip",
  );
  return useMemo(
    () => summarizeShareImpact(selectedPaths, data as Record<string, PathShareSummary> | undefined, rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, data, rows],
  );
}
