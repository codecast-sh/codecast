import { useState, type RefCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { attachTitlebarHead, zenCornerWidth } from "../lib/desktop";
import { useWatchEffect } from "./useWatchEffect";

/**
 * Marks a surface's top row as the window titlebar while zen mode hides the
 * global header: the row becomes the drag region (desktop app) and, at the
 * window's left edge, indents past the zen corner, which holds the traffic
 * lights on the desktop (lib/desktop attachTitlebarHead, zenCornerWidth).
 * Outside zen it is inert. Attach the
 * returned ref to the topmost row of the page or panel — specifically the
 * element that PAINTS that row's background and border, so the traffic-light
 * inset padding shares its surface instead of exposing a parent's.
 */
export function useTitlebarHead<T extends HTMLElement = HTMLElement>(): RefCallback<T> {
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const [el, setEl] = useState<T | null>(null);
  useWatchEffect(() => {
    if (!el || !zen) return;
    return attachTitlebarHead(el, zenCornerWidth());
  }, [el, zen]);
  return setEl;
}
