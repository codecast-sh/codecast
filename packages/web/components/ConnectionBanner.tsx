import { CloudOff } from "lucide-react";
import { useAppOffline } from "../hooks/useAppOffline";
import { useStatusToast } from "../hooks/useStatusToast";

/**
 * Floating notice shown while the app is running from the local cache: the OS
 * reports no network, or the Convex WebSocket has been down long enough to
 * matter. Local-first boot means everything keeps working from IndexedDB —
 * this is informational, not a gate — so it floats over the page instead of
 * pushing the layout down.
 */
export function ConnectionBanner() {
  const { offline, online } = useAppOffline();
  useStatusToast(
    "connection",
    offline ? (
      <div className="bg-gradient-to-r from-sol-yellow/10 via-sol-yellow/5 to-sol-yellow/10 border border-sol-yellow/30 rounded-lg">
        <div className="px-4 py-2 flex items-start gap-3">
          <CloudOff className="w-4 h-4 mt-0.5 text-sol-yellow flex-shrink-0" />
          <span className="text-sm text-sol-text leading-snug">
            {online ? "Reconnecting…" : "Offline"}
            <span className="text-sol-text-dim"> — showing locally cached data; changes will sync when the connection returns.</span>
          </span>
        </div>
      </div>
    ) : null,
  );
  return null;
}
