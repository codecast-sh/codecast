import { useState, type RefCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { attachTitlebarHead, isElectron } from "../lib/desktop";
import { useWatchEffect } from "./useWatchEffect";

/**
 * Marks a surface's top row as the window titlebar while zen mode hides the
 * global header on the desktop app: the row becomes the drag region and, at the
 * window's left edge, indents past the macOS traffic lights (lib/desktop
 * attachTitlebarHead). Outside zen / outside Electron it is inert. Attach the
 * returned ref to the topmost row of the page or panel — specifically the
 * element that PAINTS that row's background and border, so the traffic-light
 * inset padding shares its surface instead of exposing a parent's.
 */
export function useTitlebarHead<T extends HTMLElement = HTMLElement>(): RefCallback<T> {
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const [el, setEl] = useState<T | null>(null);
  useWatchEffect(() => {
    if (!el || !zen || !isElectron()) return;
    return attachTitlebarHead(el);
  }, [el, zen]);
  return setEl;
}
