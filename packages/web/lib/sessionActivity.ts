// The activity line on a session row ("editing chat.ts"), as every client
// surface reads it: the inbox card, the composer's working line, the mobile
// row. One rule, from the shared contract: the row must be working and the
// stamp must be fresh (isSessionActivityFresh). Presence is derived from real
// activity, and a stale stamp hides rather than shows as current.
import { isSessionActivityFresh, type SessionActivity } from "@codecast/shared/contracts";
import { classifySession, type InboxSession } from "../store/inboxStore";

/**
 * The activity a row shows right now, or null.
 *
 * `session` supplies the work state (the same classifier the inbox buckets
 * with: a row is working exactly when its verdict is not idle); `activity` is
 * read separately because the card holds a session prop that lags the store
 * on churn fields, so the caller hands in the live field it subscribed to.
 */
export function liveActivityOf(
  session: InboxSession | null | undefined,
  activity: SessionActivity | null | undefined,
  now: number,
): SessionActivity | null {
  if (!session) return null;
  const workState = classifySession(session).idle ? null : "working";
  return isSessionActivityFresh(activity, workState, now) ? activity : null;
}

/**
 * Wake signature for one row's activity field. Every liveness push hands back
 * a new activity object, so a subscription on the object would re-render on
 * every heartbeat; the text and the stamp together are what the line draws.
 */
export function activitySig(activity: SessionActivity | null | undefined): string {
  return activity ? `${activity.at}:${activity.text}` : "";
}
