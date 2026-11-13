// Esc closes the item open in a list split (both split styles share this).
// Never from an editable (editors own Esc), never under a modal or the
// shortcuts panel, and never when the open item owns its keys
// (`data-detail-owns-keys`: an artifact, where Esc dismisses what is open inside it).
import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { hasOpenModal } from "../shortcuts/registry";
import { keyBelongsElsewhere } from "../shortcuts/keyOwnership";
import { useWatchEffect } from "./useWatchEffect";

/** Returns the ref for the detail's container. */
export function useDetailEscClose(active: boolean, close: () => void) {
  const detailRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || hasOpenModal()) return;
      if (useInboxStore.getState().shortcutsPanelOpen) return;
      if (keyBelongsElsewhere(e.target)) return;
      if (detailRef.current?.querySelector("[data-detail-owns-keys]")) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, close]);
  return detailRef;
}
