import { CloudOff } from "lucide-react";
import { connectionNotice, useAppOffline } from "../hooks/useAppOffline";
import { useStatusNotice } from "../hooks/useStatusNotice";

/**
 * Status notice for a true OS offline. A dropped Convex socket does not get
 * a card — the app is already serving from IndexedDB, and the header LED
 * carries that state. Informational, not a gate.
 */
export function ConnectionBanner() {
  const state = useAppOffline();
  const notice = connectionNotice(state);
  useStatusNotice(
    "connection",
    notice
      ? {
          tone: "yellow",
          icon: CloudOff,
          title: notice.title,
          detail: notice.detail,
        }
      : null,
  );
  return null;
}
