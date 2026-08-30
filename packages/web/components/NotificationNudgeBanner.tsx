import { useEffect, useState } from "react";
import { BellOff, BellRing, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { useOsPermission } from "../hooks/useOsPermissions";
import { isElectron } from "../lib/desktop";
import { permissionActionLabel, permissionHint, requestOsPermission } from "../lib/osPermissions";
import {
  decideNotificationNudge,
  getLastNotificationMiss,
  onNotificationMiss,
  type NotificationMiss,
} from "../lib/notificationNudge";

// The pushy "turn on desktop notifications" strip. Sits with the other
// dashboard banners; policy (when to show, when a dismiss holds, when a missed
// message overrides it) lives in lib/notificationNudge so it's unit-testable.
export function NotificationNudgeBanner() {
  const snoozedAt = useInboxStore((s) => s.clientState.dismissed?.notif_nudge ?? 0);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const [miss, setMiss] = useState<NotificationMiss | null>(null);
  // After "Turn on": the OS is showing its own prompt somewhere else on screen —
  // point at it, because the banner's button appearing to do nothing reads as
  // broken.
  const [awaitingPrompt, setAwaitingPrompt] = useState(false);
  const { readiness, refresh } = useOsPermission("notifications");

  useMountEffect(() => {
    setMounted(true);
    setMiss(getLastNotificationMiss());
    return onNotificationMiss(() => setMiss(getLastNotificationMiss()));
  });

  // The prompt hint outlives its usefulness once consent lands either way.
  useEffect(() => {
    if (readiness !== "ask") setAwaitingPrompt(false);
  }, [readiness]);

  if (!mounted) return null;
  const verdict = decideNotificationNudge({ readiness, snoozedAt, miss, now: Date.now() });
  if (!verdict.show) return null;

  const escalated = verdict.escalated;
  const action = permissionActionLabel(readiness);

  const message = escalated
    ? verdict.miss.fromPerson
      ? `${verdict.miss.actor ?? "Someone"} messaged you — Codecast couldn't show a notification.`
      : "Codecast had news for you but couldn't show a notification."
    : "Desktop notifications are off — messages from your team arrive silently.";

  const handleEnable = async () => {
    const result = await requestOsPermission("notifications", readiness);
    if (result === "requested" && readiness === "ask") setAwaitingPrompt(true);
    // "granted" / "opened-settings": the refresh (and the store's refocus +
    // poll) pulls the banner down as soon as consent actually lands.
    refresh();
  };

  const Icon = escalated ? BellRing : BellOff;
  const wrap = escalated
    ? "bg-gradient-to-r from-sol-magenta/10 via-sol-magenta/5 to-sol-magenta/10 border-b border-sol-magenta/40"
    : "bg-gradient-to-r from-sol-blue/10 via-sol-blue/5 to-sol-blue/10 border-b border-sol-blue/30";
  const iconColor = escalated ? "text-sol-magenta" : "text-sol-blue";

  return (
    <div className={wrap}>
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Icon className={`w-4 h-4 ${iconColor} flex-shrink-0`} />
          <span className="text-sm text-sol-text truncate">
            {message}{" "}
            {awaitingPrompt ? (
              <span className="text-sol-text-muted">
                {isElectron() ? "Answer the macOS Allow prompt to finish." : "Answer the browser's permission prompt to finish."}
              </span>
            ) : !action ? (
              <span className="text-sol-text-muted">{permissionHint("notifications", readiness)}</span>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {action && !awaitingPrompt && (
            <button
              onClick={handleEnable}
              className="px-2.5 py-1 text-xs font-medium rounded-md bg-sol-blue text-sol-bg hover:opacity-90 transition-opacity"
            >
              {readiness === "off" ? action : "Turn on notifications"}
            </button>
          )}
          <button
            onClick={() => updateDismissed("notif_nudge", Date.now())}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
