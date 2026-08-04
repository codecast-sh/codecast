import { HardDrive } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";

/**
 * Slim strip shown while IndexedDB writes are timing out (the middleware's
 * enqueue watchdog). Delivery is unaffected — sends go straight to the server
 * — but crash recovery and offline cache are degraded until storage recovers.
 * Renders in the DashboardLayout banner stack; clears itself when a durable
 * write commits promptly again.
 */
export function StorageHealthBanner() {
  const degraded = useInboxStore((s) => s.storageDegraded);
  if (!degraded) return null;

  return (
    <div className="bg-gradient-to-r from-sol-orange/10 via-sol-orange/5 to-sol-orange/10 border-b border-sol-orange/30">
      <div className="px-4 py-1.5 flex items-center gap-3">
        <HardDrive className="w-4 h-4 text-sol-orange flex-shrink-0" />
        <span className="text-sm text-sol-text truncate">
          Local storage is not keeping up
          <span className="text-sol-text-dim"> — messages still send, but offline cache and crash recovery are degraded. Reloading this window usually clears it.</span>
        </span>
      </div>
    </div>
  );
}
