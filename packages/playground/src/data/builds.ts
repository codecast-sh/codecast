// A build card's live narration, read apart from the stream (convex/builds.ts)
// so only the parts showing it wake while Clay works.
import { api } from "../../convex/_generated/api";
import type { BuildProgress } from "../../convex/builds";
import type { Id } from "../../convex/_generated/dataModel";
import { useVisitorQuery } from "../lib/identity";

const NONE: BuildProgress = { narration: [], files_touched: [] };

export function useBuildProgress(buildId: Id<"builds"> | null | undefined): BuildProgress {
  return useVisitorQuery(api.builds.progress, buildId ? { build_id: buildId } : "skip") ?? NONE;
}
