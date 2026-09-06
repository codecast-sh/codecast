import { CloudOff } from "lucide-react";
import { useAppOffline } from "../hooks/useAppOffline";
import { useStatusNotice } from "../hooks/useStatusNotice";

/**
 * Status notice shown while the app is running from the local cache: the OS
 * reports no network, or the Convex WebSocket has been down long enough to
 * matter. Local-first boot means everything keeps working from IndexedDB —
 * this is informational, not a gate.
 */
export function ConnectionBanner() {
  const { offline, online } = useAppOffline();
  useStatusNotice(
    "connection",
    offline
      ? {
          tone: "yellow",
          icon: CloudOff,
          title: online ? "Reconnecting…" : "Offline",
          detail: "showing locally cached data; changes will sync when the connection returns.",
        }
      : null,
  );
  return null;
}
