// Policy for the "turn on desktop notifications" nudge.
//
// The nudge is deliberately pushy: notifications off means messages from real
// people silently vanish, which is the worst failure mode a team app has. So a
// dismiss only snoozes it, and a person messaging you while banners can't show
// cancels the snooze on the spot — that miss is exactly the cost the nudge
// exists to prevent, and the moment it happens is the moment the case for
// enabling is strongest.

import type { PermissionReadiness } from "./osPermissions";

export const NUDGE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

export type NotificationMiss = {
  at: number;
  // The name to put in the banner ("Samvit messaged you"), when the
  // notification carried one.
  actor?: string;
  // A human wrote this (chat message / mention) — the strongest copy. Agent
  // and work-item notifications escalate too, but with generic wording.
  fromPerson: boolean;
};

export type NudgeVerdict =
  | { show: false }
  | { show: true; escalated: false }
  | { show: true; escalated: true; miss: NotificationMiss };

export function decideNotificationNudge(args: {
  readiness: PermissionReadiness;
  snoozedAt: number; // 0 = never dismissed
  miss: NotificationMiss | null;
  now: number;
}): NudgeVerdict {
  const { readiness, snoozedAt, miss, now } = args;
  if (readiness !== "ask" && readiness !== "off") return { show: false };
  // A miss AFTER the last dismiss re-surfaces the banner no matter how fresh
  // the snooze is; dismissing again waits for the next miss (or expiry).
  if (miss && miss.at > snoozedAt) return { show: true, escalated: true, miss };
  if (snoozedAt > 0 && now - snoozedAt < NUDGE_SNOOZE_MS) return { show: false };
  return { show: true, escalated: false };
}

// ---------------------------------------------------------------------------
// Miss registry. DesktopProvider (the component that watches the notification
// feed) records each notification that arrived while banners couldn't show;
// the nudge banner subscribes. Module-level so a banner mounting after the
// miss still sees it — ephemeral by design: a miss is a live "this just
// happened" signal, not state worth persisting.
// ---------------------------------------------------------------------------

const MISS_EVENT = "codecast-notification-miss";
let lastMiss: NotificationMiss | null = null;

export function recordNotificationMiss(miss: Omit<NotificationMiss, "at">): void {
  // A person messaging never gets downgraded by a later work-item miss; the
  // reverse upgrade is fine.
  if (lastMiss && lastMiss.fromPerson && !miss.fromPerson) {
    lastMiss = { ...lastMiss, at: Date.now() };
  } else {
    lastMiss = { ...miss, at: Date.now() };
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MISS_EVENT));
}

export function getLastNotificationMiss(): NotificationMiss | null {
  return lastMiss;
}

export function onNotificationMiss(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MISS_EVENT, cb);
  return () => window.removeEventListener(MISS_EVENT, cb);
}
