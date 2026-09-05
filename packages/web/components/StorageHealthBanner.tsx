import { HardDrive } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useStatusNotice } from "../hooks/useStatusNotice";

/**
 * Status notice shown while durable IndexedDB writes are not landing (the
 * middleware's enqueue watchdog, or a schema upgrade blocked by another
 * window). Delivery is unaffected — sends go straight to the server — but
 * crash recovery and offline cache are degraded until storage recovers. The
 * blocked case names the fix because it is the one the user can apply; a
 * plain stall only says what still works. Clears as soon as the store
 * reports storage healthy again.
 */
export function StorageHealthBanner() {
  const degraded = useInboxStore((s) => s.storageDegraded);
  useStatusNotice(
    "storage-health",
    degraded
      ? {
          tone: "orange",
          icon: HardDrive,
          title: degraded === "blocked" ? "Another Codecast window is blocking a storage update" : "Local storage is not keeping up",
          detail:
            degraded === "blocked"
              ? "close or reload your other Codecast windows. Messages still send meanwhile."
              : "messages still send, but offline cache and crash recovery are degraded until local saving recovers.",
        }
      : null,
  );
  return null;
}
