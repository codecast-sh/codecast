import { useCallback, useEffect, useState } from "react";
import { getNotificationReadiness, isElectron, type NotificationReadiness } from "../lib/desktop";

// Live answer to "can this device show a banner right now?". There is no
// change event for OS-level consent, so this re-checks at the moments the
// answer can have flipped: window refocus (the user came back from System
// Settings or the browser's site-settings sheet), the browser Permissions API
// change event where it exists, and a slow poll while not granted (the macOS
// Allow/Don't Allow dialog is answered without the app ever losing focus).
export function useNotificationReadiness(): { readiness: NotificationReadiness; refresh: () => void } {
  const [readiness, setReadiness] = useState<NotificationReadiness>("unknown");

  const refresh = useCallback(() => {
    getNotificationReadiness().then(setReadiness);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    let unsubPermission: (() => void) | undefined;
    if (!isElectron() && typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "notifications" as PermissionName })
        .then((status) => {
          status.addEventListener("change", refresh);
          unsubPermission = () => status.removeEventListener("change", refresh);
        })
        .catch(() => {});
    }
    return () => {
      window.removeEventListener("focus", refresh);
      unsubPermission?.();
    };
  }, [refresh]);

  // The slow poll: only while something is actionable, so a granted device
  // never spends anything on this.
  useEffect(() => {
    if (readiness === "granted" || readiness === "unknown") return;
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [readiness, refresh]);

  return { readiness, refresh };
}
