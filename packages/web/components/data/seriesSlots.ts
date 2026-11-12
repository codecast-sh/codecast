import type { ArtifactElement } from "@codecast/shared/artifacts";
import { resultFor, type DataResult } from "../../hooks/useDashboardData";

/**
 * One color slot per split value across the whole dashboard, sorted by name,
 * so a person keeps one color in every chart whatever loads first. Value columns ("opened", "merged")
 * are not people; they keep the palette's order.
 */
export function seriesSlots(blocks: readonly ArtifactElement[], results: Map<string, DataResult>): (name: string) => number | undefined {
  // Sorted by name, so a person's color never depends on which query answered first.
  const names = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== "chart" || typeof b.series !== "string") continue;
    const r = resultFor(results, b);
    const i = r ? r.columns.indexOf(b.series) : -1;
    if (r && i >= 0) for (const row of r.rows) if (row[i] !== null && row[i] !== undefined) names.add(String(row[i]));
  }
  const slots = new Map([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((n, i) => [n, i]));
  return (name) => slots.get(name);
}
