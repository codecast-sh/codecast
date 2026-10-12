// Whether your changes can build in an app right now: a read of its own, so
// only what offers a change (the composer, a failed card's Try again) wakes
// when building pauses or a budget runs out.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useVisitorQuery } from "../lib/identity";

/** Why changes cannot build here now, in one line for people, or null. */
export function useBuildsPaused(appId: Id<"apps">): string | null {
  return useVisitorQuery(api.apps.buildsPaused, { app_id: appId }) ?? null;
}
