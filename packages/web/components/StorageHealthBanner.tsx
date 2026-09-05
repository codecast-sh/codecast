import { HardDrive } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useStatusToast } from "../hooks/useStatusToast";

/**
 * Floating notice shown while durable IndexedDB writes are not landing (the
 * middleware's enqueue watchdog, or a schema upgrade blocked by another
 * window). Delivery is unaffected — sends go straight to the server — but
 * crash recovery and offline cache are degraded until storage recovers. The
 * blocked case names the fix because it is the one the user can apply;
 * a plain stall only says what still works. Clears itself as soon as the
 * store reports storage healthy again.
 */
export function StorageHealthBanner() {
  const degraded = useInboxStore((s) => s.storageDegraded);
  useStatusToast(
    "storage-health",
    degraded ? (
      <div className="bg-gradient-to-r from-sol-orange/10 via-sol-orange/5 to-sol-orange/10 border border-sol-orange/30 rounded-lg">
        <div className="px-4 py-2 flex items-start gap-3">
          <HardDrive className="w-4 h-4 mt-0.5 text-sol-orange flex-shrink-0" />
          <span className="text-sm text-sol-text leading-snug">
            {degraded === "blocked" ? (
              <>
                Another Codecast window is blocking a storage update
                <span className="text-sol-text-dim"> — close or reload your other Codecast windows. Messages still send meanwhile.</span>
              </>
            ) : (
              <>
                Local storage is not keeping up
                <span className="text-sol-text-dim"> — messages still send, but offline cache and crash recovery are degraded until local saving recovers.</span>
              </>
            )}
          </span>
        </div>
      </div>
    ) : null,
  );
  return null;
}
