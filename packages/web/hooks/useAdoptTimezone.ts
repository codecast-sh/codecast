import { useEffect } from "react";
import { useInboxStore } from "../store/inboxStore";

/**
 * Give a profile with no timezone the zone of the device it signs in on. A
 * team's Changes day is cut in its admins' zone and teammates' local clocks
 * read it, so an unset zone quietly meant UTC for everyone.
 */
export function useAdoptTimezone(): void {
  const missing = useInboxStore((s) => !!s.currentUser?._id && !(s.currentUser as any).timezone);
  useEffect(() => {
    if (!missing) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone) useInboxStore.getState().adoptTimezone(zone);
  }, [missing]);
}
