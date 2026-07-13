import { CloudOff } from "lucide-react";
import { useAppOffline } from "../hooks/useAppOffline";

/**
 * Slim strip shown while the app is running from the local cache: the OS
 * reports no network, or the Convex WebSocket has been down long enough to
 * matter. Renders in the DashboardLayout banner stack. Local-first boot means
 * everything below it keeps working from IndexedDB — this is informational,
 * not a gate.
 */
export function ConnectionBanner() {
  const { offline, online } = useAppOffline();
  if (!offline) return null;

  return (
    <div className="bg-gradient-to-r from-sol-yellow/10 via-sol-yellow/5 to-sol-yellow/10 border-b border-sol-yellow/30">
      <div className="px-4 py-1.5 flex items-center gap-3">
        <CloudOff className="w-4 h-4 text-sol-yellow flex-shrink-0" />
        <span className="text-sm text-sol-text truncate">
          {online ? "Reconnecting…" : "Offline"}
          <span className="text-sol-text-dim"> — showing locally cached data; changes will sync when the connection returns.</span>
        </span>
      </div>
    </div>
  );
}
