// The session row's activity stamp ("editing chat.ts") as the composer's
// working line reads it. The show rule lives in the shared contract
// (isSessionActivityFresh): the row must be working and the stamp fresh, so a
// stale stamp hides rather than shows as current.
import type { SessionActivity } from "@codecast/shared/contracts";

/**
 * Wake signature for one row's activity field. Every liveness push hands back
 * a new activity object, so a subscription on the object would re-render on
 * every heartbeat; the text and the stamp together are what the line draws.
 */
export function activitySig(activity: SessionActivity | null | undefined): string {
  return activity ? `${activity.at}:${activity.text}` : "";
}
